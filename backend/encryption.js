import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// Encryption at rest for the local database file. Threat model: protects the DB file's
// contents from someone who copies/reads it off disk without the accompanying key file (a
// stolen drive, a careless backup, a leaked upload) — it does NOT protect against an attacker
// with the same OS-user access as the running app, since the key lives alongside the data it
// protects. See docs/compliance/data-protection.md for the full write-up and the documented
// upgrade path (OS-keychain-backed key storage via Electron's `safeStorage` when running inside
// Electron, instead of a plain key file).
const MAGIC = Buffer.from('POSENC1');
const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function keyPathFor(dbPath) {
  return `${dbPath}.key`;
}

export function getOrCreateKey(dbPath) {
  const envKey = process.env.DB_ENCRYPTION_KEY;
  if (envKey) {
    const buf = Buffer.from(envKey, 'hex');
    if (buf.length !== 32) {
      throw new Error('DB_ENCRYPTION_KEY must be 32 bytes hex-encoded (64 hex characters)');
    }
    return buf;
  }

  const keyPath = keyPathFor(dbPath);
  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath);
  }

  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    /* best-effort on platforms without POSIX permission bits (e.g. Windows) */
  }
  return key;
}

export function encryptBuffer(plainBuffer, key) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, authTag, ciphertext]);
}

export function isEncrypted(buffer) {
  return buffer.length >= MAGIC.length && buffer.subarray(0, MAGIC.length).equals(MAGIC);
}

export function decryptBuffer(fileBuffer, key) {
  const body = fileBuffer.subarray(MAGIC.length);
  const iv = body.subarray(0, IV_LENGTH);
  const authTag = body.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = body.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
