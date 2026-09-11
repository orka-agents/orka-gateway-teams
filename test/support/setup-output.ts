// Separate process: an output spy must not swallow sibling tests' reporter IPC.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { startSetupCapture } from '../../src/setup/server.js';
import { activity, authFixture, post } from './ingress-auth.js';
import { setupFiles } from './setup.js';

test('private capture output boundary', async (t) => {
  const { config, challenge } = setupFiles(t); const auth = await authFixture(t);
  const stranger = await authFixture(t); const body = activity(); body.text = challenge;
  const token = auth.token({ appid: 'private-claim-marker' });
  const privateValues = [challenge, token, config.clientSecret, body.id, body.from.name, 'private-claim-marker'];
  const output: string[] = [];
  const out = t.mock.method(process.stdout, 'write', (value: unknown) => { output.push(String(value)); return true; });
  const err = t.mock.method(process.stderr, 'write', (value: unknown) => { output.push(String(value)); return true; });
  let success = false;
  try {
    const denied = await startSetupCapture(config, auth.dependencies); t.after(() => denied.stop());
    auth.setSdkKeys([{ ...stranger.key, kid: auth.key.kid }]);
    const rejection = await post(denied.port, token, body); const rejectedWire = await rejection.text(); await denied.stop();
    auth.setSdkKeys([auth.key]);
    const capture = await startSetupCapture(config, auth.dependencies); t.after(() => capture.stop());
    const response = await post(capture.port, token, body); const wire = await response.text(); await capture.done;
    const combined = output.join('') + wire + rejectedWire + readFileSync(config.captureFile, 'utf8');
    success = rejection.status === 401 && response.status === 200 && !privateValues.some((value) => combined.includes(value));
  } finally { out.mock.restore(); err.mock.restore(); }
  assert.equal(success, true);
  process.stdout.write('setup-output-verified\n');
});
