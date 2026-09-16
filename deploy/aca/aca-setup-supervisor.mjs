import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const paths = Object.freeze({ directory: '/tmp/orka-teams-setup',
  challenge: '/tmp/orka-teams-setup/challenge', candidate: '/tmp/orka-teams-setup/candidate.json',
  status: '/tmp/orka-teams-setup/status' });
export const setupCli = '/app/dist/setup/main.js';
const states = new Set(['supervisor-alive', 'child-running', 'child-closed-ok', 'child-closed-failed', 'supervisor-failed']);
const failure = () => new Error('Setup supervisor failed');

// Fixed ACA setup profile, not a normal-runtime environment filter or auth probe.
export function setupEnvironment(input) {
  if (input.TEAMS_CREDENTIAL_MODE !== 'managed-identity-federation' ||
      input.TEAMS_MANAGED_IDENTITY_HOST !== 'azure-container-apps' ||
      Object.keys(input).some((key) => /^(TABLE_|ORKA_|INGRESS_|OUTBOUND_)/u.test(key) ||
        ['GATEWAY_STORAGE_BACKEND', 'DELIVERY_DB', 'TEAMS_RECIPIENT_IDS', 'TEAMS_SERVICE_URLS', 'NODE_OPTIONS'].includes(key))) throw failure();
  const fixed = { SETUP_HOST: '0.0.0.0', SETUP_PORT: '3978',
    SETUP_CHALLENGE_FILE: paths.challenge, SETUP_CAPTURE_FILE: paths.candidate };
  for (const [key, value] of Object.entries(fixed)) {
    if (input[key] !== undefined && input[key] !== value) throw failure();
  }
  return { ...input, ...fixed };
}

// Tests replace only filesystem/entropy boundaries. Real entropy is used only in /app at runtime.
export function preparePrivateCapture(io = fs, entropy = randomBytes, uid = process.getuid?.(), gid = process.getgid?.()) {
  if (uid !== 1000 || gid !== 1000) throw failure();
  for (const directory of ['/', '/tmp']) {
    const stamp = io.lstatSync(directory); const mode = stamp.mode & 0o7777;
    if (!stamp.isDirectory() || ![0, uid].includes(stamp.uid) ||
        ((mode & 0o022) !== 0 && !(stamp.uid === 0 && (mode & 0o1000) !== 0))) throw failure();
  }
  // Refuse reuse, including a dangling symlink. Never chmod/chown/adopt old output.
  io.mkdirSync(paths.directory, { mode: 0o700 });
  const stamp = io.lstatSync(paths.directory);
  if (!stamp.isDirectory() || stamp.uid !== uid || stamp.gid !== gid || (stamp.mode & 0o7777) !== 0o700) throw failure();
  const bytes = entropy(16);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 16) throw failure();
  io.writeFileSync(paths.challenge, 'orka-setup:' + bytes.toString('hex'), { mode: 0o600, flag: 'wx' });
}

export async function openSupervisorHealth(port = 3980, host = '0.0.0.0') {
  const server = createServer({ requestTimeout: 2000, headersTimeout: 2000, keepAliveTimeout: 1 }, (req, res) => {
    req.resume();
    res.setHeader('Connection', 'close');
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Cache-Control', 'no-store');
    const alive = req.method === 'GET' && req.url === '/healthz';
    res.writeHead(alive ? 200 : 404); res.end(alive ? 'supervisor-alive\n' : '');
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolveListen, reject) => {
    server.once('error', reject); server.listen(port, host, resolveListen);
  });
  return { port: server.address().port,
    close: () => new Promise((resolveClose, reject) => server.close((error) => error ? reject(failure()) : resolveClose())) };
}

// Deliberate one-child lifecycle; dependency boundaries support offline process-event tests.
export async function superviseSetup({ prepare, launch, health = openSupervisorHealth, status, signals = process }) {
  let child; let closed = false; let stopping = false; let requestedSignal = 'SIGTERM';
  let failed = false; let code = 1; let listener;
  let release;
  const termination = new Promise((resolveTermination) => { release = resolveTermination; });
  const report = (state) => {
    try { status(state); } catch { failed = true; }
  };
  const forward = () => {
    if (!child || closed) return;
    try { if (!child.kill(requestedSignal)) failed = true; } catch { failed = true; }
  };
  const stop = (signal) => {
    stopping = true; requestedSignal = signal; forward(); release();
  };
  const sigterm = () => stop('SIGTERM'); const sigint = () => stop('SIGINT');
  signals.on('SIGTERM', sigterm); signals.on('SIGINT', sigint);
  try {
    try {
      listener = await health(); report('supervisor-alive');
      if (!stopping) {
        const env = await prepare();
        if (!stopping) {
          child = launch(env);
          // Neither 'exit', 'error', a kill result nor a timer proves stdio/process close.
          const completion = new Promise((resolveClose) => {
            child.on('error', () => { failed = true; });
            child.once('close', (exitCode, signal) => {
              closed = true; resolveClose(exitCode === 0 && signal === null ? 0 : 1);
            });
          });
          report('child-running');
          if (stopping) forward();
          code = await completion;
          report(code === 0 && !failed ? 'child-closed-ok' : 'child-closed-failed');
        }
      }
    } catch {
      failed = true; report('supervisor-failed');
      // Health starts before preparation: no child or artifacts exist if it could not bind.
      if (!listener) return 1;
    }
    // Retain successful AND failed artifacts until a protected operator explicitly stops us.
    // This is ephemeral retention, not durable storage or an automatic retry window.
    await termination;
    try { await listener?.close(); } catch { failed = true; report('supervisor-failed'); }
    return failed ? 1 : code;
  } finally {
    signals.off('SIGTERM', sigterm); signals.off('SIGINT', sigint);
  }
}

async function main() {
  let statusFd;
  try {
    if (process.argv[1] !== '/app/aca-setup-supervisor.mjs' || process.argv.length !== 2) throw failure();
    process.umask(0o077);
    process.exitCode = await superviseSetup({
      prepare: async () => {
        const env = setupEnvironment(process.env);
        const { parseSetupConfig } = await import('/app/dist/setup/config.js');
        parseSetupConfig(env); // Structural native validation only; no token or Table operation.
        preparePrivateCapture();
        statusFd = fs.openSync(paths.status, 'wx', 0o600);
        return env;
      },
      launch: (env) => spawn(process.execPath, [setupCli], { env, cwd: '/app', stdio: 'ignore' }),
      status: (state) => {
        if (!states.has(state)) throw failure();
        // Never relay child output or stringify exceptions/private inputs.
        process.stdout.write('teams-setup-supervisor: ' + state + '\n');
        if (statusFd !== undefined) {
          fs.ftruncateSync(statusFd, 0); fs.writeSync(statusFd, state + '\n', 0, 'utf8'); fs.fsyncSync(statusFd);
        }
      },
    });
  } catch {
    process.stderr.write('teams-setup-supervisor: supervisor-failed\n'); process.exitCode = 1;
  } finally {
    if (statusFd !== undefined) {
      try { fs.closeSync(statusFd); } catch { process.exitCode = 1; }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
