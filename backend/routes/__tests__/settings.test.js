import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { createServer } from '../../index.js';

async function setupApp() {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dbPath = path.join(os.tmpdir(), `settings-test-${suffix}.db`);
  const uploadsPath = path.join(os.tmpdir(), `settings-test-uploads-${suffix}`);
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

async function login(base, username, password) {
  const res = await fetch(`${base}/api/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const json = await res.json();
  return json.token;
}

async function saveSettings(base, token, fields) {
  const fd = new FormData();
  Object.entries(fields).forEach(([k, v]) => fd.append(k, String(v)));
  const res = await fetch(`${base}/api/settings/post`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  return { status: res.status, json: await res.json() };
}

test('discount_approval_threshold is clamped to 0-100 server-side, not trusted verbatim from the client', async () => {
  const { base, close } = await setupApp();
  try {
    const token = await login(base, 'admin', 'admin');

    const tooHigh = await saveSettings(base, token, { discount_approval_threshold: 250 });
    assert.equal(tooHigh.status, 200);
    assert.equal(tooHigh.json.settings.discount_approval_threshold, 100);

    const negative = await saveSettings(base, token, { discount_approval_threshold: -30 });
    assert.equal(negative.status, 200);
    assert.equal(negative.json.settings.discount_approval_threshold, 0);

    const normal = await saveSettings(base, token, { discount_approval_threshold: 15 });
    assert.equal(normal.status, 200);
    assert.equal(normal.json.settings.discount_approval_threshold, 15);
  } finally {
    await close();
  }
});
