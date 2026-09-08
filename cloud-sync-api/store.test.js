// Integration tests against a real Postgres — requires DATABASE_URL (see docs/ops/docker.md for
// bringing up a disposable instance via `docker compose up -d postgres`). Skips cleanly rather
// than failing when no database is configured, so this file is safe to include in a glob that
// also runs in environments without Postgres available.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { runMigrations } from './migrate.js';
import { applyPush, getChangesSince } from './store.js';
import { closePool } from './db.js';

const hasDb = !!process.env.DATABASE_URL;

test('applyPush accepts a new record and getChangesSince returns it', { skip: !hasDb && 'DATABASE_URL not set' }, async () => {
  await runMigrations();
  const entityType = `test_products_${randomUUID().slice(0, 8)}`;

  const result = await applyPush([
    { id: 1, entityType, entityId: '1', op: 'insert', idempotencyKey: randomUUID(), payload: { name: 'Panadol' } },
  ]);
  assert.deepEqual(result.accepted, [1]);
  assert.deepEqual(result.conflicts, []);

  const { changes } = await getChangesSince(entityType, null);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].name, 'Panadol');
  assert.equal(changes[0].__version, 1);
});

test('a retried push with the same idempotency key is a safe no-op, not a duplicate', { skip: !hasDb && 'DATABASE_URL not set' }, async () => {
  const entityType = `test_products_${randomUUID().slice(0, 8)}`;
  const idempotencyKey = randomUUID();
  const record = { id: 1, entityType, entityId: '1', op: 'insert', idempotencyKey, payload: { name: 'Ibuprofen' } };

  await applyPush([record]);
  const second = await applyPush([record]);
  assert.deepEqual(second.accepted, [1]);

  const { changes } = await getChangesSince(entityType, null);
  assert.equal(changes.length, 1);
});

test('an update behind the server version is reported as a conflict, not silently applied', { skip: !hasDb && 'DATABASE_URL not set' }, async () => {
  const entityType = `test_products_${randomUUID().slice(0, 8)}`;
  await applyPush([
    { id: 1, entityType, entityId: '1', op: 'insert', idempotencyKey: randomUUID(), payload: { name: 'Aspirin', price: 5 } },
  ]);

  const result = await applyPush([
    {
      id: 2,
      entityType,
      entityId: '1',
      op: 'update',
      idempotencyKey: randomUUID(),
      payload: { name: 'Aspirin', price: 6, __baseVersion: 0 },
    },
  ]);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].serverRecord.price, 5);
});

test('getChangesSince with a cursor only returns records updated after it', { skip: !hasDb && 'DATABASE_URL not set' }, async () => {
  const entityType = `test_products_${randomUUID().slice(0, 8)}`;
  await applyPush([
    { id: 1, entityType, entityId: '1', op: 'insert', idempotencyKey: randomUUID(), payload: { name: 'First' } },
  ]);
  const { nextCursor } = await getChangesSince(entityType, null);

  await new Promise((resolve) => setTimeout(resolve, 10));
  await applyPush([
    { id: 2, entityType, entityId: '2', op: 'insert', idempotencyKey: randomUUID(), payload: { name: 'Second' } },
  ]);

  const { changes } = await getChangesSince(entityType, nextCursor);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].name, 'Second');
});

test.after(async () => {
  if (hasDb) await closePool();
});
