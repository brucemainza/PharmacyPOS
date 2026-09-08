// Conflict resolution policy — see docs/architecture/system-architecture.md for the narrative version.
//
// - Append-only entities (ledgers/logs) never conflict: each row is inserted once by a
//   monotonic id and never updated, so a "conflict" here means the transport layer is
//   misusing this module, not a real data conflict — it's a bug to surface loudly.
// - Financial records are server-authoritative: the cloud's copy always wins on conflict,
//   since it's the reconciliation source of truth once a device has synced.
// - Everything else uses last-write-wins, merged per field using whichever side has the
//   newer `updatedAt` (or a per-field `fieldUpdatedAt` map, when present, for finer-grained
//   merges than a single record-level timestamp allows).

const APPEND_ONLY_ENTITIES = new Set([
  'stock_movements',
  'audit_log',
  'controlled_substance_log',
]);

const FINANCIAL_ENTITIES = new Set(['transactions', 'payments']);

export function resolveConflict(entityType, localPayload, remotePayload) {
  if (APPEND_ONLY_ENTITIES.has(entityType)) {
    throw new Error(
      `resolveConflict: "${entityType}" is append-only and should never conflict — each record is inserted once by a unique id, never updated`
    );
  }

  if (FINANCIAL_ENTITIES.has(entityType)) {
    return { winner: 'server', record: remotePayload };
  }

  return lastWriteWinsMerge(localPayload, remotePayload);
}

function lastWriteWinsMerge(localPayload, remotePayload) {
  const localUpdatedAt = localPayload.updatedAt || localPayload.updated_at || null;
  const remoteUpdatedAt = remotePayload.updatedAt || remotePayload.updated_at || null;

  const merged = { ...remotePayload };
  let tookAnyLocalField = false;

  for (const key of Object.keys(localPayload)) {
    const localFieldTs = localPayload.fieldUpdatedAt?.[key] ?? localUpdatedAt;
    const remoteFieldTs = remotePayload.fieldUpdatedAt?.[key] ?? remoteUpdatedAt;

    const localIsNewer =
      (localFieldTs && !remoteFieldTs) ||
      (localFieldTs && remoteFieldTs && new Date(localFieldTs) > new Date(remoteFieldTs));

    if (localIsNewer) {
      merged[key] = localPayload[key];
      tookAnyLocalField = true;
    }
  }

  const allLocal = Object.keys(localPayload).every(
    (key) => key === 'fieldUpdatedAt' || merged[key] === localPayload[key]
  );

  let winner;
  if (allLocal) winner = 'local';
  else if (!tookAnyLocalField) winner = 'server';
  else winner = 'merged';

  return { winner, record: merged };
}
