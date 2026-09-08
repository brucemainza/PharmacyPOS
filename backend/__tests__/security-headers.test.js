import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { createServer } from '../index.js';

async function setupApp() {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dbPath = path.join(os.tmpdir(), `headers-test-${suffix}.db`);
  const uploadsPath = path.join(os.tmpdir(), `headers-test-uploads-${suffix}`);
  const app = await createServer({ dbPath, uploadsPath, jwtSecret: 'test-secret' });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}.key`, { force: true });
      fs.rmSync(uploadsPath, { recursive: true, force: true });
    },
  };
}

test('every response carries basic hardening headers and drops the Express fingerprint', async () => {
  const { base, close } = await setupApp();
  try {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('x-powered-by'), null);
  } finally {
    await close();
  }
});
