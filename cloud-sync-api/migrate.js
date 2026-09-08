// Idempotent schema setup for the cloud sync API's Postgres database — safe to run on every
// container start (CREATE TABLE/INDEX IF NOT EXISTS only, no destructive statements).
import { getPool, closePool } from './db.js';

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sync_records (
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    payload JSONB NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    PRIMARY KEY (entity_type, entity_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sync_records_type_updated
     ON sync_records (entity_type, updated_at)`,
  `CREATE TABLE IF NOT EXISTS sync_idempotency (
    idempotency_key TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
];

export async function runMigrations() {
  const pool = getPool();
  for (const statement of STATEMENTS) {
    await pool.query(statement);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => {
      console.log('sync-api: migrations applied');
      return closePool();
    })
    .catch((err) => {
      console.error('sync-api: migration failed', err);
      process.exit(1);
    });
}
