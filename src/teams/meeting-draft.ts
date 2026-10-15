export interface MeetingDraft {
  subject: string;
  agenda: string[];
  durationMinutes: number;
  attendees: 'everyone' | 'named';
  names?: string[];
  preferredWindow?: string;
  suggestedStart?: string;
}

/** Decode only the controller's closed projection. No text parsing or adapter normalization. */
export function decodeMeetingDraft(metadata?: Readonly<Record<string, string>>): MeetingDraft | undefined {
  const keys = Object.keys(metadata ?? {}).filter(key => key.startsWith('meeting.'));
  if (!keys.length) return undefined;
  const m = metadata!;
  const fixed = ['meeting.version', 'meeting.subject', 'meeting.durationMinutes', 'meeting.attendees', 'meeting.preferredWindow', 'meeting.suggestedStart'];
  if (keys.some(key => !fixed.includes(key) && !/^meeting\.(agenda\.[0-4]|name\.[0-9])$/u.test(key)) || m['meeting.version'] !== '1') invalid();
  const subject = draftString(m['meeting.subject'], 200);
  const duration = m['meeting.durationMinutes'];
  if (typeof duration !== 'string' || !/^[1-9]\d{0,2}$/u.test(duration) || Number(duration) > 480) invalid();
  const agenda = sequence(m, 'agenda', 5, 256);
  if (!agenda.length) invalid();
  const attendees = m['meeting.attendees'];
  const names = sequence(m, 'name', 10, 128);
  if (attendees !== 'everyone' && attendees !== 'named') invalid();
  if (attendees === 'everyone' ? names.length !== 0 : names.length === 0 || names.some(name => name.includes('@'))) invalid();
  const preferredWindow = m['meeting.preferredWindow'] === undefined ? undefined : draftString(m['meeting.preferredWindow'], 256);
  const suggestedStart = m['meeting.suggestedStart'];
  if (suggestedStart !== undefined) meetingEnd(suggestedStart, Number(duration));
  return { subject, agenda, durationMinutes: Number(duration), attendees,
    ...(attendees === 'named' ? { names } : {}), ...(preferredWindow === undefined ? {} : { preferredWindow }),
    ...(suggestedStart === undefined ? {} : { suggestedStart }) };
}

function sequence(m: Readonly<Record<string, string>>, field: string, max: number, bytes: number): string[] {
  const result: string[] = [];
  let gap = false;
  for (let i = 0; i < max; i++) {
    const value = m[`meeting.${field}.${i}`];
    if (value === undefined) gap = true;
    else { if (gap) invalid(); result.push(draftString(value, bytes)); }
  }
  return result;
}
function draftString(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || /[\uD800-\uDFFF]/u.test(value) || /\p{Cc}/u.test(value) || Buffer.byteLength(value) > max) invalid();
  return value;
}

/** Calculate in the supplied fixed offset, retaining nanosecond spelling. JS Date's
 * relaxed calendar parser and millisecond rounding are not the wire contract. */
export function meetingEnd(start: string, duration: number): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-](?:0\d|1\d|2[0-3]):[0-5]\d)$/u.exec(start);
  if (!parts || !Number.isInteger(duration) || duration < 1 || duration > 480) invalid();
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) invalid();
  const date = new Date(0); date.setUTCFullYear(year, month - 1, day); date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) invalid();
  date.setUTCMinutes(date.getUTCMinutes() + duration);
  if (date.getUTCFullYear() > 9999) invalid();
  return date.toISOString().slice(0, 19) + (parts[7] ?? '') + parts[8]!;
}
function invalid(): never { throw new Error('Invalid meeting draft.'); }
