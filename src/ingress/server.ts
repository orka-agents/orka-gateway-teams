import { randomUUID } from 'node:crypto';
import { App } from '@microsoft/teams.apps';
import { PUBLIC } from '@microsoft/teams.api';
import type { Activity, CloudEnvironment } from '@microsoft/teams.api';
import { convertActivity } from '../teams/convert.js';
import { createStrictAuth } from './auth.js';
import { NativeAdapter } from './http-adapter.js';
import { safeSdkLogger } from './logger.js';
import { ConfigurationError, tlsVerificationEnabled, validateReceiverConfig } from './config.js';
import type { ReceiverConfig } from './config.js';
import type { AdmissionResult, IngressStore, ReplyRoute } from './types.js';
import type { EventEnvelope } from '../protocol/types.js';

export interface ReceiverDependencies { sdkCloud?: CloudEnvironment; fetchKeys?: (url: string, options: RequestInit) => Promise<Response> }
export interface AdmissionSink { readonly scope: IngressStore['scope'];
  admit(event: Readonly<EventEnvelope>, route: Readonly<ReplyRoute>): AdmissionResult | Promise<AdmissionResult> }
export interface Receiver { port: number; stop(): Promise<void>; failed: Promise<never> }
export async function startReceiver(input: ReceiverConfig, sink: AdmissionSink, dependencies: ReceiverDependencies = {}): Promise<Receiver> {
  const config = validateReceiverConfig(input);
  if (sink.scope.appId !== config.appId || sink.scope.tenantId !== config.tenantId) throw new Error('Invalid receiver configuration');
  const recipients = new Set(config.recipientIds); const services = new Set(config.serviceUrls);
  const adapter = new NativeAdapter(createStrictAuth(config.appId, dependencies.fetchKeys));
  let storageFailed = false; let fail!: (error: Error) => void;
  const failed = new Promise<never>((_resolve, reject) => { fail = reject; });
  // Consumers can await failure; a receiver used without a relay still fails closed.
  void failed.catch(() => {});
  const app = new App({ clientId: config.appId, tenantId: config.tenantId, clientSecret: config.clientSecret,
    httpServerAdapter: adapter, logger: safeSdkLogger, dangerouslyAllowUnauthenticatedRequests: false,
    cloud: dependencies.sdkCloud ?? PUBLIC, plugins: [], oauth: { fetchUserToken: false },
    serviceUrl: config.serviceUrls[0]!, messagingEndpoint: '/api/messages' });

  // Bypass neither authentication nor the registered route. Replace the default
  // processing callback so activity rehydration, OAuth and event dispatch never run.
  app.server.onRequest = async ({ body }) => {
    if (!tlsVerificationEnabled()) return { status: 401 };
    if (!adapter.active || storageFailed) return { status: 503 };
    const input: unknown = body;
    if (!record(input) || !record(input.recipient) || typeof input.recipient.id !== 'string' ||
        !recipients.has(input.recipient.id) || typeof input.serviceUrl !== 'string' || !services.has(input.serviceUrl) ||
        input.channelId !== 'msteams') return { status: 403 };
    if (!record(input.conversation) || (input.channelData !== undefined && !record(input.channelData))) return { status: 400 };
    const claims: unknown[] = [];
    if (input.conversation.tenantId !== undefined) claims.push(input.conversation.tenantId);
    if (record(input.channelData) && input.channelData.tenant !== undefined) {
      if (!record(input.channelData.tenant)) return { status: 400 };
      claims.push(input.channelData.tenant.id);
    }
    if (!claims.length || claims.some((value) => value !== config.tenantId)) return { status: 403 };
    const converted = convertActivity(input as unknown as Activity, { tenantId: config.tenantId, replyTarget: randomUUID() });
    if (converted.kind === 'invalid') return { status: 400 };
    if (converted.kind === 'ignored') return { status: 200, body: { status: 'ignored' } };
    try {
      const result = await sink.admit(converted.event, { serviceUrl: input.serviceUrl, channelId: 'msteams',
        bot: { id: input.recipient.id, role: 'bot' }, conversation: { id: converted.event.contextId,
          conversationType: 'personal', tenantId: config.tenantId } });
      if (result.kind === 'full') return { status: 503 };
      if (result.kind === 'conflict') return { status: 409 };
      return { status: 200, body: { status: result.kind } };
    } catch {
      storageFailed = true;
      // Publish fatal lifecycle failure after the fixed 503 is flushed (or the
      // caller disconnects), so runtime shutdown cannot tear down that response.
      adapter.afterResponse(() => fail(new Error('Ingress storage failed')));
      return { status: 503 };
    }
  };
  try {
    await app.initialize();
    if (!tlsVerificationEnabled()) throw new ConfigurationError();
    const port = await adapter.listen(config.host, config.port); return { port, failed, stop: () => adapter.stop() };
  } catch (error) {
    await adapter.stop(); throw error instanceof ConfigurationError ? error : new Error('Ingress startup failed');
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
