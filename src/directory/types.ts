import type { TableDependencies } from '../storage/table/types.js';

export interface DirectoryScope { appId: string; tenantId: string }
export type DirectoryKey = { kind: 'conn'; conversationId: string } | { kind: 'control'; conversationId: string; activityId: string };
export type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };
export interface BindingEvidence {
  namespace: string; name: string; uid: string; generation: number;
  spec: { [key: string]: CanonicalValue };
}
interface RecordBase { schema: 1; scope: DirectoryScope; conversationId: string; chatKind: 'personal' | 'groupChat' }
export type ConnectionRecord = RecordBase & {
  kind: 'conn'; targetId: string; identityDigest: string; bindingName: string;
  lineage: { kind: 'provisioner' } | { kind: 'imported'; importId: string };
} & ({ state: 'reserved'; binding?: never } | { state: 'provisioned'; binding: BindingEvidence });
export interface ControlRoute {
  serviceUrl: string; channelId: 'msteams'; bot: { id: string; role: 'bot' };
  conversation: { id: string; tenantId: string; conversationType: 'personal' | 'groupChat' };
}
export type ControlReply = { kind: 'no-access' } | { kind: 'discovery'; targets: { id: string; label: string }[] } |
  { kind: 'connected' | 'switching'; targetId: string; label: string };
export type ControlRecord = RecordBase & {
  kind: 'control'; activityId: string; fingerprint: string;
  currentTargetDigest: string | null; desiredTargetDigest: string | null;
  route: ControlRoute; reply: ControlReply;
} & ({ state: 'ready'; ownerUUID?: never; attemptUUID?: never } |
   { state: 'armed' | 'rejected' | 'unknown'; ownerUUID: string; attemptUUID: string } |
   { state: 'delivered'; ownerUUID: string; attemptUUID: string; providerMessageId: string });
export type DirectoryRecord = ConnectionRecord | ControlRecord;
export interface DirectoryRow { key: DirectoryKey; row: string; etag: string; timestamp: string; value: DirectoryRecord }
export interface DirectoryContext { signal: AbortSignal; deadline: number; authorizeWrite?: () => boolean }
/** An ACK is not commit proof; every mutation outcome still needs exact read-back. */
export type DirectoryWriteResult = { kind: 'ack' | 'conflict' | 'uncertain' };
export interface DirectoryTable {
  get(key: DirectoryKey, context: DirectoryContext): Promise<DirectoryRow | undefined>;
  insert(key: DirectoryKey, value: DirectoryRecord, context: DirectoryContext): Promise<DirectoryWriteResult>;
  replace(key: DirectoryKey, etag: string, value: DirectoryRecord, context: DirectoryContext): Promise<DirectoryWriteResult>;
  list(context: DirectoryContext, armedOnly?: boolean): Promise<DirectoryRow[]>;
  close(): Promise<void>;
}
export type DirectoryDependencies = Pick<TableDependencies, 'token' | 'request'>;
export type DirectoryBinding = DirectoryScope & { account: string; table: string };
export class DirectoryError extends Error {
  constructor(readonly code: 'invalid-input' | 'conflict' | 'corrupt' | 'unavailable' | 'unready' | 'busy' | 'closed') {
    super(`Directory storage: ${code}`); this.name = 'DirectoryError';
  }
}
