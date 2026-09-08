import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, cleanupDb } from './testHelpers.js';
import { enqueueSync, getPending, markSynced, pendingCount } from './outbox.js';

test('enqueueSync writes a pending row with a unique idempotency key', async () => {
  const { db, file } = await freshDb();
  try {
    const id1 = enqueueSync(db, 'products', 1, 'update', { name: 'Paracetamol' });
    const id2 = enqueueSync(db, 'products', 2, 'insert', { name: 'Amoxicillin' });

    assert.notEqual(id1, id2);
    assert.equal(pendingCount(db), 2);

    const rows = db.prepare('SELECT idempotency_key FROM sync_outbox ORDER BY id').all();
    assert.notEqual(rows[0].idempotency_key, rows[1].idempotency_key);
  } finally {
    cleanupDb(file);
  }
});

test('getPending returns unsynced rows in monotonic order, respecting limit', async () => {
  const { db, file } = await freshDb();
  try {
    for (let i = 0; i < 5; i++) {
      enqueueSync(db, 'products', i, 'update', { i });
    }
    const page = getPending(db, 3);
    assert.equal(page.length, 3);
    assert.deepEqual(
      page.map((r) => r.id),
      [...page.map((r) => r.id)].sort((a, b) => a - b)
    );
  } finally {
    cleanupDb(file);
  }
});

test('markSynced flips synced flag and stamps synced_at, excluding rows from getPending', async () => {
  const { db, file } = await freshDb();
  try {
    const id = enqueueSync(db, 'products', 1, 'update', { name: 'Paracetamol' });
    markSynced(db, [id]);

    const row = db.prepare('SELECT * FROM sync_outbox WHERE id = ?').get(id);
    assert.equal(row.synced, 1);
    assert.ok(row.synced_at);
    assert.equal(pendingCount(db), 0);
    assert.equal(getPending(db).length, 0);
  } finally {
    cleanupDb(file);
  }
});
