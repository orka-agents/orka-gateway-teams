import { App } from '@microsoft/teams.apps';
import { assertCredentialSeparation, prepareCertificate } from '../auth/certificate.js';
import { assertSelectedTokenCredentials, denyBotToken, validateBotCredential } from '../auth/credentials.js';
import { PUBLIC } from '@microsoft/teams.api';
import type { Activity, CloudEnvironment } from '@microsoft/teams.api';
import { createStrictAuth } from '../ingress/auth.js';
import type { FetchKeys } from '../ingress/auth.js';
import { tlsVerificationEnabled, validateReceiverConfig } from '../ingress/config.js';
import { NativeAdapter } from '../ingress/http-adapter.js';
import { safeSdkLogger } from '../ingress/logger.js';
import { convertActivity } from '../teams/convert.js';
import { openSetupArtifact } from './artifact.js';
import { validateSetupConfig } from './config.js';
import type { SetupConfig } from './config.js';

export interface SetupAuthDependencies { fetchKeys?: FetchKeys; sdkCloud?: CloudEnvironment }
export interface SetupCapture { port: number; done: Promise<void>; stop(): Promise<void> }

export async function startSetupCapture(input: SetupConfig, dependencies: SetupAuthDependencies = {}, signal?: AbortSignal): Promise<SetupCapture> {
  const config = validateSetupConfig(input);
  if (signal?.aborted) throw failure();
  assertCredentialSeparation(config, [config.challengeFile, config.captureFile]);
  const certificate = config.credentialMode === 'certificate' ? prepareCertificate(config) : undefined;
  const artifact = openSetupArtifact(config);
  const adapter = new NativeAdapter(createStrictAuth(config.appId, dependencies.fetchKeys));
  const deadline = performance.now() + config.timeoutMs;
  let state: 'waiting' | 'writing' | 'captured' | 'failed' = 'waiting';
  let stopping: Promise<void> | undefined; let terminating = false;
  let initialized!: () => void;
  const startup = new Promise<void>((resolve) => { initialized = resolve; });
  let responseFinished = Promise.resolve();
  let resolveDone!: () => void; let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  void done.catch(() => {});
  const active = () => !terminating && (state === 'waiting' || state === 'writing') && adapter.active &&
    !signal?.aborted && tlsVerificationEnabled() && performance.now() < deadline;

  function stop(): Promise<void> {
    if (stopping) return stopping;
    terminating = true;
    if (state !== 'captured') state = 'failed';
    clearTimeout(timer);
    stopping = (async () => {
      // Initialization can outlive cancellation. Never close-before-listen and then
      // bind late. A selected request flushes first, outside its own SDK callback.
      await startup; await responseFinished;
      try { await adapter.stop(); } catch { state = 'failed'; }
      try { artifact.close(); } catch { state = 'failed'; }
      signal?.removeEventListener('abort', cancel);
      if (state === 'captured') resolveDone(); else rejectDone(failure());
    })();
    return stopping;
  }
  const cancel = () => { void stop(); };
  const timer = setTimeout(cancel, config.timeoutMs);
  signal?.addEventListener('abort', cancel, { once: true });

  try {
    certificate?.assertUsable();
    const app = new App({ clientId: config.appId, tenantId: config.tenantId,
      ...(config.credentialMode === 'certificate' ? { token: denyBotToken } : { clientSecret: config.clientSecret }),
      httpServerAdapter: adapter, logger: safeSdkLogger, dangerouslyAllowUnauthenticatedRequests: false,
      cloud: dependencies.sdkCloud ?? PUBLIC, plugins: [], oauth: { fetchUserToken: false },
      // Unused SDK client configuration only, not a discovered route or a URL we request.
      serviceUrl: 'https://smba.trafficmanager.net/teams/', messagingEndpoint: '/api/messages' });
    if (certificate) assertSelectedTokenCredentials(app.credentials, config.appId, config.tenantId, denyBotToken);
    app.server.onRequest = async ({ body }) => {
      if (!tlsVerificationEnabled()) return { status: 401 };
      if (!active() || state !== 'waiting') return { status: 503 };
      const raw: unknown = body;
      if (!record(raw) || raw.channelId !== 'msteams' || !record(raw.recipient) || typeof raw.recipient.id !== 'string' ||
          typeof raw.serviceUrl !== 'string') return { status: 403 };
      if (!record(raw.conversation) || (raw.channelData !== undefined && !record(raw.channelData))) return { status: 400 };
      const tenants: unknown[] = [];
      if (raw.conversation.tenantId !== undefined) tenants.push(raw.conversation.tenantId);
      if (record(raw.channelData) && raw.channelData.tenant !== undefined) {
        if (!record(raw.channelData.tenant)) return { status: 400 };
        tenants.push(raw.channelData.tenant.id);
      }
      if (!tenants.length || tenants.some((value) => value !== config.tenantId)) return { status: 403 };
      // Converter-only placeholder: never persisted, exposed, or usable as a reply route.
      const converted = convertActivity(raw as unknown as Activity, { tenantId: config.tenantId, replyTarget: 'setup-candidate-only' });
      if (converted.kind === 'invalid') return { status: 400 };
      if (converted.kind === 'ignored' || !artifact.matches(raw.text)) return { status: 200, body: { status: 'ignored' } };
      try {
        // Apply unchanged runtime routing policy to actual discovered values, not dummy defaults.
        validateReceiverConfig({ appId: config.appId, tenantId: config.tenantId, ...validateBotCredential(config),
          host: config.host, port: config.port, recipientIds: [raw.recipient.id], serviceUrls: [raw.serviceUrl] });
      } catch { return { status: 400 }; }
      if (!active()) return { status: 503 };
      state = 'writing';
      responseFinished = new Promise<void>((resolve) => {
        adapter.afterResponse(() => { resolve(); void stop(); });
      });
      try {
        artifact.publish({ appId: config.appId, tenantId: config.tenantId, recipientId: raw.recipient.id, serviceUrl: raw.serviceUrl,
          senderId: converted.event.sender.id, conversationId: converted.event.contextId }, active);
        if (terminating) return { status: 503 };
        state = 'captured'; clearTimeout(timer);
        return { status: 200, body: { status: 'accepted' } };
      } catch { state = 'failed'; return { status: 503 }; }
    };
    await app.initialize();
    certificate?.assertUsable();
    if (certificate) assertSelectedTokenCredentials(app.credentials, config.appId, config.tenantId, denyBotToken);
    if (terminating || signal?.aborted || !tlsVerificationEnabled() || performance.now() >= deadline) throw failure();
    const port = await adapter.listen(config.host, config.port);
    if (terminating || signal?.aborted || !tlsVerificationEnabled() || performance.now() >= deadline) throw failure();
    initialized(); return { port, done, stop };
  } catch {
    initialized(); await stop(); throw failure();
  }
}

function failure(): Error { return new Error('Setup capture failed'); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
