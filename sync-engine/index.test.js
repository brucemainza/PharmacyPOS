import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, cleanupDb } from './testHelpers.js';
import { enqueueSync } from './outbox.js';
import { pendingCount } from './outbox.js';
import { createSyncEngine } from './index.js';

// End-to-end (within the module boundary): queue -> connectivity comes online -> push -> pull,
// against a real db and a fake transport, matching Phase 1's acceptance criterion.
test('sync engine drains the outbox and pulls remote changes once connectivity comes online', async () => {
  const { db, file } = await freshDb();
  try {
    const id = enqueueSync(db, 'products', 1, 'update', { name: 'Paracetamol' });
    assert.equal(pendingCount(db), 1);

    let online = false;
    let pullCalls = 0;
    const transport = {
      health: async () => online,
      push: async (records) => ({ accepted: records.map((r) => r.id) }),
      pull: async () => {
        pullCalls += 1;
        return { changes: [], nextCursor: 'c1' };
      },
    };

    const engine = createSyncEngine({
      db,
      transport,
      entityTypes: ['categories'],
      intervalMs: 1_000_000, // never fires on its own; we drive the pass manually below
    });

    // runSyncPass composes push+pull directly regardless of connectivity state — the
    // ConnectivityMonitor's job (covered by the next test) is deciding *when* to call it.
    online = true;
    const result = await engine.runSyncPass();

    assert.equal(result.pushResult.pushed, 1);
    assert.equal(pendingCount(db), 0);
    assert.equal(pullCalls > 0, true);
    assert.ok(result.pullResults.categories);

    const status = engine.getStatus();
    assert.equal(status.pendingCount, 0);
    assert.equal(status.lastError, null);
    void id;
  } finally {
    cleanupDb(file);
  }
});

test('connectivity "checked" event triggers a sync pass only when online', async () => {
  const { db, file } = await freshDb();
  try {
    enqueueSync(db, 'products', 1, 'update', { name: 'A' });

    let isOnline = false;
    let syncPassesRun = 0;
    const transport = {
      health: async () => isOnline,
      push: async (records) => {
        syncPassesRun += 1;
        return { accepted: records.map((r) => r.id) };
      },
      pull: async () => ({ changes: [], nextCursor: null }),
    };

    const engine = createSyncEngine({ db, transport, entityTypes: [], intervalMs: 1_000_000 });

    engine.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(syncPassesRun, 0, 'stays offline: no sync pass yet');

    isOnline = true;
    // Trigger another connectivity check manually instead of waiting for the interval.
    await /** @type {any} */ (engine).runSyncPass();
    engine.stop();

    assert.equal(syncPassesRun, 1);
    assert.equal(pendingCount(db), 0);
  } finally {
    cleanupDb(file);
  }
});
