import { randomBytes } from 'node:crypto';
import { Client } from '@microsoft/teams.common/http';
import { openDeliveryJournal } from '../../src/delivery/journal.js';
import { safeSdkLogger } from '../../src/ingress/logger.js';
import { createDeliveryDispatcher } from '../../src/outbound/dispatcher.js';
import { createProviderSender } from '../../src/outbound/sender.js';
import { finalDelivery } from '../fixtures/outgoing.js';

const path = process.argv[2]!; const providerBase = process.argv[3]!;
process.once('message', async (message: { ca: string }) => {
  const scope = { appId: 'app-fixture', tenantId: finalDelivery.accountId };
  const journal = openDeliveryJournal(path, scope);
  const client = new Client({ logger: safeSdkLogger });
  const sender = createProviderSender(async () => randomBytes(24).toString('base64url'), { ca: message.ca,
    post: (url, body, config) => client.post(new URL(new URL(url).pathname.slice(1), providerBase).href, body, config) });
  const dispatcher = createDeliveryDispatcher({ journal, scope, serviceUrls: ['https://smba.trafficmanager.net/teams/'], recipientIds: ['bot-fixture'], sender,
    getRoute: () => ({ serviceUrl: 'https://smba.trafficmanager.net/teams/', channelId: 'msteams', bot: { id: 'bot-fixture', role: 'bot' },
      conversation: { id: finalDelivery.contextId, conversationType: 'personal', tenantId: scope.tenantId } }) });
  await dispatcher.deliver(finalDelivery);
  await dispatcher.stop(); journal.close(); process.disconnect();
});
