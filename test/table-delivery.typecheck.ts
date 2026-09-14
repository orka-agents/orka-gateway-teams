import { audit, decodeAlias, decodeOperation } from '../src/delivery/table-codec.js';
import { createTableDeliveryJournal, createTableDeliveryJournalV2 } from '../src/delivery/table-journal.js';
import type { TableDeliveryJournalLimits } from '../src/delivery/table-journal.js';
import type { DeliveryJournalPort } from '../src/delivery/types.js';
import type { StoredRecord, StoredRecordV2, TableBinding, TableDependencies } from '../src/storage/table/types.js';

// The legacy exported signatures remain usable, including parameter introspection.
declare const aliasArgument: Parameters<typeof decodeAlias>[0];
declare const operationArgument: Parameters<typeof decodeOperation>[0];
declare const auditArgument: Parameters<typeof audit>[0];
const legacyAlias: StoredRecord = aliasArgument;
const legacyOperation: StoredRecord = operationArgument;
const legacyAudit: readonly StoredRecord[] = auditArgument;

declare const v2: StoredRecordV2;
decodeAlias(v2); decodeOperation(v2, 2);
declare const binding: TableBinding;
declare const dependencies: TableDependencies;
declare const limits: TableDeliveryJournalLimits;
const v1Port: DeliveryJournalPort = createTableDeliveryJournal(binding, dependencies, limits);
const v2Port: DeliveryJournalPort = createTableDeliveryJournalV2(binding, dependencies, limits);
// @ts-expect-error Format is not a public limit/selector on either factory.
createTableDeliveryJournalV2(binding, dependencies, { format: 2 });
