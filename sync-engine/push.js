import { getPending, markSynced } from './outbox.js';

// Pushes queued outbox entries to the cloud sync API. `transport.push` is injected so this
// module has no direct HTTP dependency — see httpTransport.js for the real implementation and
// __tests__ for a fake used in unit tests. A transport failure (network down, non-2xx) leaves
// the rows unsynced so the next sync pass retries them — safe by construction since each row
// carries its own idempotency key and pushing an already-accepted row again is a no-op for the
// server.
export async function pushPending(db, transport, { batchSize = 50 } = {}) {
  const pending = getPending(db, batchSize);
  if (pending.length === 0) {
    return { attempted: 0, pushed: 0, conflicts: [] };
  }

  const records = pending.map((row) => ({
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    op: row.op,
    payload: JSON.parse(row.payload_json),
    idempotencyKey: row.idempotency_key,
  }));

  let result;
  try {
    result = await transport.push(records);
  } catch (err) {
    return { attempted: records.length, pushed: 0, conflicts: [], error: err.message };
  }

  const accepted = result.accepted || [];
  markSynced(db, accepted);

  return {
    attempted: records.length,
    pushed: accepted.length,
    conflicts: result.conflicts || [],
  };
}
