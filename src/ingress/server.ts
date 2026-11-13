import { randomUUID } from 'node:crypto';
import { identity } from '../delivery/identity.js';
import type { ControlRecipient } from '../outbound/types.js';
import { App } from '@microsoft/teams.apps';
import { PUBLIC } from '@microsoft/teams.api';
import type { Activity, CloudEnvironment, TokenCredentials } from '@microsoft/teams.api';
import type { Token } from '@microsoft/teams.common/http';
import type { INetworkModule } from '@azure/msal-node';
import { prepareCertificate } from '../auth/certificate.js';
import { prepareManagedIdentity } from '../auth/managed-identity.js';
import type { ManagedIdentityDependencies } from '../auth/managed-identity.js';
import { assertSelectedTokenCredentials, denyBotToken } from '../auth/credentials.js';
import type { SessionCorrelationPort } from '../delivery/session-correlation.js';
import type { DeliveryJournalPort } from '../delivery/types.js';
import { createDeliveryDispatcher } from '../outbound/dispatcher.js';
import { createProviderSender } from '../outbound/sender.js';
import type { ProviderGet, ProviderPost } from '../outbound/sender.js';
import type { DeliveryDispatcher, ProviderSender } from '../outbound/types.js';
import { readPolicySubject } from '../policy/admission.js';
import type { PolicySubject } from '../policy/admission.js';
import { convertActivity, stripBotMentions } from '../teams/convert.js';
import { createStrictAuth } from './auth.js';
import { NativeAdapter } from './http-adapter.js';
import { safeSdkLogger } from './logger.js';
import { ConfigurationError, tlsVerificationEnabled, validateReceiverConfig } from './config.js';
import type { ReceiverConfig } from './config.js';
import type { AdmissionResult, IngressStore, ReplyRoute } from './types.js';
import type { EventEnvelope } from '../protocol/types.js';

export interface ReceiverDependencies { sdkCloud?: CloudEnvironment; fetchKeys?: (url: string, options: RequestInit) => Promise<Response>;
  botToken?: Token; providerPost?: ProviderPost; providerGet?: ProviderGet; certificateNetwork?: INetworkModule; managedIdentity?: ManagedIdentityDependencies }
export interface AdmissionContext { readonly signal: AbortSignal; readonly deadline: number; readonly subject: PolicySubject;
  readonly activityId: string; readonly commandText?: string; readonly delegatedTenant?: boolean; readonly controlRecipient?: ControlRecipient }
export interface ExchangeContext { readonly signal: AbortSignal; readonly deadline: number; readonly subject: PolicySubject }
export interface ExchangeResponse { status: 200 | 412; body: { id: string; connectionName: string; failureDetail?: 'signin-required' } }
export interface AdmissionSink { readonly scope: IngressStore['scope'];
  bindControlSender?(sender: Pick<ProviderSender, 'send'>): void;
  exchange?(activity: unknown, context: ExchangeContext): Promise<ExchangeResponse>;
  admit(event: Readonly<EventEnvelope>, route: Readonly<ReplyRoute>, context?: AdmissionContext): AdmissionResult | Promise<AdmissionResult> }
export interface ReceiverOutbound { authority?: import('../storage/table/types.js').LeaseAuthority; interimDelivery?: boolean; meetingDrafts?: boolean; journal: DeliveryJournalPort; correlation?: SessionCorrelationPort; getRoute: (key: string) => ReplyRoute | undefined | Promise<ReplyRoute | undefined> }
export type ReceiverOutbounds = ReceiverOutbound | { targets: readonly (ReceiverOutbound & { id: string })[] };
export interface Receiver { port: number; stop(): Promise<void>; failed: Promise<never>; outbound?: DeliveryDispatcher; outbounds?: ReadonlyMap<string, DeliveryDispatcher> }
export interface PreparedReceiver { start(sink: AdmissionSink, outbound?: ReceiverOutbounds, signal?: AbortSignal): Promise<Receiver> }

/** Call before owning any datastore. Preparation has no listener, CCA or live file descriptors. */
export function prepareReceiver(input: ReceiverConfig, dependencies: ReceiverDependencies = {}): PreparedReceiver {
  const config = validateReceiverConfig(input);
  const deps = { ...dependencies, ...(dependencies.sdkCloud === undefined ? {} : { sdkCloud: { ...dependencies.sdkCloud } }),
    ...(dependencies.managedIdentity === undefined ? {} : { managedIdentity: { ...dependencies.managedIdentity } }) };
  let credential: { assertUsable(): void; createToken(): TokenCredentials['token'] } | undefined;
  try {
    if (config.credentialMode === 'certificate' || config.credentialMode === 'managed-identity-federation') {
      if (deps.botToken !== undefined || (deps.sdkCloud !== undefined &&
          (deps.sdkCloud.botScope !== PUBLIC.botScope || deps.sdkCloud.loginEndpoint !== PUBLIC.loginEndpoint))) throw new ConfigurationError();
      if (config.credentialMode === 'certificate') {
        const certificate = prepareCertificate(config);
        credential = { assertUsable: certificate.assertUsable, createToken: () => certificate.createToken(deps.certificateNetwork) };
      } else {
        const identity = prepareManagedIdentity(config);
        credential = { assertUsable: identity.assertUsable, createToken: () => identity.createToken(deps.managedIdentity) };
      }
    }
  } catch { throw new ConfigurationError(); }
  let started = false;
  return Object.freeze({ async start(sink: AdmissionSink, outbound?: ReceiverOutbounds, signal?: AbortSignal) {
    if (started) throw new ConfigurationError(); started = true;
    return startPreparedReceiver(config, sink, deps, credential, outbound, signal);
  } });
}

export async function startReceiver(input: ReceiverConfig, sink: AdmissionSink, dependencies: ReceiverDependencies = {}, outbound?: ReceiverOutbounds): Promise<Receiver> {
  return prepareReceiver(input, dependencies).start(sink, outbound);
}

async function startPreparedReceiver(config: ReceiverConfig, sink: AdmissionSink, dependencies: ReceiverDependencies,
  credential: { assertUsable(): void; createToken(): TokenCredentials['token'] } | undefined, outbound?: ReceiverOutbounds, signal?: AbortSignal): Promise<Receiver> {
  if (signal?.aborted) throw new Error('Ingress startup failed');
  if (sink.scope.appId !== config.appId || sink.scope.tenantId !== config.tenantId) throw new Error('Invalid receiver configuration');
  const recipients = new Set(config.recipientIds); const services = new Set(config.serviceUrls);
  const adapter = new NativeAdapter(createStrictAuth(config.appId, dependencies.fetchKeys));
  let storageFailed = false; let fail!: (error: Error) => void;
  const failed = new Promise<never>((_resolve, reject) => { fail = reject; });
  // Consumers can await failure; a receiver used without a relay still fails closed.
  void failed.catch(() => {});
  credential?.assertUsable();
  const token = credential ? (outbound ? credential.createToken() : denyBotToken) : undefined;
  const app = new App({ clientId: config.appId, tenantId: config.tenantId,
    ...(config.credentialMode === 'certificate' || config.credentialMode === 'managed-identity-federation' ? { token: token! } : { clientSecret: config.clientSecret }),
    httpServerAdapter: adapter, logger: safeSdkLogger, dangerouslyAllowUnauthenticatedRequests: false,
    cloud: dependencies.sdkCloud ?? PUBLIC, plugins: [], oauth: { fetchUserToken: false },
    serviceUrl: config.serviceUrls[0]!, messagingEndpoint: '/api/messages' });

  if (token) assertSelectedTokenCredentials(app.credentials, config.appId, config.tenantId, token);

  // Bypass neither authentication nor the registered route. Replace the default
  // processing callback so activity rehydration, OAuth and event dispatch never run.
  app.server.onRequest = async ({ body }) => {
    if (!tlsVerificationEnabled()) return { status: 401 };
    if (!adapter.active || storageFailed || signal?.aborted) return { status: 503 };
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
    if (input.type === 'invoke' && input.name === 'signin/tokenExchange' && sink.exchange) {
      const subject = readPolicySubject(input, config.tenantId);
      if (!record(input.channelData) || !record(input.channelData.tenant) || input.channelData.tenant.id !== config.tenantId ||
          !subject.objectId || !controlRecipient(input)) return { status: 403 };
      try {
        const result = await sink.exchange(input, { ...adapter.requestContext, subject });
        return { status: result.status, body: { invokeResponse: result.body } };
      } catch { return { status: 412, body: { invokeResponse: { id: '', connectionName: '', failureDetail: 'signin-required' } } }; }
    }
    const converted = convertActivity(input as unknown as Activity, { tenantId: config.tenantId, replyTarget: randomUUID() });
    if (converted.kind === 'invalid') return { status: 400 };
    if (converted.kind === 'ignored') return { status: 200, body: { status: 'ignored' } };
    try {
      const base = { serviceUrl: input.serviceUrl, channelId: 'msteams' as const, bot: { id: input.recipient.id, role: 'bot' as const } };
      const id = converted.event.contextId; const tenantId = config.tenantId;
      const kind = input.conversation.conversationType;
      const route: ReplyRoute = kind === 'personal' ? { ...base, conversation: { id, conversationType: 'personal', tenantId } } :
        kind === 'groupChat' ? { ...base, conversation: { id, conversationType: 'groupChat', tenantId }, requester: { ...converted.event.sender } } :
          { ...base, conversation: { id, conversationType: 'channel', tenantId }, requester: { ...converted.event.sender }, threadId: converted.event.threadId! };
      // Personal events retain their historical text; mentions affect command recognition only.
      const normalized = kind === 'personal' ? stripBotMentions(converted.event.text, input.entities, input.recipient.id) : converted.event.text;
      const commandText = typeof normalized === 'string' ? normalized :
        kind === 'personal' && normalized.kind === 'ignored' ? converted.event.text : undefined;
      const result = await sink.admit(converted.event, route, Object.freeze({ ...adapter.requestContext,
        subject: readPolicySubject(input, tenantId), activityId: input.id as string,
        delegatedTenant: record(input.channelData) && record(input.channelData.tenant) && input.channelData.tenant.id === tenantId,
        ...(controlRecipient(input) ? { controlRecipient: controlRecipient(input)! } : {}),
        ...(commandText === undefined ? {} : { commandText }) }));
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
  let dispatcher: DeliveryDispatcher | undefined; let sender: ProviderSender | undefined; let stopping: Promise<void> | undefined;
  const dispatchers = new Map<string, DeliveryDispatcher>();
  const stop = () => stopping ??= (async () => {
    const results = await Promise.allSettled([adapter.stop(), ...[...dispatchers.values()].map(d => d.stop()), sender?.stop()]);
    if (results.some((result) => result.status === 'rejected')) throw new Error('Ingress shutdown failed');
  })();
  try {
    if (outbound) {
      // Constructor clientSecret takes precedence over its token option. Tests
      // replace only this SAME App's public factory; production retains the SDK factory.
      if (dependencies.botToken !== undefined) app.api.http.token = dependencies.botToken;
      sender = createProviderSender(async () => {
        try {
          const factory = app.api.http.token;
          const value = typeof factory === 'function' ? await factory({}) : factory;
          if (typeof value === 'string') return value;
          const text: unknown = value?.toString();
          return typeof text === 'string' ? text : undefined;
        } catch { return undefined; }
      }, { ...(dependencies.providerPost === undefined ? {} : { post: dependencies.providerPost }),
        ...(dependencies.providerGet === undefined ? {} : { get: dependencies.providerGet }) });
      const shared = sender;
      const borrowed: ProviderSender = { send: (...args) => shared.send(...args), stop: async () => {},
        ...(shared.getMembers === undefined ? {} : { getMembers: (...args: Parameters<NonNullable<ProviderSender['getMembers']>>) => shared.getMembers!(...args) }) };
      const slots = 'targets' in outbound ? outbound.targets : [{ ...outbound, id: '' }];
      if (!slots.length || slots.length > 32) throw new ConfigurationError();
      for (const slot of slots) {
        if (dispatchers.has(slot.id) || ('targets' in outbound && !/^[a-z][a-z0-9-]{0,62}$/u.test(slot.id))) throw new ConfigurationError();
        dispatchers.set(slot.id, createDeliveryDispatcher({ ...slot,
          scope: { appId: config.appId, tenantId: config.tenantId }, serviceUrls: config.serviceUrls, recipientIds: config.recipientIds, sender: 'targets' in outbound ? borrowed : shared }));
      }
      if (!('targets' in outbound)) dispatcher = dispatchers.get('');
      sink.bindControlSender?.(Object.freeze({ send: shared.send }));
    }
    await app.initialize();
    credential?.assertUsable();
    if (token) assertSelectedTokenCredentials(app.credentials, config.appId, config.tenantId, token);
    if (!tlsVerificationEnabled()) throw new ConfigurationError();
    if (signal?.aborted) throw new Error('Ingress startup failed');
    const port = await adapter.listen(config.host, config.port);
    if (signal?.aborted) throw new Error('Ingress startup failed');
    return { port, failed, stop, ...(dispatcher === undefined ? {} : { outbound: dispatcher }),
      ...(outbound && 'targets' in outbound ? { outbounds: dispatchers as ReadonlyMap<string, DeliveryDispatcher> } : {}) };
  } catch (error) {
    await stop(); throw error instanceof ConfigurationError ? error : new Error('Ingress startup failed');
  }
}

function controlRecipient(input: Record<string, unknown>): ControlRecipient | undefined {
  try { if (!record(input.from) || !record(input.conversation)) return undefined;
    return { id: identity(input.from.id), ...(input.conversation.conversationType === 'groupChat' ? { isTargeted: true as const } : {}) };
  } catch { return undefined; }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
