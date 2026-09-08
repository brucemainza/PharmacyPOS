import { resolveConflict } from './conflict.js';

function getCursor(db, entityType) {
  const row = db
    .prepare('SELECT last_pulled_at FROM sync_cursor WHERE entity_type = ?')
    .get(entityType);
  return row ? row.last_pulled_at : null;
}

function saveCursor(db, entityType, cursor) {
  const existing = db
    .prepare('SELECT entity_type FROM sync_cursor WHERE entity_type = ?')
    .get(entityType);
  if (existing) {
    db.prepare('UPDATE sync_cursor SET last_pulled_at = ? WHERE entity_type = ?').run(
      cursor,
      entityType
    );
  } else {
    db.prepare('INSERT INTO sync_cursor (entity_type, last_pulled_at) VALUES (?, ?)').run(
      entityType,
      cursor
    );
  }
}

// Pulls remote changes for one entity type since the last saved cursor. If a remote change
// collides with a not-yet-synced local outbox entry for the same entity, resolves it via
// conflict.js rather than blindly overwriting the pending local write.
export async function pullRemote(db, transport, entityType) {
  const cursor = getCursor(db, entityType);
  const { changes = [], nextCursor } = await transport.pull(entityType, cursor);

  const resolved = changes.map((remote) => {
    const localPending = db
      .prepare(
        `SELECT * FROM sync_outbox
         WHERE entity_type = ? AND entity_id = ? AND synced = 0
         ORDER BY id DESC LIMIT 1`
      )
      .get(entityType, String(remote.id));

    if (!localPending) {
      return { entityId: remote.id, resolution: 'remote-applied', record: remote };
    }

    const localPayload = JSON.parse(localPending.payload_json);
    const decision = resolveConflict(entityType, localPayload, remote);
    return { entityId: remote.id, resolution: decision.winner, record: decision.record };
  });

  if (nextCursor !== undefined) {
    saveCursor(db, entityType, nextCursor);
  }

  return resolved;
}
