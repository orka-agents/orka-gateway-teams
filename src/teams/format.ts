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

/**
 * Deterministic, non-mutating formatting of an already-validated delivery.
 * Budget the complete serialized message, not just text.
 * Destination, persistence, credentials, sending, and retries belong to the caller.
 */
export type FormatDelivery = (delivery: Readonly<DeliveryRequest>) => OutgoingTeamsMessage;

const MAX_FALLBACK_BYTES = 512;
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

export const formatDelivery: FormatDelivery = (delivery) => {
  const title = delivery.kind === 'final' ? 'Orka reply' : 'Orka could not complete the request';
  const emptyText = delivery.kind === 'final'
    ? 'Orka finished without a text reply.'
    : 'This request could not be completed.';
  const text = delivery.text.trim() ? delivery.text : emptyText;
  const full = createMessage(title, text, formatFallback(title, text, false), false);
  if (messageBytes(full) <= MAX_OUTGOING_MESSAGE_BYTES) return full;

  // Keep the fallback and notice fixed so serialized size grows monotonically
  // with the retained prefix, including JSON escaping and the activity envelope.
  const fallback = formatFallback(title, text, true);
  const boundaries = [0];
  for (const { index, segment } of segmenter.segment(text)) {
    boundaries.push(index + segment.length);
  }
  let low = 0;
  let high = boundaries.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = createMessage(title, text.slice(0, boundaries[middle]!), fallback, true);
    if (messageBytes(candidate) <= MAX_OUTGOING_MESSAGE_BYTES) low = middle;
    else high = middle - 1;
  }
  // Boundary zero always fits: a giant first grapheme leaves the title and
  // shortening notice readable without splitting that grapheme or overflowing.
  return createMessage(title, text.slice(0, boundaries[low]!), fallback, true);
};

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

function createMessage(title: string, text: string, fallbackText: string, shortened: boolean): OutgoingTeamsMessage {
  const body: ITextBlock[] = [
    { type: 'TextBlock', text: title, weight: 'Bolder', wrap: true },
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
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }],
  };
}
