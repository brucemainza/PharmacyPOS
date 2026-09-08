import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';
import initSqlJs from 'sql.js';
import { createRequire } from 'module';
import { initDatabase, getDb } from '../db.js';
import { getOrCreateKey, decryptBuffer, isEncrypted } from '../encryption.js';

const require = createRequire(import.meta.url);

function tmpDbPath(name) {
  return path.join(os.tmpdir(), `${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(dbPath) {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}.key`, { force: true });
}

test('the persisted database file is encrypted, not a readable SQLite file', async () => {
  const dbPath = tmpDbPath('enc');
  try {
    await initDatabase(dbPath);
    getDb().prepare("UPDATE settings SET store = 'Encrypted Store' WHERE id = 1").run();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const onDisk = fs.readFileSync(dbPath);
    assert.ok(isEncrypted(onDisk), 'file should carry the encryption magic header');
    assert.notEqual(onDisk.subarray(0, 16).toString(), 'SQLite format 3', 'raw SQLite header must not be visible on disk');

    const key = getOrCreateKey(dbPath);
    const plain = decryptBuffer(onDisk, key);
    assert.ok(plain.subarray(0, 16).toString().startsWith('SQLite format 3'), 'decrypting with the correct key recovers a real SQLite file');
  } finally {
    cleanup(dbPath);
  }
});

test('a legacy plaintext SQLite file loads transparently and is re-persisted encrypted', async () => {
  const dbPath = tmpDbPath('legacy');
  try {
    const wasmPath = path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm');
    const SQL = await initSqlJs({ locateFile: () => wasmPath });
    const rawDb = new SQL.Database();
    rawDb.exec('CREATE TABLE placeholder (x INTEGER)');
    fs.writeFileSync(dbPath, Buffer.from(rawDb.export()));

    const db = await initDatabase(dbPath);
    const admin = db.prepare('SELECT username FROM users WHERE id = 1').get();
    assert.equal(admin.username, 'admin');

    await new Promise((resolve) => setTimeout(resolve, 100));
    const reread = fs.readFileSync(dbPath);
    assert.ok(isEncrypted(reread), 'file should now be encrypted after the first write');
  } finally {
    cleanup(dbPath);
  }
});

test('the wrong key fails to decrypt (auth tag mismatch), proving the file is not just obscured', async () => {
  const dbPath = tmpDbPath('wrongkey');
  try {
    await initDatabase(dbPath);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const onDisk = fs.readFileSync(dbPath);
    const wrongKey = Buffer.alloc(32, 7);
    assert.throws(() => decryptBuffer(onDisk, wrongKey));
  } finally {
    cleanup(dbPath);
  }
});
