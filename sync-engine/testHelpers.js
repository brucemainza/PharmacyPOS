import os from 'os';
import path from 'path';
import fs from 'fs';
import { initDatabase, getDb } from '../backend/db.js';

// backend/db.js holds one module-level db singleton, so tests must run sequentially against it
// (Node's test runner does this by default within a single file) — each call re-points the
// singleton at a fresh temp file.
export async function freshDb() {
  const file = path.join(
    os.tmpdir(),
    `store-pos-sync-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  await initDatabase(file);
  return { db: getDb(), file };
}

export function cleanupDb(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}
