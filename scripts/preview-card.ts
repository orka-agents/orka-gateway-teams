import { finalMessage, errorMessage } from '../test/fixtures/outgoing.js';

const selection = process.argv[2] ?? 'final';
if (selection !== 'final' && selection !== 'error') {
  process.stderr.write('Usage: preview:card [final|error]\n');
  process.exit(1);
}
const message = selection === 'final' ? finalMessage : errorMessage;
process.stdout.write(`${JSON.stringify(message.attachments[0].content, null, 2)}\n`);
