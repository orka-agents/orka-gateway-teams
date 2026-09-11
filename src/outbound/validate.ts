import { requestIdentity, validateScope } from '../delivery/identity.js';
import type { JournalScope } from '../delivery/types.js';
import { MAX_HTTP_BODY_BYTES } from '../protocol/types.js';
import type { DeliveryRequest } from '../protocol/types.js';

export function snapshotDelivery(value: unknown, scope: Readonly<JournalScope>): DeliveryRequest {
  try {
    // The journal's pure validator rejects accessors, unknown fields and foreign
    // prototypes before serialization can execute them. Keep its fingerprint rules.
    requestIdentity(value, validateScope(scope));
    const request = value as DeliveryRequest;
    if (!request.text || Object.keys(request.metadata ?? {}).some((key) => !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(key))) invalid();
    const json = JSON.stringify(request);
    if (Buffer.byteLength(json) > MAX_HTTP_BODY_BYTES) invalid();
    const snapshot = JSON.parse(json) as DeliveryRequest;
    if (snapshot.taskRef) Object.freeze(snapshot.taskRef);
    if (snapshot.sessionRef) Object.freeze(snapshot.sessionRef);
    if (snapshot.metadata) Object.freeze(snapshot.metadata);
    return Object.freeze(snapshot);
  } catch { return invalid(); }
}

export function decodeDelivery(body: Uint8Array, scope: Readonly<JournalScope>): DeliveryRequest {
  try {
    if (!(body instanceof Uint8Array) || body.byteLength > MAX_HTTP_BODY_BYTES) invalid();
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
    return snapshotDelivery(JSON.parse(text) as unknown, scope);
  } catch { return invalid(); }
}

function invalid(): never { throw new Error('Invalid delivery request.'); }
