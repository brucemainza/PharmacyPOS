import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let loaded = false;

// Resolved relative to this file, not process.cwd() — Electron's main process imports this
// dynamically and its cwd isn't guaranteed to be the repo root, unlike `npm run dev`/`npm test`.
function loadEnv() {
  if (loaded) return;
  dotenv.config({ path: path.join(__dirname, '..', '.env') });
  loaded = true;
}

export function getLencoConfig() {
  loadEnv();

  const environment = process.env.LENCO_ENV === 'production' ? 'production' : 'sandbox';
  const baseUrl =
    environment === 'production'
      ? process.env.LENCO_PRODUCTION_BASE_URL || 'https://api.lenco.co/access/v2'
      : process.env.LENCO_SANDBOX_BASE_URL || 'https://sandbox.lenco.co/access/v2';

  return {
    environment,
    baseUrl,
    secretKey: process.env.LENCO_SECRET_KEY || '',
    publicKey: process.env.LENCO_PUBLIC_KEY || '',
  };
}

export function getCloudSyncUrl() {
  loadEnv();
  return process.env.CLOUD_SYNC_URL || 'http://127.0.0.1:8787';
}
