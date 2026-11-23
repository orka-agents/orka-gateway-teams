import type { CardElement, IAdaptiveCard, ITextBlock } from '@microsoft/teams.cards';
import { MAX_OUTGOING_MESSAGE_BYTES } from './format.js';
import type { OutgoingTeamsMessage, DeliveryPresentation } from './format.js';
import { meetingEnd } from './meeting-draft.js';
import type { MeetingDraft } from './meeting-draft.js';

export type MeetingUnavailable = 'disabled' | 'channel' | 'roster' | 'attendees' | 'link-too-long' | 'card-too-large';
const explanations: Record<MeetingUnavailable, string> = {
  disabled: 'Meeting drafts are turned off here, so there is no meeting link.',
  channel: 'Meeting links work only in personal and group chats, not channels.',
  roster: "Couldn't confirm who is in this chat, so there is no meeting link. Create the meeting in Teams yourself.",
  attendees: "Couldn't match every requested attendee to one person in this chat, so there is no meeting link.",
  'link-too-long': 'The full meeting link is too long, so there is no link. No partial attendee list was used.',
  'card-too-large': "The full meeting link doesn't fit in one message, so there is no link. No partial attendee list was used.",
};
/** `labels` are matched chat members. `notFound` are requested names that matched no single member. */
export interface MeetingAudience { labels: readonly string[]; count: number; personal?: true; notFound?: readonly string[] }

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
  const line = (text: string, style: Partial<ITextBlock> = {}): ITextBlock => ({ type: 'TextBlock', text, wrap: true, ...style });
  const note: Partial<ITextBlock> = { isSubtle: true, size: 'Small' };
  const asked = presentation === undefined ? '' :
    ` · asked by ${presentation.requesterDisplayName ? escapeMarkdown(safeMeetingLabel(presentation.requesterDisplayName)) : 'an allowed participant'}${presentation.continuation ? ' · continuing this chat' : ''}`;
  // The viewer's Teams client turns DATE and TIME into its own local time; they take whole seconds.
  const local = (time: string) => time.replace(/\.\d+/u, '');
  // A suggested time already says the length; a range alone needs it.
  const when = draft.suggestedStart !== undefined ? [{ title: 'When',
    value: `{{DATE(${local(draft.suggestedStart)}, SHORT)}} {{TIME(${local(draft.suggestedStart)})}}–{{TIME(${local(meetingEnd(draft.suggestedStart, draft.durationMinutes))})}} (suggested)` }] :
    [...(draft.preferredWindow === undefined ? [] : [{ title: 'When', value: escapeMarkdown(draft.preferredWindow) }]), { title: 'Length', value: `${draft.durationMinutes} min` }];
  // Display-name lists are presentation only; count communicates the complete
  // snapshot. Never shorten the action's recipient list to make it fit.
  const labels = audience.labels.slice(0, 10).map(label => escapeMarkdown(safeMeetingLabel(label)));
  const notFound = (audience.notFound ?? []).map(escapeMarkdown);
  const create = (link: string | undefined, unavailable: MeetingUnavailable | undefined, showLabels = true): OutgoingTeamsMessage => {
    const everyone = `Everyone here${audience.count ? ` (${audience.count})` : ''}` + (!audience.count ? '' : !showLabels ? '; names left out to fit the message limit' :
      `: ${labels.join(', ')}${audience.count > labels.length ? `; ${audience.count - labels.length} more` : ''}`);
    // Named people are shown as the chat members they matched. Without a member list the request's own names are all there is.
    const named = () => !labels.length && !notFound.length ? draft.names!.map(escapeMarkdown).join(', ') :
      [...(!labels.length ? [] : [showLabels ? labels.join(', ') : `${audience.count} matched; names left out to fit the message limit`]),
        ...(notFound.length ? [`not found: ${notFound.join(', ')}`] : [])].join('; ');
    const who = audience.personal ? 'Just you. Add people in Teams.' : draft.attendees === 'named' ? named() : everyone;
    const body: CardElement[] = [line(`Meeting draft${asked}`, { ...note, spacing: 'None' }), line(escapeMarkdown(draft.subject), { weight: 'Bolder', size: 'Medium', spacing: 'Small' }),
      // Names nobody could confirm are left out: the member list wasn't read, or it gave nothing to match them against.
      { type: 'FactSet', spacing: 'Small', facts: [...when, ...(unavailable === 'roster' || unavailable === 'attendees' && draft.attendees === 'named' && !labels.length && !notFound.length ? [] : [{ title: 'Who', value: who }])] },
      line('Agenda', { weight: 'Bolder', size: 'Small', spacing: 'Medium' }),
      line(draft.agenda.map((item, i) => `${i + 1}. ${escapeMarkdown(item)}`).join('\n'), { spacing: 'Small' }),
      line(link === undefined ? `Nothing is scheduled. ${unavailable ? explanations[unavailable] : 'This draft has no meeting link.'}`
        : 'Nothing is scheduled until you open it in Teams and send it.', { ...note, spacing: 'Medium' })];
    const card: IAdaptiveCard = { type: 'AdaptiveCard', version: '1.4',
      // Fixed bounded fallback, independent of user/roster labels and URL.
      fallbackText: 'Meeting draft. Nothing scheduled. Review the agenda, duration and time suggestions in Teams.' + (unavailable ? ' No meeting link is available.' : ''), body,
      ...(link === undefined ? {} : { actions: [{ type: 'Action.OpenUrl', title: 'Open in Teams', style: 'positive', url: link }] }) };
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
