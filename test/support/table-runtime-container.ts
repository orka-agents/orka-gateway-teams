// Explicit Docker opt-in only; not matched by test/*.test.ts.
import test from 'node:test';
import { qualifyTableCli } from './table-runtime-cli.js';

test('compiled image Table CLI: native ACA/SDK/provider and clean restart on read-only nonroot containers', async t => {
  await qualifyTableCli(t, 'orka-gateway-teams:local');
});
