# Sync Runbook

Implementation reference: `sync-engine/` (engine, runs inside each Electron install),
`cloud-sync-api/` (the EC2-hosted API and Postgres store).

## Diagnosing a stuck sync (outbox growing, no successful push/pull)

1. **Check connectivity from the till's own machine**, not just "is the internet up":
   ```sh
   curl -v $CLOUD_SYNC_URL/health
   ```
   - Connection refused/timeout → network or firewall issue between the till and the EC2
     instance (security group, VPN, DNS). The app itself isn't broken; nothing will sync until
     this is fixed, but cash sales/dispensing/inventory keep working locally regardless.
   - `{"status":"ok","db":"ok"}` → the API is fine; the problem is likely on the till side (see
     next step) or the sync engine simply hasn't ticked yet (default heartbeat interval 15s).
   - `{"status":"error","db":"unreachable",...}` → the API container is up but can't reach its
     Postgres. Check the `postgres` container/RDS instance, not the till.
2. **Check the local outbox size** — from the renderer, `window.pos.getSyncStatus()` (wired to
   the `get-sync-status` IPC handler in `electron/main.js`) reports pending count and last sync
   attempt. A large, growing pending count with a recent "online" status usually means pushes are
   failing server-side (check the sync API's logs, `docker compose logs sync-api` on the EC2
   instance) rather than the connectivity check itself failing.
3. **Check the sync API logs for repeated errors** on the same idempotency key — a genuine bug
   (not just "still offline") shows the same record failing push after push rather than the
   outbox simply being large because the till was offline for a while.

## Diagnosing a conflicted sync

Conflicts are reported, never silently resolved server-side — `POST /sync/push`'s response has a
`conflicts` array alongside `accepted`. What "resolved" looks like depends on the entity class
(see `docs/architecture/system-architecture.md`'s conflict table):

- **Append-only entities** (`stock_movements`, `audit_log`, `controlled_substance_log`): a
  reported conflict here is a **transport/logic bug**, not a real data conflict — these are
  insert-only by design and should never collide. Treat this as a code issue to investigate, not
  something to manually reconcile.
- **Financial records** (`transactions`, `payments`): server always wins. If the cloud side has a
  different value than what a till pushed, the till's local copy should be overwritten by the
  next pull — nothing to do manually beyond confirming the pull actually happened
  (`sync-engine/pull.js`'s `pullRemote`).
- **Everything else** (products, customers, prescriptions, ...): last-write-wins, merged per
  field via `updatedAt`/`fieldUpdatedAt`. A "conflict" surfaced during push here just means the
  local write's declared base version was behind the server's current version — the sync engine
  is expected to pull the server's current version and re-merge automatically on its next pass,
  not require manual intervention. If it doesn't self-resolve within a couple of sync cycles,
  that's a bug worth filing, not a data problem to hand-fix.

## Manual recovery steps

The sync engine is idempotent by design (unique `idempotency_key` per outbox row) — every step
below is safe to re-run:

- **Force a sync pass immediately** rather than waiting for the next heartbeat: restart the
  Electron app (re-runs `startSyncEngine()`), or wait for the next `checked` connectivity event —
  there's no dedicated "sync now" button today.
- **Clear a stuck outbox row that will never succeed** (e.g. a record referencing since-deleted
  data): this requires direct database access to the local SQLite file — there is no UI for it
  yet. Treat this as a last resort, not a routine operation, and only after confirming via the
  sync API's logs that the row is actually rejected for a structural reason, not just transient
  connectivity.
- **Re-run cloud-side migrations**: always safe — `cloud-sync-api/migrate.js` only ever issues
  `CREATE TABLE/INDEX IF NOT EXISTS`, never a destructive statement. `docker compose restart
  sync-api` re-runs it as part of container startup.
- **Reset a branch's cursor to force a full re-pull**: delete that entity type's row from the
  local `sync_cursor` table — the next pull passes `cursor: null` and re-fetches everything from
  the cloud side for that entity type. Useful if a branch's local cache has drifted for reasons
  unrelated to a specific conflict (e.g. after restoring from an old backup).
