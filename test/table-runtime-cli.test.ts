import test from 'node:test';
import { qualifyTableCli } from './support/table-runtime-cli.js';

test('actual freshly compiled Table CLI: native ACA/authenticated SDK/provider, clean process handover and replay', async t => {
  await qualifyTableCli(t);
});
test('compiled V3 commands: explicit upgrades, mixed-store refusal, recovery, native sends and retained replay', async t => {
  await qualifyTableCli(t, undefined, 'table-v3');
});
test('compiled serve-registry: legacy native send/replay, no Kubernetes credential, config refusal and SIGTERM drain', async t => {
  await qualifyTableCli(t, undefined, 'table-v3', true);
});
