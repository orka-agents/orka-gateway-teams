import { identity } from '../delivery/identity.js';
import type { ReplyRoute } from '../ingress/types.js';
import type { MeetingDraft } from '../teams/meeting-draft.js';
import { safeMeetingLabel } from '../teams/meeting-card.js';
import type { MeetingAudience } from '../teams/meeting-card.js';

export const MAX_ROSTER_BYTES = 256 * 1024;
export interface MeetingMember { id: string; name?: string; userPrincipalName?: string; role?: string; type?: string }
export type MembersResult = { kind: 'members'; members: MeetingMember[] } | { kind: 'retryable' | 'unavailable' };
export type AttendeesResult = { kind: 'attendees'; upns: string[]; audience: MeetingAudience } | { kind: 'unavailable' };

/** Consume a single complete raw page. No address fallback, directory lookup or
 * SDK model conversion. Discard every unrelated field, including email. */
export function decodeMeetingMembers(response: { status: number; data: unknown }): MembersResult {
  if ([408, 429].includes(response.status) || response.status >= 500) return { kind: 'retryable' };
  try {
    if (response.status !== 200 || !(response.data instanceof Uint8Array) || response.data.byteLength > MAX_ROSTER_BYTES) invalid();
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(response.data));
    if (!record(value) || !Array.isArray(value.members) || value.members.length > 1000 ||
        (value.continuationToken !== undefined && value.continuationToken !== '')) invalid();
    const ids = new Set<string>();
    const members = value.members.map((member: unknown): MeetingMember => {
      if (!record(member)) invalid();
      const id = identity(member.id);
      // Duplicate records cannot prove a complete, unambiguous chat snapshot.
      if (ids.has(id)) invalid();
      ids.add(id);
      const fields: Partial<Omit<MeetingMember, 'id'>> = {};
      for (const key of ['name', 'userPrincipalName', 'role', 'type'] as const) {
        const text = member[key];
        if (text !== undefined) {
          if (typeof text !== 'string' || /[\uD800-\uDFFF]/u.test(text) || /\p{Cc}/u.test(text) || Buffer.byteLength(text) > 1024) invalid();
          fields[key] = text;
        }
      }
      return { id, ...fields };
    });
    return { kind: 'members', members };
  } catch { return { kind: 'unavailable' }; }
}

export function resolveMeetingAttendees(draft: MeetingDraft, route: Readonly<ReplyRoute>, members: readonly MeetingMember[]): AttendeesResult {
  const unavailable = { kind: 'unavailable' } as const;
  const people = members.filter(member => member.id !== route.bot.id &&
    (member.type === undefined || member.type === 'person') && (member.role === undefined || member.role === 'user'));
  // The personal roster must prove exactly one current user, not select a user
  // by address spelling or assume the bot is the current user.
  if (!people.length || (route.conversation.conversationType === 'personal' && people.length !== 1)) return unavailable;
  let selected = people;
  if (draft.attendees === 'named') {
    selected = [];
    for (const requested of draft.names!) {
      const matches = people.filter(member => member.name?.trim().toLowerCase() === requested.trim().toLowerCase());
      if (matches.length !== 1) return unavailable;
      selected.push(matches[0]!);
    }
  }
  const unique = new Map<string, MeetingMember>();
  for (const member of selected) {
    const upn = member.userPrincipalName;
    // UPN is a provider value, not a mail alias. Guests retain their exact
    // #EXT# spelling; commas/control/whitespace would change link recipients.
    if (typeof upn !== 'string' || /[\uD800-\uDFFF]/u.test(upn) || Buffer.byteLength(upn) > 1024 ||
        !/^[^@,\s\p{Cc}]+@[^@,\s\p{Cc}]+$/u.test(upn)) return unavailable;
    if (!unique.has(upn.toLowerCase())) unique.set(upn.toLowerCase(), member);
  }
  const deduped = [...unique.values()];
  return { kind: 'attendees', upns: deduped.map(member => member.userPrincipalName!), audience: {
    count: deduped.length, labels: route.conversation.conversationType === 'personal' ? ['You'] :
      deduped.slice(0, 10).map(member => safeMeetingLabel(member.name ?? 'a participant')),
  } };
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function invalid(): never { throw new Error('Invalid chat membership.'); }
