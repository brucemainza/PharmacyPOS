import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConflict } from './conflict.js';

test('append-only entities (ledgers/logs) throw rather than silently resolve a conflict', () => {
  assert.throws(() => resolveConflict('stock_movements', {}, {}), /append-only/);
  assert.throws(() => resolveConflict('audit_log', {}, {}), /append-only/);
  assert.throws(() => resolveConflict('controlled_substance_log', {}, {}), /append-only/);
});

test('financial records (transactions, payments) are server-authoritative on conflict', () => {
  const local = { total: 100, updatedAt: '2026-01-02T00:00:00.000Z' };
  const remote = { total: 90, updatedAt: '2026-01-01T00:00:00.000Z' };
  assert.deepEqual(resolveConflict('transactions', local, remote), { winner: 'server', record: remote });
  assert.deepEqual(resolveConflict('payments', local, remote), { winner: 'server', record: remote });
});

test('default last-write-wins: newer local field beats older remote field', () => {
  const local = { name: 'New Name', price: 10, updatedAt: '2026-01-02T00:00:00.000Z' };
  const remote = { name: 'Old Name', price: 10, updatedAt: '2026-01-01T00:00:00.000Z' };
  const result = resolveConflict('products', local, remote);
  assert.equal(result.winner, 'local');
  assert.equal(result.record.name, 'New Name');
});

test('default last-write-wins: newer remote field beats older local field', () => {
  const local = { name: 'Stale Name', updatedAt: '2026-01-01T00:00:00.000Z' };
  const remote = { name: 'Fresh Name', updatedAt: '2026-01-02T00:00:00.000Z' };
  const result = resolveConflict('products', local, remote);
  assert.equal(result.winner, 'server');
  assert.equal(result.record.name, 'Fresh Name');
});

test('default last-write-wins: per-field merge when fieldUpdatedAt disagrees per field', () => {
  const local = {
    name: 'Local Name',
    price: 15,
    fieldUpdatedAt: { name: '2026-01-03T00:00:00.000Z', price: '2026-01-01T00:00:00.000Z' },
  };
  const remote = {
    name: 'Remote Name',
    price: 20,
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
  const result = resolveConflict('products', local, remote);
  assert.equal(result.winner, 'merged');
  assert.equal(result.record.name, 'Local Name');
  assert.equal(result.record.price, 20);
});
