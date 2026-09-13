import { Client } from '@microsoft/teams.common/http';
import { safeSdkLogger } from '../../src/ingress/logger.js';
import { createProviderSender } from '../../src/outbound/sender.js';

/** Keep the dispatcher's no-explicit-port route policy intact. Only the trusted
 * POST seam maps the validated logical host to an ephemeral native TLS listener;
 * sender serialization, auth, cancellation, SDK and socket I/O remain real. */
export const providerServiceUrl = 'https://localhost/';
export function fixtureProviderSender(baseUrl: string, ca: string | Buffer, token: () => Promise<string | undefined>) {
  const sdk = new Client({ logger: safeSdkLogger });
  return createProviderSender(token, { ca, post: (url, body, config) => {
    const original = new URL(url);
    if (original.origin !== 'https://localhost') throw new Error('Unexpected fixture provider host');
    return sdk.post(new URL(original.pathname + original.search, baseUrl).href, body, config);
  } });
}
