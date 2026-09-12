import type { IAdaptiveCard } from '@microsoft/teams.cards';
import { TypingActivity } from '@microsoft/teams.api';
import { convertActivity } from '../src/teams/convert.js';
import type { ConvertActivity, ConversionResult } from '../src/teams/convert.js';
import { formatDelivery } from '../src/teams/format.js';
import type { FormatDelivery, OutgoingTeamsMessage } from '../src/teams/format.js';
import type { DeliveryRequest } from '../src/protocol/types.js';
import { initializeIngressStore, openIngressStore, createIngressPort } from '../src/ingress/store.js';
import type { AdmissionResult, IngressClaim, IngressPort, IngressStore, OrkaClient, ReplyRoute } from '../src/ingress/types.js';
import { initializeDeliveryJournal, openDeliveryJournal } from '../src/delivery/journal.js';
import type { BeginDeliveryResult, DeliveryJournal, DeliveryJournalPort, SettlementResult } from '../src/delivery/types.js';
import { parseConfig } from '../src/ingress/config.js';
import type { ServeConfig } from '../src/ingress/config.js';
import { relayOne } from '../src/ingress/relay.js';
import { personalMessage, conversionContext, expectedEvent } from './fixtures/incoming.js';
import { errorDelivery, finalMessage } from './fixtures/outgoing.js';

const convertArguments: Parameters<ConvertActivity> = [personalMessage, conversionContext];
const converter: ConvertActivity = convertActivity;
const converted: ConversionResult = convertActivity(...convertArguments);
const notification: ConversionResult = convertActivity(new TypingActivity(), conversionContext);
const accepted: ReturnType<ConvertActivity> = { kind: 'accepted', event: expectedEvent };
const ignored: ConversionResult = { kind: 'ignored', reason: 'unsupported-activity' };
const invalid: ConversionResult = { kind: 'invalid', reason: 'tenant-mismatch' };
const formatArguments: Parameters<FormatDelivery> = [errorDelivery];
const outgoing: ReturnType<FormatDelivery> = finalMessage;
const formatter: FormatDelivery = formatDelivery;

// @ts-expect-error Accepted results require an event.
const missingEvent: ConversionResult = { kind: 'accepted' };
// @ts-expect-error Delivery kinds cannot advertise progress in this contract.
const progress: DeliveryRequest = { ...errorDelivery, kind: 'progress' };
// @ts-expect-error An invalid card type must fail without going through attachment any.
const invalidCard: IAdaptiveCard = { type: 'NotAnAdaptiveCard' };
// @ts-expect-error A card reply must not also contain an ordinary text reply.
const duplicateReply: OutgoingTeamsMessage = { ...finalMessage, text: 'A second reply' };
// @ts-expect-error Exactly one card attachment is required.
const missingAttachment: OutgoingTeamsMessage = { ...finalMessage, attachments: [] };
// @ts-expect-error Two card attachments are not one outgoing card.
const extraAttachment: OutgoingTeamsMessage = { ...finalMessage, attachments: [finalMessage.attachments[0], finalMessage.attachments[0]] };

// Not executed: lock the existing synchronous exports/direct-call contracts.
function storageContracts(store: IngressStore, journal: DeliveryJournal, config: ServeConfig, route: ReplyRoute, client: OrkaClient) {
  const initialized: void = initializeIngressStore(config.dbPath, config.scope);
  const opened: IngressStore = openIngressStore(config.dbPath, config.scope);
  const admitted: AdmissionResult = store.admit(expectedEvent, route);
  const claimed: IngressClaim | undefined = store.claim();
  const saved: ReplyRoute | undefined = store.getRoute('reply-key');
  const claim: IngressClaim = { externalEventId: 'event', attemptId: 'attempt', attempt: 1, event: expectedEvent };
  const completed: boolean = store.complete(claim, { status: 'accepted', eventId: 'receipt', state: 'Queued' });
  const retried: boolean = store.retry(claim, 1000); const blocked: boolean = store.block(claim, 'conflict');
  const closed: void = store.close();
  const journalInitialized: void = initializeDeliveryJournal(config.dbPath, config.scope);
  const journalOpened: DeliveryJournal = openDeliveryJournal(config.dbPath, config.scope);
  const begun: BeginDeliveryResult = journal.begin(errorDelivery);
  const settled: SettlementResult = journal.settle({ idempotencyId: 'id', attemptId: 'attempt' }, { kind: 'retryable' });
  const journalClosed: void = journal.close();
  const parsed: ServeConfig = parseConfig({}, 'serve');
  const deliveryPort: DeliveryJournalPort = journal;
  const ingressPort: IngressPort = createIngressPort(store);
  const legacyRelay: Promise<boolean> = relayOne(store, client);
  const asyncRelay: Promise<boolean> = relayOne(ingressPort, client);
  // @ts-expect-error Async claims require an owner-local handoff, not a public legacy claim.
  const invalidPort: IngressPort = { ...ingressPort, claimForForwarding: async () => claim };
  const legacyAsync = { ...store, claim: async () => claim };
  // @ts-expect-error Promise<legacy claim> cannot bypass mandatory handoff eligibility.
  relayOne(legacyAsync, client);
  // @ts-expect-error The final owner-local handoff MUST remain synchronous.
  const invalidGrant: import('../src/ingress/types.js').IngressForwardingGrant = { claim, revalidate: async () => true, take: async () => true, retire() {} };
  // @ts-expect-error No backend selector is added to ServeConfig in the SQLite-only slice.
  const tableConfig: ServeConfig = { ...config, storageBackend: 'azure-table' };
  void [initialized, opened, admitted, claimed, saved, completed, retried, blocked, closed,
    journalInitialized, journalOpened, begun, settled, journalClosed, parsed, deliveryPort, ingressPort,
    legacyRelay, asyncRelay, invalidPort, invalidGrant, tableConfig];
}
void storageContracts;

void [convertArguments, converter, converted, notification, accepted, ignored, invalid, formatArguments, outgoing, formatter,
  missingEvent, progress, invalidCard, duplicateReply, missingAttachment, extraAttachment];
