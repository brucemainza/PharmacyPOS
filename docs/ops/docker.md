# Docker

Two separate Docker concerns in this repo, for two different things:

1. `docker-compose.yml` + `cloud-sync-api/Dockerfile` — brings up the **cloud sync API and its
   Postgres database**. This is the piece that actually runs in production, on the EC2 instance.
2. `Dockerfile.ci` (repo root) — a reproducible container for running the **Electron app's test
   suite and renderer build**, so CI doesn't depend on a developer machine's Node version or
   global state. It does not package the Electron desktop installer (see "What this doesn't
   cover" below).

## Bringing up the sync API stack locally

```sh
cp .env.example .env
# fill in real values where needed — Postgres credentials can stay as the defaults for local dev
docker compose up -d
```

This starts two services:

- **`postgres`** (`postgres:16-alpine`) — data persisted in the named volume `postgres-data`, so
  it survives `docker compose down` (use `down -v` to actually wipe it). Health-checked with
  `pg_isready` before `sync-api` is allowed to start.
- **`sync-api`** (built from `cloud-sync-api/Dockerfile`) — on every container start it runs
  `npm run migrate` (idempotent `CREATE TABLE IF NOT EXISTS` statements in
  `cloud-sync-api/migrate.js`) and *then* `npm start`, so a fresh `docker compose up` on a brand
  new Postgres volume needs no separate manual migration step. Exposes `GET /health`, which
  itself checks DB connectivity (`SELECT 1`) — a `503` there means the API is up but can't reach
  Postgres, not that the container crashed.

Verify it's working:

```sh
curl http://127.0.0.1:8787/health
# {"status":"ok","db":"ok"}
```

## Environment variables

All read from `.env` (copy from `.env.example`; never commit the real `.env`):

| Variable | Used by | Purpose |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `docker-compose.yml` | Credentials for the `postgres` service; also assembled into `sync-api`'s `DATABASE_URL` |
| `POSTGRES_PORT` | `docker-compose.yml` | Host port the Postgres container's `5432` is published on (change if `5432` is already taken on the host, as it commonly is on a shared EC2 box) |
| `SYNC_API_PORT` | `docker-compose.yml` | Host port the sync API is published on |
| `DB_ENCRYPTION_KEY` | Electron app, not this compose stack | Local SQLite encryption key override — see `docs/compliance/data-protection.md`. Unrelated to Postgres; listed here only so it isn't confused with the Postgres variables above |
| `CLOUD_SYNC_URL` | Electron app | Where the packaged app looks for this sync API — point it at the EC2 instance's DNS/IP (with the scheme/port you actually terminate TLS on) once deployed |
| `LENCO_*` | Electron app's local server, not this compose stack | See `docs/payments/lenco-integration.md` |

## Deploying to the EC2 instance

The cloud sync API is deployed to a single AWS EC2 instance (a deliberate choice — see
`docs/architecture/system-architecture.md`'s "Deployment target" section: this API is a thin
sync/reconciliation layer, never the business-logic system of record, so the app keeps working
fully offline regardless of this instance's state).

1. SSH to the instance; install Docker + the Docker Compose plugin.
2. Clone the repo (or just copy `docker-compose.yml` and `cloud-sync-api/`) onto the instance.
3. Copy `.env.example` to `.env` on the instance and fill in real Postgres credentials — never
   commit this file, and never reuse the local-dev defaults in a real deployment.
4. Open the instance's security group for `SYNC_API_PORT` (default `8787`) to whatever should
   reach it (ideally only through a reverse proxy — see below — not directly to the internet).
5. `docker compose up -d`.
6. Put a reverse proxy in front for TLS (nginx, Caddy, or an ALB in front of the instance) —
   `docker-compose.yml` here doesn't terminate TLS itself. Point `CLOUD_SYNC_URL` in every
   Electron install at this proxy's `https://` address, not the raw container port.
7. Postgres can either stay as the `postgres` container on the same instance (simplest, and what
   the volume-backed compose service here already gives you) or move to RDS later if multi-
   instance/managed-backup needs arise — no code change needed, just point `DATABASE_URL` at the
   RDS endpoint instead of the `postgres` service hostname.

## Running tests and the build reproducibly

```sh
docker build -f Dockerfile.ci -t store-pos-ci .
docker run --rm store-pos-ci                 # runs `npm test` then `npm run build`
docker run --rm store-pos-ci npm test        # just the test suite
docker run --rm store-pos-ci npm run build   # just the renderer build
```

This installs the full root `package.json` (including the `electron` devDependency — its
postinstall fetches a prebuilt binary over the network at `npm ci` time, same as on a developer
machine) and runs the exact `node --test ...` suite and `vite build` a developer would run
locally, inside a clean, disposable environment — no dependence on whatever Node version or
global packages happen to be on a given CI runner or laptop.

## What this doesn't cover

- **The Electron desktop installer is not built here.** `electron-builder` (the `dist` script)
  needs OS-specific signing/packaging tooling that doesn't fit a single reproducible Linux
  container — building the actual `.exe`/installer stays a native/CI-runner concern outside
  Docker, per the brief's Phase 5 scope ("the Electron app itself is not containerized for end
  users").
- **`cloud-sync-api`'s own Postgres-integration tests** (`cloud-sync-api/store.test.js`) aren't
  wired into `Dockerfile.ci` — they need a live Postgres, which `Dockerfile.ci` doesn't bring up.
  Run them against `docker compose up -d postgres` locally instead:
  ```sh
  docker compose up -d postgres
  DATABASE_URL=postgres://syncapi:syncapi@127.0.0.1:5432/store_pos_sync \
    npm --prefix cloud-sync-api test
  ```
  They skip cleanly (not fail) when `DATABASE_URL` isn't set, so accidentally running
  `npm --prefix cloud-sync-api test` without Postgres up doesn't break anything.
