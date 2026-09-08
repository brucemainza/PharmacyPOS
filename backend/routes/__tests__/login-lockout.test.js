import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { createServer } from '../../index.js';
import { resetLoginLockouts } from '../../auth.js';

async function setupApp() {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dbPath = path.join(os.tmpdir(), `login-lockout-test-${suffix}.db`);
  const uploadsPath = path.join(os.tmpdir(), `login-lockout-test-uploads-${suffix}`);
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

async function attemptLogin(base, username, password) {
  const res = await fetch(`${base}/api/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return { status: res.status, json: await res.json() };
}

test('repeated wrong passwords lock the account out, even a correct password is then rejected', async () => {
  resetLoginLockouts();
  const { base, close } = await setupApp();
  try {
    for (let i = 0; i < 5; i += 1) {
      const res = await attemptLogin(base, 'admin', 'wrong-password');
      assert.equal(res.status, 401);
    }

    const lockedWithBadPassword = await attemptLogin(base, 'admin', 'wrong-password');
    assert.equal(lockedWithBadPassword.status, 429);
    assert.ok(lockedWithBadPassword.json.lockedUntil > Date.now());

    // The whole point: lockout blocks the *account*, not just the wrong password —
    // the real credentials must not work either while locked out.
    const lockedWithCorrectPassword = await attemptLogin(base, 'admin', 'admin');
    assert.equal(lockedWithCorrectPassword.status, 429);
  } finally {
    await close();
    resetLoginLockouts();
  }
});

test('lockout is scoped per username — a different account is unaffected', async () => {
  resetLoginLockouts();
  const { base, close } = await setupApp();
  try {
    // Create a second real user first (needs an authenticated admin token).
    const adminToken = (
      await (
        await fetch(`${base}/api/users/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'admin' }),
        })
      ).json()
    ).token;
    await fetch(`${base}/api/users/post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ username: 'other_user', password: 'pass1234', fullname: 'Other User' }),
    });

    for (let i = 0; i < 5; i += 1) {
      await attemptLogin(base, 'admin', 'wrong-password');
    }
    const adminLocked = await attemptLogin(base, 'admin', 'admin');
    assert.equal(adminLocked.status, 429);

    const otherStillWorks = await attemptLogin(base, 'other_user', 'pass1234');
    assert.equal(otherStillWorks.status, 200);
  } finally {
    await close();
    resetLoginLockouts();
  }
});

test('a successful login clears the failed-attempt counter', async () => {
  resetLoginLockouts();
  const { base, close } = await setupApp();
  try {
    for (let i = 0; i < 4; i += 1) {
      await attemptLogin(base, 'admin', 'wrong-password');
    }
    const success = await attemptLogin(base, 'admin', 'admin');
    assert.equal(success.status, 200);

    // Counter should have reset to zero on that success, not carried the 4 prior
    // failures forward toward the 5-attempt threshold.
    for (let i = 0; i < 4; i += 1) {
      const res = await attemptLogin(base, 'admin', 'wrong-password');
      assert.equal(res.status, 401);
    }
    const stillNotLocked = await attemptLogin(base, 'admin', 'admin');
    assert.equal(stillNotLocked.status, 200);
  } finally {
    await close();
    resetLoginLockouts();
  }
});
