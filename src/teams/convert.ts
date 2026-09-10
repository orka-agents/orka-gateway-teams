import type { Activity } from '@microsoft/teams.api';
import type { EventEnvelope } from '../protocol/types.js';

export interface ConversionContext {
  tenantId: string;
  replyTarget: string;
}

export type ConversionResult =
  | { kind: 'accepted'; event: EventEnvelope }
  | { kind: 'ignored'; reason: 'unsupported-activity' | 'unsupported-conversation' | 'bot-message' | 'empty-text' }
  | { kind: 'invalid'; reason: 'missing-identity' | 'tenant-mismatch' | 'invalid-field' | 'field-too-large' };

/**
 * #550 supplies the pure implementation. Authenticate transport before calling;
 * the converter still validates fields. Never mutate the activity or context.
 * The caller persists the normalized event and reply-target key and replays that
 * original envelope, not a new conversion with refreshed routing or profile data.
 */
export type ConvertActivity = (
  activity: Readonly<Activity>,
  context: Readonly<ConversionContext>,
) => ConversionResult;
