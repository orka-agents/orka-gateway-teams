import { createAccountStore } from '../accounts/store.js';
import { createTaskService } from '../accounts/task-service.js';
import type { TaskService } from '../accounts/task-service.js';
import { grantReference } from '../accounts/grants.js';
import type { AccountStore } from '../accounts/store.js';
import { createDelegatedAuth } from '../auth/delegated.js';
import type { FetchKeys } from '../ingress/auth.js';
import { setTimeout as sleep } from 'node:timers/promises';
import type https from 'node:https';
import type { ImdsRequest } from '../auth/imds.js';
import { createGraphIdentity } from '../auth/graph-identity.js';
import { readGroupPolicy } from '../policy/config.js';
import { createGroupAuthorizer } from '../policy/admission.js';
import { createGraphMembershipClient } from '../policy/graph.js';
import { createBindingProvisioner } from '../directory/provision.js';
import { createKubernetesReader } from './kubernetes.js';
import { createRegistryAdmission } from './admission.js';
import { prepareStorageIdentity } from '../auth/storage-identity.js';
import { createTableDeliveryJournalV3 } from '../delivery/table-journal.js';
import { openDirectory } from '../directory/store.js';
import type { Directory } from '../directory/store.js';
import { createDirectoryTable } from '../directory/table.js';
import type { DirectoryTable } from '../directory/types.js';
import { createOrkaClient } from '../ingress/client.js';
import { ConfigurationError, tlsVerificationEnabled } from '../ingress/config.js';
import type { IngressRuntime, IngressRuntimeDependencies } from '../ingress/main.js';
import { relayOne } from '../ingress/relay.js';
import { LeaseRuntimeFailure, readCaBundle } from '../ingress/runtime-shared.js';
import type { Receiver } from '../ingress/server.js';
import { prepareReceiver } from '../ingress/server.js';
import { createTableIngressStoreV3 } from '../ingress/table-store.js';
import type { OutboundServer } from '../outbound/server.js';
import { startTargetOutboundServer } from '../outbound/server.js';
import type { LeaseAuthority } from '../storage/table/types.js';
import type { RegistryConfig } from './config.js';
import { readSigninKey, snapshotRegistry } from './config.js';

export interface RegistryRuntimeDependencies extends IngressRuntimeDependencies {
  graphIdentityRequest?: ImdsRequest; graphRequest?: typeof https.request; kubernetesRequest?: typeof https.request;
  delegatedRequest?: typeof https.request; delegatedKeys?: FetchKeys; workiqRequest?: typeof https.request;
}
export async function startRegistryRuntime(input: RegistryConfig, dependencies: RegistryRuntimeDependencies = {}, signal?: AbortSignal): Promise<IngressRuntime> {
  const config = snapshotRegistry(input); const deps = { ...dependencies };
  if (!config.directoryTable || !config.groupPolicyFile || !tlsVerificationEnabled() || deps.openIngressStore !== undefined || deps.openDeliveryJournal !== undefined) throw new ConfigurationError();
  if (signal?.aborted) throw new Error('Registry startup cancelled');
  const shared = config.targets[0]!; const key = config.sso ? readSigninKey(config.sso.keyFile) : undefined;
  const policy = readGroupPolicy(config.groupPolicyFile, config);
  const delegatedAuth = config.sso ? createDelegatedAuth(shared.config.receiver, {
    ...(deps.managedIdentity ? { managedIdentity: deps.managedIdentity } : {}), ...(deps.delegatedRequest ? { request: deps.delegatedRequest } : {}),
    ...(deps.delegatedKeys ? { fetchKeys: deps.delegatedKeys } : {}) }) : undefined;
  const readers = config.targets.map(t => createKubernetesReader(t, deps.kubernetesRequest === undefined ? {} : { request: deps.kubernetesRequest }));
  const authorizer = createGroupAuthorizer(policy, createGraphMembershipClient(createGraphIdentity(policy.graphIdentityClientId,
    deps.graphIdentityRequest === undefined ? {} : { request: deps.graphIdentityRequest }), deps.graphRequest === undefined ? {} : { request: deps.graphRequest }));
  const prepared = prepareReceiver(shared.config.receiver, deps);
  const abort = new AbortController(); const loss = new AbortController(); const authorities: LeaseAuthority[] = [];
  const subscriptions: (() => void)[] = []; const handles: { open(): Promise<unknown>; close(): Promise<unknown> }[] = [];
  let ready = false; let fatal = false; let opening = true; let receiver: Receiver | undefined; let api: OutboundServer | undefined;
  let stopRuntime: (() => Promise<void>) | undefined; let closing: Promise<void> | undefined;
  let directory: Directory | undefined; let directoryTable: DirectoryTable | undefined; let accounts: AccountStore | undefined;
  let admission: ReturnType<typeof createRegistryAdmission> | undefined; let tasks: TaskService | undefined;
  const authority: LeaseAuthority = {
    allowed: () => !loss.signal.aborted && !abort.signal.aborted && authorities.every(a => a.allowed()),
    revalidate: async () => (await Promise.all(authorities.map(a => a.revalidate()))).every(Boolean) && authority.allowed(), lost: loss.signal,
  };
  const clients = config.targets.map(t => createOrkaClient(t.config.scope, { bearerToken: t.config.bearerToken, authority,
    ...(config.sso ? { delegatedGrant: async (event, signal) => {
      const ref = grantReference(t.config.scope, t, event.externalEventId, event.replyTarget!);
      const grant = await accounts!.getGrant(ref, { signal: signal ?? abort.signal, deadline: performance.now() + 2000 });
      return grant?.targetId === t.id && grant.targetDigest === t.identityDigest ? ref : undefined;
    } } : {}),
    ...(t.config.caFile === undefined ? {} : { ca: readCaBundle(t.config.caFile) }) }));
  // Each ciphertext transport has its own four native slots; all borrow this identity.
  const provider = prepareStorageIdentity(shared.config.storage.identity).createProvider(deps.storageIdentity, Math.max(32, config.targets.length * 2 + (config.sso ? 8 : 4)));
  const unsubscribe = () => { for (const remove of subscriptions.splice(0)) remove(); };
  const closeStores = async () => {
    // Handler/relay work drains first, then all native policy/provisioner work,
    // then directory requests, while every V3 lease and token source remain owned.
    const results: PromiseSettledResult<unknown>[] = await Promise.allSettled([authorizer.close(), ...readers.map(r => r.close())]);
    results.push(...await Promise.allSettled([tasks?.close()]));
    results.push(...await Promise.allSettled([delegatedAuth?.close(), accounts?.close()])); key?.fill(0);
    results.push(...await Promise.allSettled([Promise.resolve().then(() => directory?.close() ?? directoryTable?.close())]));
    unsubscribe(); results.push(...await Promise.allSettled(handles.map(h => Promise.resolve().then(() => h.close()))));
    results.push(...await Promise.allSettled([Promise.resolve().then(() => provider.close())])); return results;
  };
  const cancel = () => {
    ready = false; abort.abort();
    if (stopRuntime) void stopRuntime().catch(() => {});
    else if (opening) {
      // Cancel foreign-lease waits only during store opening. Listener/SDK startup
      // must unwind and drain before catch releases any store.
      setImmediate(() => { if (!stopRuntime && opening) { unsubscribe(); for (const h of handles) void Promise.resolve().then(() => h.close()).catch(() => {}); } });
    }
  };
  const lost = () => { fatal = true; loss.abort(); cancel(); };
  const subscribe = (a: LeaseAuthority) => {
    authorities.push(a); a.lost.addEventListener('abort', lost, { once: true }); subscriptions.push(() => a.lost.removeEventListener('abort', lost));
    if (a.lost.aborted) lost();
  };
  const assertStarting = () => { if (abort.signal.aborted || signal?.aborted) throw new Error('Registry startup cancelled'); };
  const active = () => ready && authority.allowed();
  signal?.addEventListener('abort', cancel, { once: true });
  const slots: { target: typeof shared; inbox: ReturnType<typeof createTableIngressStoreV3>; journal: ReturnType<typeof createTableDeliveryJournalV3> }[] = [];
  try {
    for (const target of config.targets) {
      const c = target.config; const s = c.storage;
      const native = { token: provider.token, ...(deps.tableRequest === undefined ? {} : { request: deps.tableRequest }),
        ...(deps.tableLeaseClock === undefined ? {} : { leaseClock: deps.tableLeaseClock }) };
      const inbox = createTableIngressStoreV3({ kind: 'ingress', account: s.account, table: s.table, storeId: s.ingressStoreId, scope: c.scope }, native,
        { audit: s.audit, maxIndexBytes: s.maxIndexBytes, policy: c.policy });
      handles.push(inbox); subscribe(inbox.leaseAuthority());
      const journal = createTableDeliveryJournalV3({ kind: 'delivery', account: s.account, table: s.table, storeId: s.deliveryStoreId!,
        scope: { appId: c.scope.appId, tenantId: c.scope.tenantId } }, native);
      handles.push(journal); subscribe(journal.leaseAuthority()); slots.push({ target, inbox, journal });
    }
    // Every handle is retained and subscribed before the first ownership await.
    for (const h of handles) { assertStarting(); await h.open(); assertStarting(); }
    opening = false;
    // Directory startup borrows authority, but is not a third V3 domain. From here
    // cancellation must drain its real requests before closing any owned store.
    directoryTable = createDirectoryTable({ account: shared.config.storage.account, table: config.directoryTable,
      appId: shared.config.scope.appId, tenantId: shared.config.scope.tenantId },
    { token: provider.token, ...(deps.tableRequest === undefined ? {} : { request: deps.tableRequest }) });
    directory = await openDirectory(directoryTable, { signal: abort.signal,
      deadline: performance.now() + shared.config.storage.audit.maxDurationMs }, authority);
    assertStarting();
    if (config.sso) {
      accounts = createAccountStore({ account: shared.config.storage.account, table: config.sso.accountTable,
        appId: shared.config.scope.appId, tenantId: shared.config.scope.tenantId }, key!,
      { token: provider.token, ...(deps.tableRequest ? { request: deps.tableRequest } : {}) }, authority); key!.fill(0);
      tasks = createTaskService({ accounts, auth: delegatedAuth!, authority,
        targets: config.targets.map(t => ({ id: t.id, gatewayUid: t.gatewayUid, identityDigest: t.identityDigest!, taskPassToken: t.taskPassToken! })),
        privateCredentials: config.targets.flatMap(t => [t.config.bearerToken, t.config.outbound!.bearerToken]),
        ...(deps.workiqRequest ? { workiq: { request: deps.workiqRequest } } : {}),
        log: category => { process.stderr.write(`teams-ingress: ${category}\n`); } });
    }
    admission = createRegistryAdmission({ config, directory, authority, active, authorizer,
      ...(accounts && delegatedAuth && config.sso ? { delegated: { accounts, auth: delegatedAuth, apiUri: config.sso.apiUri, connectionName: config.sso.connectionName,
        ...(config.sso.publicOrigin ? { publicOrigin: config.sso.publicOrigin } : {}) } } : {}),
      slots: slots.map((s, i) => ({ ...s, provisioner: createBindingProvisioner(s.target, readers[i]!) })),
      log: (category, id) => { process.stderr.write(`teams-ingress: ${category}${id ? ` (${id})` : ''}\n`); } });
    receiver = await prepared.start(admission,
      { targets: slots.map(s => ({ id: s.target.id, journal: s.journal, correlation: s.journal, authority,
        getRoute: key => s.inbox.getRoute(key),
        ...(s.target.config.outbound!.interimDelivery === undefined ? {} : { interimDelivery: s.target.config.outbound!.interimDelivery }),
        ...(s.target.config.outbound!.meetingDrafts === undefined ? {} : { meetingDrafts: s.target.config.outbound!.meetingDrafts }) })) }, abort.signal);
    assertStarting();
    api = await startTargetOutboundServer(shared.config.outbound!, slots.map(s => ({
      ...s.target.config.outbound!, prefix: `/targets/${s.target.id}`,
      dispatcher: receiver!.outbounds!.get(s.target.id)!, scope: { appId: s.target.config.scope.appId, tenantId: s.target.config.scope.tenantId },
    })), active, tasks);
    assertStarting(); if (!authority.allowed()) throw new Error('Registry authority lost'); ready = true;
  } catch {
    ready = false; abort.abort();
    await Promise.allSettled([api?.stop(), receiver?.stop()]); await closeStores(); signal?.removeEventListener('abort', cancel);
    throw new LeaseRuntimeFailure(loss.signal.aborted ? 'lease-authority-lost' : 'lease-transition-uncertain');
  }
  let resolveDone!: () => void; let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; }); void done.catch(() => {});
  const relays = slots.map((s, i) => (async () => {
    try {
      while (!abort.signal.aborted) {
        if (!await relayOne(s.inbox, clients[i]!, abort.signal, active, (claim) => admission!.preflight(s.target.id, claim, abort.signal))) {
          try { await sleep(100, undefined, { signal: abort.signal }); }
          catch { if (!abort.signal.aborted) throw new Error('Relay scheduling failed'); }
        }
      }
    } catch { fatal = true; cancel(); }
  })());
  const stop = (): Promise<void> => closing ??= (async () => {
    ready = false; abort.abort();
    const drained = await Promise.allSettled([api!.stop(), receiver!.stop(), ...relays]);
    const closed = await closeStores(); signal?.removeEventListener('abort', cancel);
    if (fatal || [...drained, ...closed].some(r => r.status === 'rejected')) {
      const error = new LeaseRuntimeFailure(loss.signal.aborted ? 'lease-authority-lost' : 'lease-transition-uncertain'); rejectDone(error); throw error;
    }
    resolveDone();
  })();
  stopRuntime = stop;
  void receiver.failed.catch(() => { fatal = true; cancel(); }); void api.failed.catch(() => { fatal = true; cancel(); });
  if (abort.signal.aborted) void stop().catch(() => {});
  return { port: receiver.port, outboundPort: api.port, done, stop };
}
