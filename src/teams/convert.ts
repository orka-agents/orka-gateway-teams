import type { Activity } from '@microsoft/teams.api';
import { MAX_IDENTITY_BYTES, MAX_TEXT_BYTES, PROTOCOL_VERSION } from '../protocol/types.js';
import type { EventEnvelope } from '../protocol/types.js';
import { createExternalEventId } from './ids.js';

export interface ConversionContext {
  tenantId: string;
  replyTarget: string;
}

export type ConversionResult =
  | { kind: 'accepted'; event: EventEnvelope }
  | { kind: 'ignored'; reason: 'unsupported-activity' | 'unsupported-conversation' | 'bot-message' | 'empty-text' | 'unmentioned' }
  | { kind: 'invalid'; reason: 'missing-identity' | 'tenant-mismatch' | 'invalid-field' | 'field-too-large' };

/**
 * Authenticate transport before calling; the converter still validates fields.
 * Acceptance is a candidate, not human attestation or sender authorization.
 * Never mutate the activity or context.
 * The caller persists the normalized event and reply-target key and replays that
 * original envelope, not a new conversion with refreshed routing or profile data.
 */
export type ConvertActivity = (
  activity: Readonly<Activity>,
  context: Readonly<ConversionContext>,
) => ConversionResult;

export const convertActivity: ConvertActivity = (activity, context) => {
  // SDK declarations describe expected shapes, not verified external values.
  const input: unknown = activity;
  const configuration: unknown = context;
  if (!isRecord(input) || !isRecord(configuration)) return invalid();
  const type = field(input.type, 'discriminator');
  if (typeof type !== 'string') return type;
  if (type !== 'message') return { kind: 'ignored', reason: 'unsupported-activity' };
  const channel = field(input.channelId, 'discriminator');
  if (typeof channel !== 'string') return channel;
  if (channel !== 'msteams') return { kind: 'ignored', reason: 'unsupported-activity' };

  const { conversation, from, channelData } = input;
  if (conversation === undefined || from === undefined) return invalid('missing-identity');
  if (!isRecord(conversation) || !isRecord(from)) return invalid();
  const conversationType = field(conversation.conversationType, 'discriminator');
  if (typeof conversationType !== 'string') return conversationType;
  if (conversation.isGroup !== undefined && typeof conversation.isGroup !== 'boolean') return invalid();
  const shared = conversationType === 'groupChat' || conversationType === 'channel';
  if ((!shared && conversationType !== 'personal') || (conversationType === 'personal' && conversation.isGroup === true)) {
    return { kind: 'ignored', reason: 'unsupported-conversation' };
  }
  if (channelData !== undefined && !isRecord(channelData)) return invalid();
  if (channelData?.eventType !== undefined) {
    const eventType = field(channelData.eventType, 'discriminator');
    if (typeof eventType !== 'string') return eventType;
    return { kind: 'ignored', reason: 'unsupported-activity' };
  }

  // Missing roles are normal wire data. Neither absence nor role:user proves humanity.
  if (from.role !== undefined) {
    const role = field(from.role, 'discriminator');
    if (typeof role !== 'string') return role;
    if (role !== 'user' && role !== 'bot' && role !== 'skill') return invalid();
  }
  if (from.type !== undefined) {
    const accountType = field(from.type, 'discriminator');
    if (typeof accountType !== 'string') return accountType;
  }
  if (from.role === 'bot' || from.role === 'skill' || from.type === 'bot') {
    return { kind: 'ignored', reason: 'bot-message' };
  }

  const tenantId = field(configuration.tenantId);
  if (typeof tenantId !== 'string') return tenantId;
  const replyTarget = field(configuration.replyTarget);
  if (typeof replyTarget !== 'string') return replyTarget;
  const activityId = field(input.id);
  if (typeof activityId !== 'string') return activityId;
  const conversationId = field(conversation.id);
  if (typeof conversationId !== 'string') return conversationId;
  const teamsSenderId = field(from.id);
  if (typeof teamsSenderId !== 'string') return teamsSenderId;
  let recipientId: string | undefined;
  if (input.recipient !== undefined) {
    if (!isRecord(input.recipient)) return invalid();
    if (input.recipient.id !== undefined) {
      const id = field(input.recipient.id);
      if (typeof id !== 'string') return id;
      recipientId = id;
      if (recipientId === teamsSenderId) return { kind: 'ignored', reason: 'bot-message' };
    }
  }
  if (shared && recipientId === undefined) return invalid('missing-identity');
  const senderId = shared ? field(from.aadObjectId) : teamsSenderId;
  if (typeof senderId !== 'string') return senderId;

  const claims: unknown[] = [];
  if (channelData?.tenant !== undefined) {
    if (!isRecord(channelData.tenant)) return invalid();
    claims.push(channelData.tenant.id);
  }
  if (conversation.tenantId !== undefined) claims.push(conversation.tenantId);
  if (claims.length === 0) return invalid('missing-identity');
  for (const claim of claims) {
    const tenant = field(claim);
    if (typeof tenant !== 'string') return tenant;
    if (tenant !== tenantId) return invalid('tenant-mismatch');
  }

  const threadId = conversationType === 'channel' ? channelRoot(conversationId, activityId, input.replyToId) : undefined;
  if (threadId !== undefined && typeof threadId !== 'string') return threadId;

  if (input.text === undefined) return { kind: 'ignored', reason: 'empty-text' };
  let text = field(input.text, 'text');
  if (typeof text !== 'string') return text;
  if (shared && recipientId !== undefined) {
    const stripped = stripBotMentions(text, input.entities, recipientId);
    if (typeof stripped !== 'string') return stripped;
    text = stripped;
  }
  if (/^\p{White_Space}*$/u.test(text)) return { kind: 'ignored', reason: 'empty-text' };
  const displayName = from.name === undefined ? '' : field(from.name, 'label');
  if (typeof displayName !== 'string') return displayName;
  return {
    kind: 'accepted',
    event: {
      protocolVersion: PROTOCOL_VERSION,
      externalEventId: createExternalEventId({ tenantId, conversationId, activityId }),
      eventType: 'text',
      accountId: tenantId,
      contextId: conversationId,
      ...(threadId === undefined ? {} : { threadId }),
      sender: { id: senderId, ...(displayName === '' ? {} : { displayName }) },
      text,
      replyTarget,
    },
  };
};

type InvalidResult = Extract<ConversionResult, { kind: 'invalid' }>;

function channelRoot(conversationId: string, activityId: string, replyToId: unknown): string | InvalidResult {
  const replyRoot = replyToId === undefined ? undefined : field(replyToId);
  if (replyRoot !== undefined && typeof replyRoot !== 'string') return replyRoot;
  // Teams channel conversations may carry the root as a terminal ;messageid= suffix.
  // Preserve the full conversation as context; never use channelData.channel.id as a root.
  // https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations
  const marker = ';messageid=';
  const markerIndex = conversationId.indexOf(';messageid');
  if (markerIndex === -1) return replyRoot ?? activityId;
  if (markerIndex === 0 || !conversationId.startsWith(marker, markerIndex)) return invalid();
  const suffix = conversationId.slice(markerIndex + marker.length);
  if (suffix.includes(';')) return invalid();
  const suffixRoot = field(suffix);
  if (typeof suffixRoot !== 'string') return suffixRoot;
  if (replyRoot !== undefined && replyRoot !== suffixRoot) return invalid();
  return suffixRoot;
}

// Separate count, scan and occurrence limits bound synchronous external-data work.
// These are conservative admission limits, not a claim about provider maxima.
const MAX_MENTION_ENTITIES = 256;
const MAX_MENTION_TOKENS = 64;
const MAX_MENTION_WORK = 2 * 1024 * 1024;
const MAX_MENTION_OCCURRENCES = 4096;

function stripBotMentions(text: string, entities: unknown, recipientId: string): string | Exclude<ConversionResult, { kind: 'accepted' }> {
  if (entities === undefined) return { kind: 'ignored', reason: 'unmentioned' };
  if (!Array.isArray(entities) || entities.length > MAX_MENTION_ENTITIES) return invalid();
  const botTexts = new Set<string>();
  const otherTexts = new Set<string>();
  for (const entity of entities) {
    if (!isRecord(entity)) return invalid();
    const type = field(entity.type, 'discriminator');
    if (typeof type !== 'string') return type;
    if (type !== 'mention') continue;
    if (entity.mentioned === undefined) return invalid('missing-identity');
    if (!isRecord(entity.mentioned)) return invalid();
    const target = field(entity.mentioned.id);
    if (typeof target !== 'string') return target;
    const mentionText = field(entity.text);
    if (typeof mentionText !== 'string') return mentionText;
    if (target === recipientId) {
      botTexts.add(mentionText);
    } else {
      otherTexts.add(mentionText);
    }
  }
  if (botTexts.size === 0) return { kind: 'ignored', reason: 'unmentioned' };

  // Reserve aggregate scanning work before searching ANY token. Counting both
  // sets is conservative even when a token belongs to both (ambiguous) targets.
  if (botTexts.size + otherTexts.size > MAX_MENTION_TOKENS) return invalid();
  let work = 0;
  for (const tokens of [botTexts, otherTexts]) for (const token of tokens) work += text.length + token.length;
  if (work > MAX_MENTION_WORK) return invalid();
  let occurrences = 0;
  const consume = (length: number) => ++occurrences <= MAX_MENTION_OCCURRENCES && (work += length) <= MAX_MENTION_WORK;

  // Work against original positions so removing one token cannot create another.
  // Both masks are text-length bounded; prefix counts make overlap checks O(1)
  // instead of scanning/allocating a subarray for every repeated occurrence.
  const removed = new Uint8Array(text.length);
  for (const token of botTexts) {
    const first = text.indexOf(token); if (first === -1) return invalid();
    for (let start = first; start !== -1; start = text.indexOf(token, start + 1)) {
      if (!consume(token.length)) return invalid();
      removed.fill(1, start, start + token.length);
    }
  }
  const prefix = new Uint32Array(text.length + 1);
  for (let n = 0; n < text.length; n++) prefix[n + 1] = prefix[n]! + removed[n]!;
  for (const token of otherTexts) {
    for (let start = text.indexOf(token); start !== -1; start = text.indexOf(token, start + 1)) {
      if (!consume(token.length) || prefix[start + token.length]! !== prefix[start]!) return invalid();
    }
  }
  let stripped = '';
  let keptStart = 0;
  for (let index = 0; index < text.length; index++) {
    if (removed[index] === 0) continue;
    stripped += text.slice(keptStart, index);
    keptStart = index + 1;
  }
  return (stripped + text.slice(keptStart)).replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
}

function invalid(reason: InvalidResult['reason'] = 'invalid-field'): InvalidResult {
  return { kind: 'invalid', reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function field(value: unknown, kind: 'identity' | 'discriminator' | 'label' | 'text' = 'identity'): string | InvalidResult {
  if (kind === 'identity' && (value === undefined || value === '')) return invalid('missing-identity');
  if (typeof value !== 'string' || (kind === 'discriminator' && value === '')) return invalid();
  // In Unicode mode this matches lone surrogates, not valid supplementary code points.
  if (/[\uD800-\uDFFF]/u.test(value)) return invalid();
  if (Buffer.byteLength(value, 'utf8') > (kind === 'text' ? MAX_TEXT_BYTES : MAX_IDENTITY_BYTES)) {
    return invalid('field-too-large');
  }
  const controls = kind === 'text' ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u : /\p{Cc}/u;
  if (controls.test(value)) return invalid();
  // Match Go strings.TrimSpace: White_Space includes NEL, but excludes FEFF.
  // Validate raw labels before trimming; never repair provider-owned identities.
  if (kind === 'label') return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
  if (kind !== 'text' && /^\p{White_Space}|\p{White_Space}$/u.test(value)) return invalid();
  return value;
}
