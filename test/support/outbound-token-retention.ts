import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createProviderSender } from '../../src/outbound/sender.js';
import { formatDelivery } from '../../src/teams/format.js';
import { finalDelivery } from '../fixtures/outgoing.js';

// Isolate Buffer accounting and explicit GC from the test runner and TLS fixtures.
assert.ok(globalThis.gc);
const message = formatDelivery({ ...finalDelivery, text: 'x'.repeat(64 * 1024) });
const bodyBytes = Buffer.byteLength(JSON.stringify(message));
const route = { serviceUrl: 'https://smba.trafficmanager.net/teams/', channelId: 'msteams', bot: { id: 'bot-fixture', role: 'bot' },
  conversation: { id: finalDelivery.contextId, conversationType: 'personal', tenantId: finalDelivery.accountId } } as const;
let release!: () => void;
const token = new Promise<undefined>((resolve) => { release = () => resolve(undefined); });
let acquisitions = 0; let posts = 0; let tokenSettled = false;
void token.then(() => { tokenSettled = true; });
const sender = createProviderSender(() => { acquisitions++; return token; }, { post: async () => { posts++; return { status: 500, data: Buffer.alloc(0) }; } });

async function retainedBytes() {
  // Unwind completed caller stacks and promise reactions before forcing GC.
  await setImmediate(); globalThis.gc!(); globalThis.gc!();
  return process.memoryUsage().arrayBuffers;
}
async function cancelBatch() {
  for (let i = 0; i < 1000; i++) {
    const abort = new AbortController();
    const pending = sender.send(route, message, { signal: abort.signal }); abort.abort();
    assert.deepEqual(await pending, { kind: 'retryable' });
  }
}

try {
  const baseline = await retainedBytes();
  await cancelBatch(); const after1000 = await retainedBytes() - baseline;
  await cancelBatch(); const after2000 = await retainedBytes() - baseline;
  const beforeRelease = { bodyBytes, acquisitions, posts, tokenSettled, after1000, after2000 };
  release(); await sender.stop();
  const afterDrain = await retainedBytes() - baseline;
  process.send!({ ...beforeRelease, afterDrain, postsAfterDrain: posts });
} finally { release(); await sender.stop(); process.disconnect(); }
