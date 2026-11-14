import assert from 'node:assert/strict';
import { createAccountStore } from '../../src/accounts/store.js';
import { grantReference } from '../../src/accounts/grants.js';
import { binding, context, directoryFixture } from './directory-table.js';
const epoch = 1_800_000_000_000;
const target = { id: 'tools', identityDigest: 'a'.repeat(64) };
export async function grantsFixture(t: Parameters<typeof directoryFixture>[0]) {
  const f = await directoryFixture(t); let clock = epoch; let allowed = true;
  const authority = { allowed: () => allowed, revalidate: async () => allowed, lost: new AbortController().signal };
  const open = () => { const s = createAccountStore(binding, Buffer.alloc(32, 7), f.dependencies, authority, () => clock); t.after(() => s.close()); return s; };
  const store = open(); const subject = { objectId: 'sender-private' };
  const link = async (id = 'sign-in') => {
    const ch = await store.challenge(subject, 'chat-private', id, context());
    assert.equal(await store.claim(ch, context()), 'claimed');
    assert.equal(await store.complete(ch, { accessToken: 'ACCESS-PRIVATE', expiresAt: clock + 100_000, refreshToken: 'REFRESH-PRIVATE' }, context()), true);
  };
  await link();
  const input = { ref: grantReference(binding, target, 'event-private'), ...subject, generation: 1, provider: 'workiq' as const,
    targetId: target.id, targetDigest: target.identityDigest, eventId: 'event-private', tools: ['workiq'] };
  return { ...f, store, open, subject, input, link, authority, now: () => clock, advance: (n: number) => { clock += n; }, revoke: () => { allowed = false; } };
}
