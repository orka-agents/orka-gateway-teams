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

export const formatDelivery: FormatDelivery = (delivery, presentation) => {
  // The explicit prefix changes presentation only, not wire or Task semantics.
  const title = delivery.kind === 'message'
    ? (delivery.text.startsWith('Question: ') ? 'Orka question' : 'Orka update')
    : delivery.kind === 'final' ? 'Orka reply' : 'Orka could not complete the request';
  const emptyText = delivery.kind === 'final'
    ? 'Orka finished without a text reply.'
    : 'This request could not be completed.';
  const text = delivery.text.trim() ? delivery.text : emptyText;
  const labels = presentation === undefined ? [] : [
    `Asked by ${presentation.requesterDisplayName ? escapeMarkdown(presentation.requesterDisplayName) : 'an allowed participant'}`,
    ...(presentation.continuation ? ["Continuing the room's conversation"] : []),
  ];
  const fallbackTitle = [title, ...labels].join(' — ');
  const create = (body: string, fallback: string, shortened: boolean) =>
    createMessage(title, body, fallback, shortened, labels, presentation?.replyToId);
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

function createMessage(title: string, text: string, fallbackText: string, shortened: boolean, labels: readonly string[], replyToId?: string): OutgoingTeamsMessage {
  const body: ITextBlock[] = [
    { type: 'TextBlock', text: title, weight: 'Bolder', wrap: true },
    ...labels.map((label): ITextBlock => ({ type: 'TextBlock', text: label, wrap: true, isSubtle: true })),
    { type: 'TextBlock', text, wrap: true },
  ];
  if (shortened) body.push({
    type: 'TextBlock',
    text: 'Reply shortened to fit the message limit.',
    wrap: true,
    isSubtle: true,
  });
  // Check the card separately: the SDK's general Attachment.content is any.
  const card: IAdaptiveCard = { type: 'AdaptiveCard', version: '1.4', fallbackText, body };
  return {
    type: 'message',
    ...(replyToId === undefined ? {} : { replyToId }),
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }],
  };
}
