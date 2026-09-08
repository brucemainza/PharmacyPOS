import crypto from 'crypto';

// Queues a local write for later push to the cloud sync API. Call this inside the same
// db.transaction() as the domain write it describes, so the outbox entry and the write it
// represents commit or roll back together.
export function enqueueSync(db, entityType, entityId, op, payload) {
  const idempotencyKey = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO sync_outbox (entity_type, entity_id, op, payload_json, idempotency_key, created_at, synced)
       VALUES (?, ?, ?, ?, ?, ?, 0)`
    )
    .run(entityType, String(entityId), op, JSON.stringify(payload), idempotencyKey, createdAt);
  return result.lastInsertRowid;
}

export function getPending(db, limit = 50) {
  return db
    .prepare('SELECT * FROM sync_outbox WHERE synced = 0 ORDER BY id ASC LIMIT ?')
    .all(limit);
}

export function markSynced(db, ids) {
  if (!ids.length) return;
  const now = new Date().toISOString();
  const stmt = db.prepare('UPDATE sync_outbox SET synced = 1, synced_at = ? WHERE id = ?');
  for (const id of ids) stmt.run(now, id);
}

export function pendingCount(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM sync_outbox WHERE synced = 0').get().c;
}
