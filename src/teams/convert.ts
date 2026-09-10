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
  | { kind: 'ignored'; reason: 'unsupported-activity' | 'unsupported-conversation' | 'bot-message' | 'empty-text' }
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
  if (conversationType !== 'personal' || conversation.isGroup === true) {
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
  const senderId = field(from.id);
  if (typeof senderId !== 'string') return senderId;
  if (input.recipient !== undefined) {
    if (!isRecord(input.recipient)) return invalid();
    if (input.recipient.id !== undefined) {
      const recipientId = field(input.recipient.id);
      if (typeof recipientId !== 'string') return recipientId;
      if (recipientId === senderId) return { kind: 'ignored', reason: 'bot-message' };
    }
  }

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

  if (input.text === undefined) return { kind: 'ignored', reason: 'empty-text' };
  const text = field(input.text, 'text');
  if (typeof text !== 'string') return text;
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
      sender: { id: senderId, ...(displayName === '' ? {} : { displayName }) },
      text,
      replyTarget,
    },
  };
};

type InvalidResult = Extract<ConversionResult, { kind: 'invalid' }>;

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
