import { createSessionObservation } from '../src/delivery/session-correlation.js';
import type { SessionCorrelationPort, SessionObservation, SessionObservationResult } from '../src/delivery/session-correlation.js';
import { initializeSessionCorrelation, openSessionCorrelation } from '../src/delivery/sqlite-session-correlation.js';
import { createTableDeliveryJournal, createTableDeliveryJournalV2 } from '../src/delivery/table-journal.js';
import type { DeliveryJournal, JournalScope } from '../src/delivery/types.js';
import type { DeliveryRequest } from '../src/protocol/types.js';
import type { TableBinding, TableDependencies } from '../src/storage/table/types.js';

const project: (scope: JournalScope, request: Readonly<DeliveryRequest>) => SessionObservation | undefined = createSessionObservation;
const initialize: (path: string, scope: Readonly<JournalScope>) => void = initializeSessionCorrelation;
const sqlite: (path: string, scope: Readonly<JournalScope>, limits?: { maxSessions?: number }) =>
  SessionCorrelationPort & { close(): void } = openSessionCorrelation;
function tablePorts(binding: TableBinding, dependencies: TableDependencies): readonly SessionCorrelationPort[] {
  return [createTableDeliveryJournal(binding, dependencies), createTableDeliveryJournalV2(binding, dependencies)];
}
function legacy(journal: DeliveryJournal): void {
  // Correlation is supplied separately; existing DeliveryJournal implementors need no new member.
  // @ts-expect-error The public delivery journal contract is unchanged.
  journal.observeSession({ sessionDigest: '', originDigest: '' });
}
function exhaustive(result: SessionObservationResult): boolean {
  if (result.kind === 'full') return false;
  return result.continuation;
}
void [project, initialize, sqlite, tablePorts, legacy, exhaustive];
