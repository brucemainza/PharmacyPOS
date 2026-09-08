// Postgres-backed store (Phase 5). Same push/pull/conflict semantics as the earlier in-memory
// version this replaces: an idempotency key makes a retried push a safe no-op, and a conflict is
// reported (never silently overwritten) when the incoming update's declared base version is
// behind the server's current version for that record.
import { getPool } from './db.js';

export async function applyPush(records) {
  const pool = getPool();
  const accepted = [];
  const conflicts = [];

  for (const record of records) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const already = await client.query(
        'SELECT 1 FROM sync_idempotency WHERE idempotency_key = $1',
        [record.idempotencyKey]
      );
      if (already.rowCount > 0) {
        accepted.push(record.id);
        await client.query('COMMIT');
        continue;
      }

      const existingRes = await client.query(
        'SELECT payload, version FROM sync_records WHERE entity_type = $1 AND entity_id = $2 FOR UPDATE',
        [record.entityType, String(record.entityId)]
      );
      const existing = existingRes.rows[0];

      if (existing && record.op === 'update' && existing.version > (record.payload.__baseVersion ?? -1)) {
        conflicts.push({
          id: record.id,
          entityType: record.entityType,
          entityId: record.entityId,
          serverRecord: { id: record.entityId, ...existing.payload, __version: existing.version },
        });
        await client.query('COMMIT');
        continue;
      }

      const nextVersion = (existing?.version ?? 0) + 1;
      const payload = { ...record.payload, updatedAt: new Date().toISOString() };
      await client.query(
        `INSERT INTO sync_records (entity_type, entity_id, payload, version, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (entity_type, entity_id)
         DO UPDATE SET payload = $3, version = $4, updated_at = now()`,
        [record.entityType, String(record.entityId), payload, nextVersion]
      );
      await client.query(
        'INSERT INTO sync_idempotency (idempotency_key, entity_type, entity_id) VALUES ($1, $2, $3)',
        [record.idempotencyKey, record.entityType, String(record.entityId)]
      );

      await client.query('COMMIT');
      accepted.push(record.id);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return { accepted, conflicts };
}

export async function getChangesSince(entityType, cursor) {
  const pool = getPool();
  const result = cursor
    ? await pool.query(
        'SELECT entity_id, payload, version, updated_at FROM sync_records WHERE entity_type = $1 AND updated_at > $2 ORDER BY updated_at ASC',
        [entityType, cursor]
      )
    : await pool.query(
        'SELECT entity_id, payload, version, updated_at FROM sync_records WHERE entity_type = $1 ORDER BY updated_at ASC',
        [entityType]
      );

  const changes = result.rows.map((row) => ({
    id: row.entity_id,
    ...row.payload,
    __version: row.version,
  }));
  const nextCursor =
    result.rows.length > 0 ? result.rows[result.rows.length - 1].updated_at.toISOString() : cursor || null;

  return { changes, nextCursor };
}
