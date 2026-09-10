import { formatDelivery } from '../src/teams/format.js';
import { finalDelivery, errorDelivery, oversizedDelivery } from '../test/fixtures/outgoing.js';

const selection = process.argv[2] ?? 'final';
if (selection !== 'final' && selection !== 'error' && selection !== 'oversized') {
  process.stderr.write('Usage: preview:card [final|error|oversized]\n');
  process.exit(1);
}
const deliveries = { final: finalDelivery, error: errorDelivery, oversized: oversizedDelivery };
const message = formatDelivery(deliveries[selection]);
process.stdout.write(`${JSON.stringify(message.attachments[0].content, null, 2)}\n`);
