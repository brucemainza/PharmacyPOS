import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, cleanupDb } from './testHelpers.js';
import { enqueueSync, getPending } from './outbox.js';
import { pushPending } from './push.js';

test('pushPending marks accepted rows synced and reports the count', async () => {
  const { db, file } = await freshDb();
  try {
    const id1 = enqueueSync(db, 'products', 1, 'update', { name: 'A' });
    const id2 = enqueueSync(db, 'products', 2, 'update', { name: 'B' });

    const transport = {
      push: async (records) => {
        assert.equal(records.length, 2);
        return { accepted: [id1, id2], conflicts: [] };
      },
    };

    const result = await pushPending(db, transport);
    assert.equal(result.attempted, 2);
    assert.equal(result.pushed, 2);
    assert.equal(getPending(db).length, 0);
  } finally {
    cleanupDb(file);
  }
});

test('pushPending leaves rows pending when the transport rejects/omits them', async () => {
  const { db, file } = await freshDb();
  try {
    const id1 = enqueueSync(db, 'products', 1, 'update', { name: 'A' });
    enqueueSync(db, 'products', 2, 'update', { name: 'B' });

    const transport = {
      push: async () => ({ accepted: [id1], conflicts: [{ id: 999, reason: 'stale' }] }),
    };

    const result = await pushPending(db, transport);
    assert.equal(result.pushed, 1);
    assert.equal(result.conflicts.length, 1);
    assert.equal(getPending(db).length, 1);
  } finally {
    cleanupDb(file);
  }
});

test('pushPending is safe to retry after a transport failure (crash mid-sync simulation)', async () => {
  const { db, file } = await freshDb();
  try {
    enqueueSync(db, 'products', 1, 'update', { name: 'A' });

    const failingTransport = {
      push: async () => {
        throw new Error('network down');
      },
    };
    const failResult = await pushPending(db, failingTransport);
    assert.equal(failResult.pushed, 0);
    assert.ok(failResult.error);
    assert.equal(getPending(db).length, 1, 'row stays queued after a failed push');

    const workingTransport = { push: async (records) => ({ accepted: records.map((r) => r.id) }) };
    const retryResult = await pushPending(db, workingTransport);
    assert.equal(retryResult.pushed, 1);
    assert.equal(getPending(db).length, 0);
  } finally {
    cleanupDb(file);
  }
});

test('pushPending is a no-op when the outbox is empty', async () => {
  const { db, file } = await freshDb();
  try {
    let called = false;
    const transport = { push: async () => { called = true; return { accepted: [] }; } };
    const result = await pushPending(db, transport);
    assert.equal(result.attempted, 0);
    assert.equal(called, false);
  } finally {
    cleanupDb(file);
  }
});
