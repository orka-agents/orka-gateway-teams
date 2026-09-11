// Explicit Kubernetes acceptance: run ONLY through the documented kindctl exec.
// Imported helper tests remain offline; the CLI fails rather than skipping prerequisites.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DeliveryRequest } from '../../src/protocol/types.js';

interface ContainerStatus { name: string; state: { terminated?: { exitCode: number }; running?: object; waiting?: object } }
export interface OwnedPod {
  metadata: { uid?: string };
  spec: { containers: { name: string }[]; initContainers?: { name: string }[]; restartPolicy?: string };
  status: { phase?: string; containerStatuses?: ContainerStatus[]; initContainerStatuses?: ContainerStatus[] };
}
export interface OwnershipSnapshot { namespaceUID: string; owner: string; controllers: { replicas?: number }[]; pods: OwnedPod[] }
export async function withStoppedOwners(namespaceUID: string, owner: string,
  inspect: () => Promise<OwnershipSnapshot>, mutate: () => Promise<void>): Promise<void> {
  const snapshot = await inspect();
  assert.equal(snapshot.namespaceUID === namespaceUID && snapshot.owner === owner, true);
  assert.equal(snapshot.controllers.every((controller) => controller.replicas === 0), true);
  for (const pod of snapshot.pods) {
    assert.equal(Boolean(pod.metadata.uid) && ['Succeeded', 'Failed'].includes(pod.status.phase ?? ''), true);
    assert.equal(pod.spec.restartPolicy !== 'Always', true);
    for (const [containers, statuses] of [[pod.spec.containers, pod.status.containerStatuses],
      [pod.spec.initContainers ?? [], pod.status.initContainerStatuses]] as const) {
      for (const container of containers) {
        const state = statuses?.find((status) => status.name === container.name)?.state;
        assert.equal(state?.terminated !== undefined && state.running === undefined && state.waiting === undefined, true);
      }
    }
  }
  await mutate();
}

// Documents are parsed and schema-validated by kubectl, not a new YAML parser.
// Dynamic Kubernetes fields are confined to this opt-in fixture, never runtime code.
type Resource = Record<string, any>;
interface Result { code: number; stdout: string; stderr: string }
interface Settings { env: Record<string, string>; delivery: DeliveryRequest; receipt: string }
const image = 'orka-gateway-teams:local';
const nginxImage = 'nginxinc/nginx-unprivileged:stable-alpine@sha256:442753882674b49ae2c1de83ed67896131c0777f56df5005e356e62bc3f7e7ce';
const wrapper = '/home/tng/workspace/orka/.agents/skills/kindctl/bin/kindctl';
const ownerLabel = 'teams.orka.ai/deployment-smoke';
let stage = 'preflight';
let privateValues: string[] = [];
function safeOutput(text: string): void { assert.equal(privateValues.some((value) => text.includes(value)), false); }
function command(binary: string, args: string[], input?: string, timeout = 60000): Promise<Result> {
  return new Promise((resolve) => {
    const child = execFile(binary, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout, stderr });
    });
    child.stdin?.end(input);
  });
}
function ok(result: Result): string { assert.equal(result.code, 0); return result.stdout.trim(); }
function items(text: string): Resource[] { return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Resource); }
function hasKey(value: unknown, key: string): boolean {
  return value !== null && typeof value === 'object' && (Object.hasOwn(value, key) || Object.values(value).some((child) => hasKey(child, key)));
}

// File-based helpers run in synthetic Pods using the actual image, outside /app.
// Filesystem mutations occur only in separate Never-restarting maintenance Pods
// after the host independently proves every previous owner has terminated.
async function fixture(mode: string): Promise<void> {
  assert.equal(process.getuid?.(), 1000); assert.equal(process.getgid?.(), 1000);
  const directory = lstatSync('/data'); assert.equal(directory.uid, 1000); assert.equal(directory.gid, 1000);
  assert.equal(directory.mode & 0o777, 0o700);
  if (mode === 'fixture-hold') { renameSync('/data/delivery.sqlite.owner.sqlite', '/data/owner.held'); return; }
  if (mode === 'fixture-restore') { renameSync('/data/owner.held', '/data/delivery.sqlite.owner.sqlite'); return; }
  for (const path of ['/data/ingress.sqlite', '/data/delivery.sqlite', '/data/delivery.sqlite.owner.sqlite']) {
    const stat = lstatSync(path); assert.equal(stat.isFile(), true); assert.equal(stat.uid, 1000); assert.equal(stat.gid, 1000);
    assert.equal(stat.mode & 0o777, 0o600);
  }
  let readOnly = false;
  try { writeFileSync('/app/must-not-write', 'x'); } catch { readOnly = true; }
  assert.equal(readOnly, true); writeFileSync('/tmp/writable', 'x');
  if (mode === 'fixture-inspect') return; // Metadata only; never open a live SQLite inode.
  assert.equal(mode, 'fixture-seed');
  const settings = JSON.parse(readFileSync('/fixture-private/settings.json', 'utf8')) as Settings;
  const modulePath = '/app/dist/delivery/journal.js';
  const { openDeliveryJournal } = await import(modulePath) as typeof import('../../src/delivery/journal.js');
  const journal = openDeliveryJournal('/data/delivery.sqlite', { appId: settings.env.TEAMS_APP_ID!, tenantId: settings.env.TEAMS_TENANT_ID! });
  try {
    const begun = journal.begin(settings.delivery); assert.equal(begun.kind, 'claimed');
    if (begun.kind === 'claimed') assert.equal(journal.settle(begun.claim, { kind: 'delivered', providerMessageId: settings.receipt }), 'recorded');
  } finally { journal.close(); }
}

async function smoke(): Promise<void> {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  assert.equal(process.cwd(), root.replace(/\/$/u, ''));
  for (const path of ['deploy/kustomization.yaml', 'deploy/runtime/kustomization.yaml', 'deploy/storage/pvc.yaml',
    'deploy/storage/prepare-job.yaml', 'deploy/storage/init-job.yaml', 'deploy/orka/gatewayclass.yaml',
    'deploy/orka/gateway.yaml', 'deploy/orka/gatewaybinding.yaml']) {
    stage = `missing packaging artifact: ${path}`; assert.equal(existsSync(path), true);
  }
  stage = 'requires Node 24.2.0 and kindctl exec --tag deployment with scoped kubeconfig';
  assert.equal(process.version, 'v24.2.0');
  assert.equal(process.env.KUBECONFIG === ok(await command(wrapper, ['path', '--tag', 'deployment'])), true);
  const kubectl = async (args: string[], input?: string, timeout?: number) => {
    const result = await command('kubectl', args, input, timeout);
    // JSON Secret create responses stay private. Callers never print child output.
    safeOutput(result.stderr); return result;
  };
  assert.equal(ok(await kubectl(['config', 'current-context'])) === ok(await command(wrapper, ['kubectl', '--tag', 'deployment', 'config', 'current-context'])), true);
  stage = 'requires reachable scoped cluster, loaded images, OpenSSL and Gateway CRDs';
  ok(await kubectl(['get', 'nodes', '-o', 'name'])); ok(await command('openssl', ['version']));
  for (const name of ['gatewayclasses.gateway.orka.ai', 'gateways.gateway.orka.ai', 'gatewaybindings.gateway.orka.ai']) {
    ok(await kubectl(['wait', '--for=condition=Established', '--timeout=10s', `crd/${name}`]));
  }
  stage = 'actual Kustomize render and kubectl JSON conversion';
  const rendered = ok(await kubectl(['kustomize', 'deploy']));
  const jsonLines = 'jsonpath={@}{"\\n"}';
  const runtime = items(ok(await kubectl(['create', '--dry-run=client', '-f', '-', '-o', jsonLines], rendered)));
  const load = async (path: string) => items(ok(await kubectl(['create', '--dry-run=client', '-f', path, '-o', jsonLines])))[0]!;
  const pvc = await load('deploy/storage/pvc.yaml'); const prepare = await load('deploy/storage/prepare-job.yaml');
  const init = await load('deploy/storage/init-job.yaml');
  const orka = await Promise.all(['gatewayclass', 'gateway', 'gatewaybinding'].map((name) => load(`deploy/orka/${name}.yaml`)));
  const deployment = runtime.find((value) => value.kind === 'Deployment')!;
  const config = runtime.find((value) => value.metadata.name === 'teams-config')!;
  const podSpec = deployment.spec.template.spec; const [app, proxy] = podSpec.containers as Resource[];
  stage = 'rendered lifecycle, security, Secret/CA/PVC and exposure boundaries';
  assert.deepEqual(runtime.map((value) => value.kind).sort(), ['ConfigMap', 'ConfigMap', 'Deployment', 'NetworkPolicy', 'Service', 'Service']);
  assert.equal(runtime.every((value) => value.metadata.namespace === 'orka-system'), true);
  assert.equal(hasKey([runtime, pvc, prepare, init], 'fsGroup'), false);
  assert.equal(deployment.spec.replicas, 1); assert.equal(deployment.spec.strategy.type, 'Recreate');
  assert.equal(podSpec.automountServiceAccountToken, false); assert.equal(podSpec.seccompProfile, undefined);
  assert.equal(podSpec.securityContext.seccompProfile.type, 'RuntimeDefault');
  assert.equal(podSpec.initContainers, undefined); assert.equal(podSpec.terminationGracePeriodSeconds, 120);
  for (const [container, uid] of [[app!, 1000], [proxy!, 101]] as const) {
    const security = container.securityContext;
    assert.equal(security.runAsUser, uid); assert.equal(security.runAsGroup, uid);
    assert.equal(security.runAsNonRoot, true); assert.equal(security.readOnlyRootFilesystem, true);
    assert.equal(security.allowPrivilegeEscalation, false); assert.deepEqual(security.capabilities, { drop: ['ALL'] });
    assert.equal(container.livenessProbe, undefined);
  }
  assert.equal(app!.image, image); assert.equal(proxy!.image, nginxImage);
  assert.equal(app!.ports, undefined);
  assert.deepEqual(proxy!.ports.map((port: Resource) => port.containerPort).sort(), [8443, 8444]);
  assert.deepEqual(app!.env.filter((env: Resource) => env.valueFrom.secretKeyRef).map((env: Resource) => [env.name, env.valueFrom.secretKeyRef]), [
    ['TEAMS_CLIENT_SECRET', { name: 'teams-bot', key: 'client-secret' }],
    ['ORKA_BEARER_TOKEN', { name: 'teams-orka-inbound', key: 'token' }],
    ['ORKA_OUTBOUND_BEARER_TOKEN', { name: 'teams-orka-outbound', key: 'token' }],
  ]);
  assert.deepEqual(app!.readinessProbe.exec.command, ['node', '/app/dist/deployment/probe.js']);
  assert.equal(app!.env.find((env: Resource) => env.name === 'POD_NAMESPACE').valueFrom.fieldRef.fieldPath, 'metadata.namespace');
  assert.deepEqual(app!.volumeMounts.find((mount: Resource) => mount.name === 'state'), { name: 'state', mountPath: '/data', subPath: 'teams' });
  assert.equal(app!.volumeMounts.some((mount: Resource) => mount.name === 'tls'), false);
  assert.equal(proxy!.volumeMounts.some((mount: Resource) => mount.name === 'state' || mount.name === 'adapter-ca'), false);
  assert.equal(proxy!.env, undefined); assert.equal(proxy!.envFrom, undefined);
  assert.equal(podSpec.volumes.find((volume: Resource) => volume.name === 'tls').secret.defaultMode, 292);
  for (const service of runtime.filter((value) => value.kind === 'Service')) {
    assert.equal(service.spec.type, 'ClusterIP'); assert.equal(service.spec.ports.length, 1);
    assert.equal(service.spec.ports[0].port, 443); assert.deepEqual(service.spec.selector, deployment.spec.selector.matchLabels);
    assert.equal(service.spec.ports[0].targetPort, service.metadata.name === 'teams-adapter' ? 'adapter-tls' : 'messages-tls');
  }
  const policy = runtime.find((value) => value.kind === 'NetworkPolicy')!.spec;
  assert.deepEqual(policy.ingress[1], { from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'orka-system' } },
    podSelector: { matchLabels: { 'orka.ai/network-role': 'controller' } } }], ports: [{ protocol: 'TCP', port: 8444 }] });
  assert.equal(pvc.spec.resources.requests.storage, '2Gi'); assert.deepEqual(pvc.spec.accessModes, ['ReadWriteOnce']);
  for (const job of [prepare, init]) {
    assert.equal(job.spec.backoffLimit, 0); assert.equal(job.spec.template.spec.restartPolicy, 'Never');
    assert.equal(job.spec.template.spec.automountServiceAccountToken, false);
    assert.equal(hasKey(job, 'secretKeyRef') || hasKey(job, 'secretRef'), false);
  }
  assert.deepEqual(prepare.spec.template.spec.containers[0].securityContext.capabilities, { drop: ['ALL'], add: ['CHOWN'] });
  assert.equal(init.spec.template.spec.containers[0].securityContext.runAsUser, 1000);
  assert.deepEqual(init.spec.template.spec.containers[0].volumeMounts[0], { name: 'state', mountPath: '/data', subPath: 'teams' });
  console.log('PASS real Kustomize render: separate lifecycle, two TLS Services, private subPath, nonroot/read-only and isolated Secret mounts');

  const namespace = `teams-deployment-${randomUUID().slice(0, 8)}`; const owner = randomUUID();
  let namespaceUID = ''; let complete = false; let heldOwner = false;
  const observedOwnedUIDs = new Set<string>();
  const directory = mkdtempSync(join(tmpdir(), 'teams-deployment-'));
  const serverName = `teams-adapter.${namespace}.svc`;
  const settings: Settings = { env: { TEAMS_APP_ID: randomUUID(), TEAMS_TENANT_ID: randomUUID(),
    ORKA_BASE_URL: 'https://orka.example.invalid/', ORKA_GATEWAY_NAMESPACE: namespace, ORKA_GATEWAY_NAME: 'teams',
    TEAMS_RECIPIENT_IDS: '["synthetic-bot"]', TEAMS_SERVICE_URLS: '["https://teams.example.invalid/"]' },
    delivery: { protocolVersion: 'orka.gateway.v1', deliveryId: 'synthetic-delivery', idempotencyId: 'synthetic-idempotency',
      originatingEventId: 'synthetic-event', kind: 'final', accountId: '', contextId: 'synthetic-personal', replyTarget: 'synthetic-reply', text: randomUUID() },
    receipt: randomUUID() };
  settings.delivery.accountId = settings.env.TEAMS_TENANT_ID!;
  const botToken = randomUUID(); const inbound = randomUUID(); const outbound = randomUUID();
  privateValues = [botToken, inbound, outbound, settings.receipt, settings.delivery.text, settings.env.TEAMS_APP_ID!, settings.env.TEAMS_TENANT_ID!];
  const mark = (value: Resource): Resource => {
    const object = structuredClone(value);
    object.metadata.namespace = namespace; object.metadata.labels = { ...object.metadata.labels, [ownerLabel]: owner };
    if (object.spec?.template) object.spec.template.metadata = { ...object.spec.template.metadata,
      labels: { ...object.spec.template.metadata?.labels, [ownerLabel]: owner } };
    return object;
  };
  const create = async (value: Resource): Promise<Resource> => {
    const created = JSON.parse(ok(await kubectl(['create', '-f', '-', '-o', 'json'], JSON.stringify(mark(value))))) as Resource;
    observedOwnedUIDs.add(created.metadata.uid); return created;
  };
  const apply = async (value: Resource) => { ok(await kubectl(['apply', '-f', '-', '-o', 'name'], JSON.stringify(mark(value)))); };
  const get = async (resource: string, name?: string): Promise<Resource> => JSON.parse(ok(await kubectl(['get', resource, ...(name ? [name] : []), '-n', namespace, '-o', 'json']))) as Resource;
  const ownedNamespace = async () => {
    const current = await get('namespace', namespace);
    assert.equal(current.metadata.uid === namespaceUID && current.metadata.labels[ownerLabel] === owner, true);
    return current;
  };
  const inspect = async (): Promise<OwnershipSnapshot> => {
    const current = await ownedNamespace();
    const controllers = (await get('deployments.apps,replicasets.apps,statefulsets.apps')).items as Resource[];
    assert.equal((await get('daemonsets.apps,cronjobs.batch')).items.length, 0);
    const jobs = (await get('jobs.batch')).items as Resource[];
    const pods = (await get('pods')).items as Resource[];
    assert.equal([...controllers, ...jobs, ...pods].every((value) => value.metadata.labels?.[ownerLabel] === owner), true);
    assert.equal(jobs.every((job) => (job.status?.active ?? 0) === 0 && ((job.status?.succeeded ?? 0) > 0 || (job.status?.failed ?? 0) > 0)), true);
    return { namespaceUID: current.metadata.uid, owner: current.metadata.labels[ownerLabel],
      controllers: controllers.map((controller) => ({ replicas: controller.spec.replicas })), pods: pods as OwnedPod[] };
  };
  const proveStopped = () => withStoppedOwners(namespaceUID, owner, inspect, async () => {});
  const terminalPod = async (name: string, uid: string, exit: number) => {
    const deadline = performance.now() + 120000;
    while (true) {
      const pod = await get('pod', name);
      assert.equal(pod.metadata.uid === uid, true);
      if (['Succeeded', 'Failed'].includes(pod.status?.phase)) {
        assert.equal(pod.status.containerStatuses?.length === pod.spec.containers.length, true);
        assert.equal(pod.status.containerStatuses.every((status: Resource) => status.state.terminated?.exitCode === exit && !status.state.running && !status.state.waiting), true);
        return;
      }
      assert.equal(performance.now() < deadline, true); await sleep(500);
    }
  };
  const runJob = async (template: Resource, name: string, exit: number) => {
    const job = structuredClone(template); job.metadata.name = name;
    await create(job);
    ok(await kubectl(['wait', '-n', namespace, `job/${name}`, `--for=condition=${exit === 0 ? 'Complete' : 'Failed'}`, '--timeout=120s'], undefined, 130000));
    const pods = (await get('pods')).items.filter((pod: Resource) => pod.metadata.labels['job-name'] === name) as Resource[];
    assert.equal(pods.length, 1); await terminalPod(pods[0]!.metadata.name, pods[0]!.metadata.uid, exit);
  };
  const helperVolume = { name: 'fixture-code', configMap: { name: 'fixture-code' } };
  // A directory projection is a symlink: Node resolves import.meta.url but not argv,
  // which would skip the CLI's main guard. A file subPath preserves the image-like path.
  const helperMount = { name: 'fixture-code', mountPath: '/fixture/deployment-smoke.mjs', subPath: 'deployment-smoke.mjs', readOnly: true };
  const maintenance = async (name: string, mode: string) => {
    await withStoppedOwners(namespaceUID, owner, inspect, async () => {
      const spec = structuredClone(init.spec.template.spec);
      spec.containers[0].name = 'fixture'; spec.containers[0].command = ['node', '/fixture/deployment-smoke.mjs', mode];
      delete spec.containers[0].args;
      spec.volumes.push(helperVolume, { name: 'fixture-private', secret: { secretName: 'fixture-private', defaultMode: 292 } });
      spec.containers[0].volumeMounts.push(helperMount, { name: 'fixture-private', mountPath: '/fixture-private', readOnly: true });
      const pod = await create({ apiVersion: 'v1', kind: 'Pod', metadata: { name }, spec });
      await terminalPod(name, pod.metadata.uid, 0);
      const logs = ok(await kubectl(['logs', '-n', namespace, name, '-c', 'fixture']));
      safeOutput(logs); assert.equal(logs.includes(`FIXTURE PASS ${mode}`), true);
    });
  };
  const logsSafe = async () => {
    for (const pod of (await get('pods')).items as Resource[]) {
      assert.equal(pod.metadata.labels?.[ownerLabel] === owner, true);
      observedOwnedUIDs.add(pod.metadata.uid);
      for (const container of [...pod.spec.containers, ...(pod.spec.initContainers ?? [])] as Resource[]) {
        const result = await kubectl(['logs', '-n', namespace, pod.metadata.name, '-c', container.name]);
        safeOutput(result.stdout + result.stderr); ok(result);
        if (container.name === 'proxy') assert.equal(result.stdout.length, 0);
      }
    }
  };
  const logFollowers: { child: ChildProcess; done: Promise<Result> }[] = [];
  const followLogs = (podName: string, containerName: string) => {
    const child = spawn('kubectl', ['logs', '--follow', '-n', namespace, podName, '-c', containerName], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const done = new Promise<Result>((resolve) => {
      child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 1024 * 1024) child.kill('SIGTERM'); });
      child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 65536) child.kill('SIGTERM'); });
      child.once('error', () => resolve({ code: -1, stdout, stderr }));
      // close follows stdio completion; exit alone could miss final shutdown bytes.
      child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
    logFollowers.push({ child, done });
  };
  const finishLogs = async (abort: boolean) => {
    for (const follower of logFollowers) {
      if (abort && follower.child.exitCode === null && follower.child.signalCode === null) follower.child.kill('SIGTERM');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([follower.done, new Promise<never>((_, reject) => {
          timer = setTimeout(() => { follower.child.kill('SIGTERM'); reject(new Error('log follower termination unconfirmed')); }, 10000);
        })]);
        safeOutput(result.stdout + result.stderr); if (!abort) ok(result);
      } finally { clearTimeout(timer); }
    }
    logFollowers.length = 0;
  };
  const stopRuntime = async () => {
    await ownedNamespace(); await logsSafe();
    ok(await kubectl(['scale', '-n', namespace, 'deployment/teams', '--replicas=0']));
    const deadline = performance.now() + 150000;
    while ((await get('pods')).items.some((pod: Resource) => pod.metadata.labels['app.kubernetes.io/name'] === 'orka-gateway-teams')) {
      assert.equal(performance.now() < deadline, true); await sleep(500);
    }
    await proveStopped(); await finishLogs(false);
  };
  const startRuntime = async (): Promise<Resource> => {
    await proveStopped(); await apply(deployment);
    ok(await kubectl(['rollout', 'status', '-n', namespace, 'deployment/teams', '--timeout=120s'], undefined, 130000));
    const pods = (await get('pods')).items.filter((pod: Resource) => pod.metadata.labels['app.kubernetes.io/name'] === 'orka-gateway-teams') as Resource[];
    assert.equal(pods.length, 1); assert.equal(pods[0]!.status.containerStatuses.every((status: Resource) => status.ready), true);
    for (const container of podSpec.containers as Resource[]) followLogs(pods[0]!.metadata.name, container.name);
    return pods[0]!;
  };
  let forward: ChildProcess | undefined;
  let forwardOutput = '';
  const stopForward = async () => {
    if (!forward) return;
    const child = forward; forward = undefined;
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('port-forward termination unconfirmed')), 10000);
        child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
      });
    }
    safeOutput(forwardOutput);
  };
  const startForward = async (podName: string): Promise<[number, number]> => {
    await stopForward(); forwardOutput = '';
    forward = spawn('kubectl', ['port-forward', '-n', namespace, `pod/${podName}`, ':8443', ':8444', '--address=127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    forward.stdout!.on('data', (chunk: Buffer) => { forwardOutput += chunk.toString(); });
    forward.stderr!.on('data', (chunk: Buffer) => { forwardOutput += chunk.toString(); });
    forward.on('error', () => {});
    const deadline = performance.now() + 15000;
    while (true) {
      assert.equal(forwardOutput.length < 65536, true);
      const publicPort = /127\.0\.0\.1:(\d+) -> 8443/u.exec(forwardOutput)?.[1];
      const privatePort = /127\.0\.0\.1:(\d+) -> 8444/u.exec(forwardOutput)?.[1];
      if (publicPort && privatePort) return [Number(publicPort), Number(privatePort)];
      assert.equal(performance.now() < deadline && forward.exitCode === null, true); await sleep(100);
    }
  };
  const https = (port: number, ca: Buffer | undefined, path: string, token?: string, body?: string): Promise<{ status: number; body: string }> => new Promise((resolve) => {
    let text = '';
    const req = request({ host: '127.0.0.1', port, servername: serverName, ...(ca ? { ca } : {}), rejectUnauthorized: true,
      path, method: body ? 'POST' : 'GET', agent: false,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
      res.on('data', (chunk: Buffer) => { text += chunk.toString(); if (text.length > 4096) req.destroy(); });
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode ?? 0, body: text }); });
      res.on('error', () => { clearTimeout(timer); resolve({ status: 0, body: '' }); });
    });
    const timer = setTimeout(() => req.destroy(), 5000);
    req.on('error', () => { clearTimeout(timer); resolve({ status: 0, body: '' }); }); req.end(body);
  });
  try {
    stage = 'create NEW empty synthetic namespace, never adopt existing resources';
    assert.equal(ok(await kubectl(['get', 'namespace', namespace, '--ignore-not-found', '-o', 'name'])), '');
    const ns = JSON.parse(ok(await kubectl(['create', '-f', '-', '-o', 'json'], JSON.stringify({ apiVersion: 'v1', kind: 'Namespace',
      metadata: { name: namespace, labels: { [ownerLabel]: owner } } })))) as Resource;
    namespaceUID = ns.metadata.uid; await ownedNamespace();
    writeFileSync(join(directory, 'ownership.json'), JSON.stringify({ namespace, namespaceUID, owner }), { mode: 0o600 });
    assert.equal((await get('pods,deployments.apps,replicasets.apps,statefulsets.apps,daemonsets.apps,jobs.batch,cronjobs.batch,persistentvolumeclaims,secrets,services')).items.length, 0);
    console.log(`SCOPE ${namespace} (new owned synthetic namespace; coordinator cluster retained)`);
    stage = 'server dry-run against actual Kubernetes and installed Orka CRD schemas';
    for (const object of [...runtime, pvc, prepare, init, ...orka]) {
      const value = mark(object); if (value.kind === 'GatewayClass') delete value.metadata.namespace;
      ok(await kubectl(['apply', '--dry-run=server', '-f', '-', '-o', 'name'], JSON.stringify(value)));
    }
    console.log('PASS server dry-run: runtime, separate PVC/admin/init Jobs and all three Orka examples (no controller installed)');
    stage = 'private synthetic credentials, certificate and file-based helper';
    ok(await command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'tls.key'),
      '-out', join(directory, 'tls.crt'), '-days', '1', '-subj', `/CN=${serverName}`, '-addext',
      `subjectAltName=DNS:${serverName},DNS:teams-messages.${namespace}.svc`]));
    const ca = readFileSync(join(directory, 'tls.crt'));
    privateValues.push(readFileSync(join(directory, 'tls.key'), 'utf8').trim());
    const secret = async (name: string, data: Record<string, string>, type = 'Opaque') => {
      await create({ apiVersion: 'v1', kind: 'Secret', metadata: { name }, type, stringData: data });
    };
    await secret('teams-tls', { 'tls.crt': ca.toString(), 'tls.key': readFileSync(join(directory, 'tls.key'), 'utf8') }, 'kubernetes.io/tls');
    await secret('teams-bot', { 'client-secret': botToken });
    await secret('teams-orka-inbound', { token: inbound }); await secret('teams-orka-outbound', { token: outbound });
    await secret('fixture-private', { 'settings.json': JSON.stringify(settings) });
    await create({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'teams-adapter-ca' }, data: { 'ca.crt': ca.toString() } });
    const ts = await import('typescript');
    const compiled = ts.transpileModule(readFileSync(fileURLToPath(import.meta.url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext }, fileName: 'deployment-smoke.ts',
    }).outputText;
    await create({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'fixture-code' }, data: { 'deployment-smoke.mjs': compiled } });
    Object.assign(config.data, settings.env);
    // Fixture-only namespace adaptation; no live bindings or fake production routing.
    deployment.spec.template.spec.volumes.push(helperVolume);
    app!.volumeMounts.push(helperMount);
    for (const value of runtime.filter((object) => object.kind !== 'Deployment')) await create(value);
    await create(pvc);
    stage = 'explicit root+CHOWN preparation, refused repeat, nonroot init, refused re-init';
    await runJob(prepare, 'prepare', 0); await runJob(prepare, 'prepare-repeat', 1);
    await runJob(init, 'init', 0); await runJob(init, 'init-repeat', 1);
    await maintenance('permissions', 'fixture-inspect');
    stage = 'stopped-only public journal API seeds synthetic delivered receipt';
    await maintenance('seed', 'fixture-seed');
    console.log('PASS real PVC: new private UID1000 directory, explicit init, repeat refusal, 0600 stores and stopped-only journal API seed');
    stage = 'actual image Deployment, authenticated TLS readiness and two-container security';
    const first = await startRuntime();
    stage = 'running app metadata-only UID/mode/read-only inspection';
    const inspected = ok(await kubectl(['exec', '-n', namespace, first.metadata.name, '-c', 'app', '--', 'node', '/fixture/deployment-smoke.mjs', 'fixture-inspect']));
    assert.equal(inspected, 'FIXTURE PASS fixture-inspect');
    stage = 'silent compiled readiness probe through TLS';
    const probe = await kubectl(['exec', '-n', namespace, first.metadata.name, '-c', 'app', '--', 'node', '/app/dist/deployment/probe.js']);
    ok(probe); assert.equal((probe.stdout + probe.stderr).length, 0);
    stage = 'proxy UID and private port-forward';
    assert.equal(ok(await kubectl(['exec', '-n', namespace, first.metadata.name, '-c', 'proxy', '--', 'id', '-u'])), '101');
    const [publicPort, privatePort] = await startForward(first.metadata.name);
    stage = 'TLS health and exact capabilities';
    const health = await https(privatePort, ca, '/v1/health', outbound); assert.equal(health.status, 200);
    assert.equal((JSON.parse(health.body) as Resource).status, 'ok');
    const capabilities = await https(privatePort, ca, '/v1/capabilities', outbound); assert.equal(capabilities.status, 200);
    assert.deepEqual((JSON.parse(capabilities.body) as Resource).capabilities, {
      inboundText: true, outboundText: true, threads: false, senderIdentity: true, explicitSessions: false, idempotentDelivery: true,
    });
    stage = 'negative TLS/auth/public V1 boundaries';
    for (const path of ['/v1/health', '/v1/capabilities']) {
      for (const token of [undefined, inbound, botToken, randomUUID()]) assert.equal((await https(privatePort, ca, path, token)).status, 401);
      assert.equal((await https(publicPort, ca, path, outbound)).status, 404);
    }
    assert.equal((await https(privatePort, undefined, '/v1/health', outbound)).status, 0);
    assert.equal((await https(publicPort, ca, '/api/messages', undefined, '{}')).status, 401);
    const replay = async (port: number) => {
      stage = 'durable synthetic receipt replay through actual TLS API';
      const response = await https(port, ca, '/v1/deliveries', outbound, JSON.stringify(settings.delivery));
      assert.equal(response.status, 200); const body = JSON.parse(response.body) as Resource;
      assert.equal(body.status === 'delivered' && body.providerMessageId === settings.receipt, true);
    };
    await replay(privatePort);
    console.log('PASS actual Pod: TLS/SAN/CA+auth health/capabilities, untrusted CA/crossed credentials denied, public V1 blocked, saved receipt replay');
    await stopForward(); await stopRuntime();
    stage = 'all owners stopped BEFORE missing-owner mutation';
    await maintenance('hold-owner', 'fixture-hold'); heldOwner = true;
    stage = 'missing permanent owner refuses startup; independently verify actual terminated container';
    await proveStopped();
    const missingSpec = structuredClone(podSpec); missingSpec.restartPolicy = 'Never';
    missingSpec.containers = [structuredClone(app)]; delete missingSpec.containers[0].readinessProbe;
    const missing = await create({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'missing-owner' }, spec: missingSpec });
    await terminalPod('missing-owner', missing.metadata.uid, 1);
    // No finally restoration: any unconfirmed owner retains the held inode and namespace.
    stage = 'all owners stopped BEFORE restoring missing-owner fixture';
    await maintenance('restore-owner', 'fixture-restore'); heldOwner = false;
    await maintenance('permissions-after-stop', 'fixture-inspect');
    stage = 'replacement/remount preserves readiness, 0600 and exact synthetic receipt';
    const second = await startRuntime(); assert.equal(first.metadata.uid !== second.metadata.uid, true);
    const [, restartedPort] = await startForward(second.metadata.name); await replay(restartedPort);
    await stopForward(); await stopRuntime(); await maintenance('permissions-after-restart', 'fixture-inspect');
    await logsSafe(); await proveStopped();
    console.log('PASS missing-owner refusal with independent all-owner termination proof; new Pod UID/remount preserves receipt and private modes; fixture values absent from all retained Pod logs');
    complete = true;
  } finally {
    await stopForward(); await finishLogs(!complete);
    if (complete && namespaceUID && !heldOwner) {
      stage = 'owned synthetic cleanup (never production retirement)';
      await proveStopped();
      // Refuse namespace deletion if another actor has introduced foreign resources.
      const names = ok(await kubectl(['api-resources', '--verbs=list', '--namespaced=true', '-o', 'name'])).split(/\s+/u);
      const resources: Resource[] = [];
      for (const name of names) resources.push(...(await get(name)).items);
      const ownedUIDs = new Set([...observedOwnedUIDs, ...resources.filter((value) => value.metadata.labels?.[ownerLabel] === owner).map((value) => value.metadata.uid)]);
      for (const value of resources) {
        const system = (value.kind === 'ConfigMap' && value.metadata.name === 'kube-root-ca.crt') ||
          (value.kind === 'ServiceAccount' && value.metadata.name === 'default');
        const related = value.metadata.ownerReferences?.some((ref: Resource) => ownedUIDs.has(ref.uid)) ||
          ownedUIDs.has(value.involvedObject?.uid) || ownedUIDs.has(value.regarding?.uid);
        assert.equal(system || ownedUIDs.has(value.metadata.uid) || Boolean(related), true);
      }
      await ownedNamespace();
      ok(await kubectl(['delete', 'namespace', namespace, '--wait=true', '--timeout=120s'], undefined, 130000));
      rmSync(directory, { recursive: true, force: true });
      console.log('PASS deleted only owned synthetic namespace/data; kind cluster and pre-existing resources retained');
    } else {
      console.error(`Retained private fixtures at ${directory}; synthetic scope ${namespace}. No automatic restoration or namespace deletion after failure.`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2];
    if (mode?.startsWith('fixture-')) { await fixture(mode); console.log(`FIXTURE PASS ${mode}`); }
    else { assert.equal(mode, undefined); await smoke(); }
  } catch (error) {
    // Extract only our numeric source line, never raw errors/assertions/child output.
    const line = error instanceof Error ? /deployment-smoke\.(?:ts|mjs):(\d+):\d+/u.exec(error.stack ?? '')?.[1] : undefined;
    console.error(`Deployment smoke failed at: ${stage}${line ? ` (helper line ${line})` : ''}`); process.exitCode = 1;
  }
}
