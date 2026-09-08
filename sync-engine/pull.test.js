import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, cleanupDb } from './testHelpers.js';
import { enqueueSync } from './outbox.js';
import { pullRemote } from './pull.js';

test('pullRemote applies remote changes and advances the cursor', async () => {
  const { db, file } = await freshDb();
  try {
    const transport = {
      pull: async (entityType, cursor) => {
        assert.equal(entityType, 'products');
        assert.equal(cursor, null);
        return {
          changes: [{ id: 5, name: 'Ibuprofen', updatedAt: '2026-01-01T00:00:00.000Z' }],
          nextCursor: '2026-01-01T00:00:00.000Z',
        };
      },
    };

    const resolved = await pullRemote(db, transport, 'products');
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].resolution, 'remote-applied');

    const cursorRow = db
      .prepare('SELECT last_pulled_at FROM sync_cursor WHERE entity_type = ?')
      .get('products');
    assert.equal(cursorRow.last_pulled_at, '2026-01-01T00:00:00.000Z');
  } finally {
    cleanupDb(file);
  }
});

test('pullRemote passes the saved cursor on the next pull', async () => {
  const { db, file } = await freshDb();
  try {
    const seenCursors = [];
    const transport = {
      pull: async (_entityType, cursor) => {
        seenCursors.push(cursor);
        return { changes: [], nextCursor: `cursor-${seenCursors.length}` };
      },
    };

    await pullRemote(db, transport, 'products');
    await pullRemote(db, transport, 'products');

    assert.deepEqual(seenCursors, [null, 'cursor-1']);
  } finally {
    cleanupDb(file);
  }
});

test('pullRemote resolves a conflict against a not-yet-synced local outbox entry', async () => {
  const { db, file } = await freshDb();
  try {
    enqueueSync(db, 'products', 5, 'update', {
      name: 'Local Edit',
      updatedAt: '2026-01-03T00:00:00.000Z',
    });

    const transport = {
      pull: async () => ({
        changes: [{ id: 5, name: 'Remote Edit', updatedAt: '2026-01-01T00:00:00.000Z' }],
        nextCursor: 'c1',
      }),
    };

    const resolved = await pullRemote(db, transport, 'products');
    assert.equal(resolved[0].resolution, 'local');
    assert.equal(resolved[0].record.name, 'Local Edit');
  } finally {
    cleanupDb(file);
  }
});

test('pullRemote on an append-only entity type propagates the conflict.js guard if misused', async () => {
  const { db, file } = await freshDb();
  try {
    enqueueSync(db, 'stock_movements', 1, 'insert', { qtyDelta: 5 });

    const transport = {
      pull: async () => ({
        changes: [{ id: 1, qtyDelta: 5 }],
        nextCursor: 'c1',
      }),
    };

    await assert.rejects(() => pullRemote(db, transport, 'stock_movements'), /append-only/);
  } finally {
    cleanupDb(file);
  }
});
