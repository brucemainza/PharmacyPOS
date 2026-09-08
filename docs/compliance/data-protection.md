# Data Protection

Implementation: `backend/encryption.js` (encryption at rest), `backend/db.js` (wiring into
persist/load).

## Encryption at rest

The local database file (patient/prescription records, sales, everything) is encrypted on disk
with AES-256-GCM. Every write re-exports the in-memory sql.js database and encrypts it before
`fs.writeFileSync`; every load decrypts before handing the bytes to sql.js.

- **Key storage**: a random 256-bit key is generated on first run and stored in a sibling file
  (`<dbfile>.key`, e.g. `store-pos.sqlite.key`), permissioned `0600` on POSIX systems. Setting the
  `DB_ENCRYPTION_KEY` environment variable (64 hex characters) overrides this and skips writing a
  key file at all — the deployment-managed key is used instead.
- **Backward compatible**: a pre-encryption plaintext SQLite file loads transparently (detected by
  the absence of the `POSENC1` magic header) and is re-persisted encrypted the moment anything
  writes to it — no manual migration step for existing installs.
- **Threat model, stated plainly**: this protects the database file's contents from someone who
  obtains the file *without* the key file next to it — a stolen laptop drive imaged and read
  elsewhere, a backup copied off-site without its key, an accidental upload of the raw `.db` file.
  It does **not** protect against an attacker with the same OS-user access as the running
  application, since the key lives alongside the data it protects on the same filesystem. That's
  a materially stronger threat model (full host compromise) that would need the key held outside
  the app's own reach — e.g. an OS keychain.
- **Documented upgrade path, not yet built**: when running inside Electron specifically (as
  opposed to the bare Node test/server context, which has no access to Electron APIs),
  `safeStorage` (Electron's OS-keychain-backed encryption) could wrap the key file's contents
  instead of writing it in the clear, closing part of the gap above. This is a reasonable Phase
  5+ follow-up, not implemented here because `backend/db.js` is shared code that also runs outside
  Electron (every automated test in this repo runs it as plain Node).

## What is and isn't logged in plaintext

- No route in `backend/payments/` logs anything (checked directly — zero `console.*` calls in that
  module), so card numbers, mobile-money numbers, and Lenco API responses never reach process
  logs.
- The handful of `console.error(err)` calls elsewhere (`backend/index.js`'s global error handler,
  a few file-cleanup catch blocks in `routes/media.js`/`routes/inventory.js`/`routes/settings.js`)
  log caught `Error` objects (message + stack), not raw request bodies — they don't interpolate
  patient data or credentials into the message.
- Nothing in this codebase writes application logs to a file today (only `console.*`, captured by
  whatever process supervisor runs the app) — if a future deployment adds file-based logging, it
  must be reviewed against this same rule before shipping.

## Data retention

Not yet enforced anywhere — there is no purge job, no retention column, and no automatic
anonymization of old patient/prescription/controlled-substance records. This needs a concrete
answer (a specific retention period, and what "delete" vs. "anonymize" means for a required
audit trail) before a real go-live, most likely driven by whichever jurisdiction's pharmaceutical
recordkeeping rules apply — see `docs/compliance/controlled-substance-log.md`'s retention section
for the sharpest instance of this gap.

## Data in transit and at rest on the cloud side

- **In transit**: the Electron app talks to the cloud sync API over whatever transport the EC2
  deployment terminates TLS with (see `docs/ops/docker.md` for the reverse-proxy/TLS setup) — the
  app itself doesn't pin a scheme, so an operator must not point `CLOUD_SYNC_URL` at a plain
  `http://` endpoint in production.
- **At rest on the cloud side**: Phase 5's Postgres-backed sync API doesn't exist yet, so there is
  no cloud-side "at rest" story to document beyond "use RDS/Postgres encryption-at-rest options
  when that lands" — tracked as a Phase 5 item, not a current gap in a running system.
