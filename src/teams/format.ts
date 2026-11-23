import type { IMessageActivityInput } from '@microsoft/teams.api';
import type { IAdaptiveCard, ITextBlock } from '@microsoft/teams.cards';
import type { DeliveryRequest } from '../protocol/types.js';

export const MAX_OUTGOING_MESSAGE_BYTES = 20 * 1024;

export type OutgoingTeamsMessage = IMessageActivityInput & {
  text?: '';
  attachments: [{
    contentType: 'application/vnd.microsoft.card.adaptive';
    content: IAdaptiveCard;
  }];
};

/** Adapter-local, validated room evidence; never protocol metadata or inferred history.
 * Labels and reply roots use the same 256-byte bounds as their validated route fields. */
export interface DeliveryPresentation {
  requesterDisplayName?: string;
  continuation?: boolean;
  replyToId?: string;
}
/** Deterministic, non-mutating formatting of a validated delivery/presentation.
 * Budgets the whole message; authorization, persistence and sending belong to the caller. */
export type FormatDelivery = (delivery: Readonly<DeliveryRequest>, presentation?: Readonly<DeliveryPresentation>) => OutgoingTeamsMessage;

const MAX_FALLBACK_BYTES = 512;
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

const HISTORY = " · uses this chat's history";
// Orka's own sentence when it has no cause to give. Under the failure heading it would say the same thing twice.
const NO_CAUSE = 'This request could not be completed.';

export const formatDelivery: FormatDelivery = (delivery, presentation) => {
  // The explicit prefix changes presentation only, not wire or Task semantics.
  const asked = delivery.kind === 'message' && delivery.text.startsWith('Question: ') ? delivery.text.slice('Question: '.length) : '';
  const kind = delivery.kind === 'final' ? 'reply' : delivery.kind !== 'message' ? 'failure' : asked.trim() ? 'question' : 'update';
  const title = kind === 'reply' ? 'Orka reply' : kind === 'failure' ? 'Orka could not complete the request' : kind === 'question' ? 'Orka question' : 'Orka update';
  const written = kind === 'question' ? asked.charAt(0).toUpperCase() + asked.slice(1) :
    kind === 'failure' && delivery.text.trim() === NO_CAUSE ? '' : delivery.text.trim() ? delivery.text : '';
  // With nothing from Orka, a sentence of our own stands in. A failure's card leaves it out: the heading already says it.
  const text = written || (kind === 'reply' ? 'Orka finished without a text reply.' : NO_CAUSE);
  // One grey line says whose turn this is and whether the agent is done. A personal chat needs no name.
  const who = presentation === undefined ? undefined :
    `${presentation.requesterDisplayName ? escapeMarkdown(presentation.requesterDisplayName) : 'an allowed participant'}${presentation.continuation ? HISTORY : ''}`;
  const label = who === undefined ? (kind === 'update' ? 'Still working' : kind === 'question' ? 'Question' : undefined) :
    `${kind === 'update' ? 'Working for' : kind === 'question' ? 'Question for' : 'Reply to'} ${who}`;
  // A group chat or channel only hears messages that mention the bot.
  const next = kind === 'failure' ? 'Try again, or ask in a different way.' : kind === 'question' && who !== undefined ? 'Answer by mentioning @Orka.' : undefined;
  const fallbackTitle = [title, ...(who === undefined ? [] : [label!])].join(' — ');
  const create = (body: string, fallback: string, shortened: boolean) =>
    createMessage({ label, failure: kind === 'failure', text: written || kind !== 'failure' ? body : undefined, next, shortened }, fallback, presentation?.replyToId);
  const full = create(text, formatFallback(fallbackTitle, text, false), false);
  if (messageBytes(full) <= MAX_OUTGOING_MESSAGE_BYTES) return full;

  // Keep the fallback and notice fixed so serialized size grows monotonically
  // with the retained prefix, including JSON escaping and the activity envelope.
  const fallback = formatFallback(fallbackTitle, text, true);
  const boundaries = [0];
  for (const { index, segment } of segmenter.segment(text)) {
    boundaries.push(index + segment.length);
  }
  let low = 0;
  let high = boundaries.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = create(text.slice(0, boundaries[middle]!), fallback, true);
    if (messageBytes(candidate) <= MAX_OUTGOING_MESSAGE_BYTES) low = middle;
    else high = middle - 1;
  }
  // Boundary zero always fits: a giant first grapheme leaves the title and
  // shortening notice readable without splitting that grapheme or overflowing.
  return create(text.slice(0, boundaries[low]!), fallback, true);
};

function escapeMarkdown(label: string): string {
  return label.replace(/[\\`*_{}\[\]()<>#+\-.!|~]/gu, '\\$&');
}

function formatFallback(title: string, text: string, shortened: boolean): string {
  const summary = `${title}: ${text.replace(/\s+/gu, ' ').trim()}`;
  const suffix = '… (shortened)';
  let bytes = Buffer.byteLength(suffix, 'utf8');
  // Reserve the suffix even before body shortening, so adding its disclosure
  // cannot drop a large fallback grapheme and make the unchanged body fit.
  if (!shortened && Buffer.byteLength(summary, 'utf8') + bytes <= MAX_FALLBACK_BYTES) return summary;

  let end = 0;
  for (const { index, segment } of segmenter.segment(summary)) {
    const size = Buffer.byteLength(segment, 'utf8');
    if (bytes + size > MAX_FALLBACK_BYTES) break;
    bytes += size;
    end = index + segment.length;
  }
  return summary.slice(0, end) + suffix;
}

function messageBytes(message: OutgoingTeamsMessage): number {
  return Buffer.byteLength(JSON.stringify(message), 'utf8');
}

interface Parts { label: string | undefined; failure: boolean; text: string | undefined; next: string | undefined; shortened: boolean }
function createMessage(parts: Parts, fallbackText: string, replyToId?: string): OutgoingTeamsMessage {
  const note = { wrap: true, isSubtle: true, size: 'Small' as const };
  const body: ITextBlock[] = [
    ...(parts.label === undefined ? [] : [{ type: 'TextBlock' as const, text: parts.label, ...note, spacing: 'None' as const }]),
    ...(parts.failure ? [{ type: 'TextBlock' as const, text: "Couldn't complete the request", weight: 'Bolder' as const, wrap: true, spacing: 'Small' as const, color: 'Attention' as const }] : []),
    ...(parts.text === undefined ? [] : [{ type: 'TextBlock' as const, text: parts.text, wrap: true, spacing: 'Small' as const }]),
    ...(parts.next === undefined ? [] : [{ type: 'TextBlock' as const, text: parts.next, wrap: true, spacing: 'Small' as const, ...(parts.failure ? {} : { isSubtle: true, size: 'Small' as const }) }]),
  ];
  if (parts.shortened) body.push({ type: 'TextBlock', text: 'Reply shortened to fit the message limit.', ...note });
  // Check the card separately: the SDK's general Attachment.content is any.
  const card: IAdaptiveCard = { type: 'AdaptiveCard', version: '1.4', fallbackText, body };
  return {
    type: 'message',
    ...(replyToId === undefined ? {} : { replyToId }),
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }],
  };
}
