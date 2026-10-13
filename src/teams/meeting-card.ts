import type { IAdaptiveCard, ITextBlock } from '@microsoft/teams.cards';
import { MAX_OUTGOING_MESSAGE_BYTES } from './format.js';
import type { OutgoingTeamsMessage, DeliveryPresentation } from './format.js';
import { meetingEnd } from './meeting-draft.js';
import type { MeetingDraft } from './meeting-draft.js';

export type MeetingUnavailable = 'disabled' | 'channel' | 'roster' | 'attendees' | 'link-too-long' | 'card-too-large';
const explanations: Record<MeetingUnavailable, string> = {
  disabled: 'Meeting drafts are disabled here. No meeting link is available.',
  channel: 'Meeting links are supported only in personal and group chats, not channels.',
  roster: 'The complete current chat membership could not be verified. No meeting link is available.',
  attendees: 'Every requested attendee must uniquely match a current chat member with a usable UPN. No meeting link is available.',
  'link-too-long': 'The complete meeting link is too long for the local safety limit. No partial link or recipient list was used.',
  'card-too-large': 'The complete meeting action exceeds the local message limit. No partial link or recipient list was used.',
};
export interface MeetingAudience { labels: readonly string[]; count: number }

/** Private, per-attempt link. Never journal, log, or return it as a V1 receipt. */
export function meetingLink(draft: MeetingDraft, upns: readonly string[]): string | undefined {
  const fields: [string, string][] = [['subject', draft.subject], ['attendees', upns.join(',')], ['content', draft.agenda.join('\n')]];
  if (draft.suggestedStart !== undefined) fields.push(['startTime', draft.suggestedStart], ['endTime', meetingEnd(draft.suggestedStart, draft.durationMinutes)]);
  const url = 'https://teams.microsoft.com/l/meeting/new?' + fields.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return url.length <= 2048 ? url : undefined;
}

/** A dedicated, fully measured card; the ordinary text formatter must not trim drafts. */
export function formatMeetingDraft(draft: MeetingDraft, audience: MeetingAudience, url?: string,
  presentation?: Readonly<DeliveryPresentation>, reason?: MeetingUnavailable): OutgoingTeamsMessage {
  const block = (text: string, subtle = false): ITextBlock => ({ type: 'TextBlock', text, wrap: true, ...(subtle ? { isSubtle: true } : {}) });
  const body: ITextBlock[] = [{ ...block('Meeting draft'), weight: 'Bolder' }];
  if (presentation) {
    body.push(block(`Asked by ${presentation.requesterDisplayName ? escapeMarkdown(safeMeetingLabel(presentation.requesterDisplayName)) : 'an allowed participant'}`, true));
    if (presentation.continuation) body.push(block("Continuing the room's conversation", true));
  }
  body.push(block(escapeMarkdown(draft.subject)), block(`Suggested duration: ${draft.durationMinutes} minutes`));
  if (draft.preferredWindow !== undefined) body.push(block(`Preferred window: ${escapeMarkdown(draft.preferredWindow)}`));
  if (draft.suggestedStart !== undefined) body.push(block(`Suggested start: ${draft.suggestedStart}\nSuggested end: ${meetingEnd(draft.suggestedStart, draft.durationMinutes)}`));
  body.push(block('Agenda:\n' + draft.agenda.map((item, i) => `${i + 1}. ${escapeMarkdown(item)}`).join('\n')));
  // Display-name lists are presentation only; count communicates the complete
  // snapshot. Never shorten the action's recipient list to make it fit.
  const labels = audience.labels.slice(0, 10).map(label => escapeMarkdown(safeMeetingLabel(label)));
  const requested = draft.attendees === 'named' ? `Requested attendees: ${draft.names!.map(escapeMarkdown).join(', ')}` : 'Requested attendees: everyone in this chat';
  body.push(block(requested));
  const create = (link: string | undefined, unavailable: MeetingUnavailable | undefined, showLabels = true): OutgoingTeamsMessage => {
    const audienceText = showLabels
      ? `Attendees (${audience.count}): ${labels.join(', ')}${audience.count > labels.length ? `; ${audience.count - labels.length} more participants` : ''}`
      : `Attendees (${audience.count}): display names omitted to fit the message limit.`;
    const card: IAdaptiveCard = { type: 'AdaptiveCard', version: '1.4',
      // Fixed bounded fallback, independent of user/roster labels and URL.
      fallbackText: 'Meeting draft. Nothing scheduled. Review the agenda, duration and time suggestions in Teams.' + (unavailable ? ' No meeting link is available.' : ''),
      body: [...body, ...(audience.count ? [block(audienceText)] : []),
        block('Nothing scheduled. Open in Teams to choose and confirm the final time and attendees. Duration and window are suggestions.', true),
        ...(unavailable ? [block(explanations[unavailable], true)] : [])],
      ...(link === undefined ? {} : { actions: [{ type: 'Action.OpenUrl', title: 'Open in Teams', url: link }] }) };
    return { type: 'message', ...(presentation?.replyToId === undefined ? {} : { replyToId: presentation.replyToId }),
      attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }] };
  };
  let message = create(reason ? undefined : url, reason);
  // Drop the entire auxiliary roster-label preview, not any structured draft
  // field or a subset of the action's recipients. Keep its complete count visible.
  if (Buffer.byteLength(JSON.stringify(message)) > MAX_OUTGOING_MESSAGE_BYTES) message = create(undefined, 'card-too-large', false);
  if (Buffer.byteLength(JSON.stringify(message)) > MAX_OUTGOING_MESSAGE_BYTES) throw new Error('Meeting card exceeds message limit.');
  return message;
}
export function safeMeetingLabel(label: string): string {
  return !label.trim() || /[\uD800-\uDFFF]/u.test(label) || /[@\p{Cc}]/u.test(label) || Buffer.byteLength(label) > 256 ? 'a participant' : label;
}
function escapeMarkdown(label: string): string { return label.replace(/[\\`*_{}\[\]()<>#+\-.!|~]/gu, '\\$&'); }
