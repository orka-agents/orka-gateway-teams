import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { createTableDeliveryJournal } from '../../src/delivery/table-journal.js';
import { DeliveryJournalError } from '../../src/delivery/types.js';
import { fixtureProviderSender, providerServiceUrl } from './table-delivery-provider.js';
import { createDeliveryDispatcher } from '../../src/outbound/dispatcher.js';
import { finalDelivery } from '../fixtures/outgoing.js';

interface Config { tableUrl: string; tableCA: string; providerUrl: string; providerCA: string; mode: 'claim' | 'deliver' | 'replay' }
process.once('message', (input: Config) => { void run(input); });
async function run(config: Config) {
  const scope = { appId: 'App', tenantId: 'Tenant' }; const request = { ...finalDelivery, accountId: 'Tenant' };
  const journal = createTableDeliveryJournal({ account: 'Example123', table: 'Journal', storeId: 'stable', kind: 'delivery', scope }, {
    token: async () => 'synthetic.private.table.canary',
    request: ((url: URL, options: https.RequestOptions, callback: (response: IncomingMessage) => void) =>
      https.request(new URL(url.pathname + url.search, config.tableUrl), { ...options, hostname: '127.0.0.1', servername: 'localhost', ca: config.tableCA }, callback)) as typeof https.request,
  });
  const sender = fixtureProviderSender(config.providerUrl, config.providerCA, async () => 'synthetic.provider.token');
  const route = { serviceUrl: providerServiceUrl, channelId: 'msteams' as const, bot: { id: 'bot-fixture', role: 'bot' as const },
    conversation: { id: request.contextId, tenantId: scope.tenantId, conversationType: 'personal' as const } };
  const dispatcher = createDeliveryDispatcher({ journal, sender, scope, getRoute: () => route, serviceUrls: [providerServiceUrl], recipientIds: [route.bot.id] });
  try {
    await journal.open();
    const result = config.mode === 'claim' ? await journal.begin(request) : await dispatcher.deliver(request);
    // Install the handover command before publishing the milestone.
    const close = new Promise<void>(resolve => { process.once('message', () => resolve()); });
    process.send?.({ kind: 'result', result }); await close;
    await dispatcher.stop(); await journal.close(); process.send?.({ kind: 'closed' }); process.disconnect();
  } catch (error) {
    await dispatcher.stop().catch(() => undefined); await journal.close().catch(() => undefined);
    process.send?.({ kind: 'error', code: error instanceof DeliveryJournalError ? error.code : 'unavailable' }); process.disconnect();
  }
}
