import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ConfigurationError } from './config.js';

export class LeaseRuntimeFailure extends Error {
  constructor(readonly category: 'lease-authority-lost' | 'lease-transition-uncertain') { super('Ingress storage failed'); }
}
export function readCaBundle(path: string): Buffer {
  try {
    const bytes = readFileSync(path);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const pem = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu;
    const certificates = text.match(pem);
    // Parse the entire bundle, not only the first certificate OpenSSL finds.
    if (!certificates?.length || !/^[\t\r\n ]*$/u.test(text.replace(pem, ''))) throw new ConfigurationError();
    for (const certificate of certificates) new X509Certificate(certificate);
    return bytes;
  } catch { throw new ConfigurationError(); }
}
