import test from 'node:test';
import { qualifyTableCli } from './support/table-runtime-cli.js';

test('actual freshly compiled Table CLI: native ACA/authenticated SDK/provider, clean process handover and replay', async t => {
  await qualifyTableCli(t);
});
