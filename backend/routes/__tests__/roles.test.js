import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { createServer } from '../../index.js';

async function setupApp() {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dbPath = path.join(os.tmpdir(), `roles-test-${suffix}.db`);
  const uploadsPath = path.join(os.tmpdir(), `roles-test-uploads-${suffix}`);
  const app = await createServer({ dbPath, uploadsPath, jwtSecret: 'test-secret' });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
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
  if (!res.ok) throw new Error(json.error || 'login failed');
  return json.token;
}

async function createUser(base, adminToken, body) {
  const res = await fetch(`${base}/api/users/post`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'create user failed');
  return json;
}

async function get(base, token, urlPath) {
  const res = await fetch(`${base}${urlPath}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, json: await res.json() };
}

async function post(base, token, urlPath, body) {
  const res = await fetch(`${base}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

test('creating a user with role admin or tech is saved as-is, not silently downgraded to cashier', async () => {
  const { base, close } = await setupApp();
  try {
    const adminToken = await login(base, 'admin', 'admin');
    const admin = await createUser(base, adminToken, {
      username: 'admin_role_user',
      password: 'pass1234',
      fullname: 'Admin Role User',
      role: 'admin',
    });
    const tech = await createUser(base, adminToken, {
      username: 'tech_role_user',
      password: 'pass1234',
      fullname: 'Tech Role User',
      role: 'tech',
    });
    assert.equal(admin.role, 'admin');
    assert.equal(tech.role, 'tech');
  } finally {
    await close();
  }
});

test('an unrecognized role falls back to cashier, admin/tech are not bypassed by a typo', async () => {
  const { base, close } = await setupApp();
  try {
    const adminToken = await login(base, 'admin', 'admin');
    const user = await createUser(base, adminToken, {
      username: 'typo_role_user',
      password: 'pass1234',
      fullname: 'Typo Role User',
      role: 'adminn',
    });
    assert.equal(user.role, 'cashier');
  } finally {
    await close();
  }
});

test('admin and tech roles get full perm_* access server-side, same bypass shape as the id===1 super-admin', async () => {
  const { base, close } = await setupApp();
  try {
    const adminToken = await login(base, 'admin', 'admin');
    const adminUser = await createUser(base, adminToken, {
      username: 'admin_access_user',
      password: 'pass1234',
      fullname: 'Admin Access User',
      role: 'admin',
      // Deliberately no perm_* flags set — access must come from the role, not these.
    });
    const techUser = await createUser(base, adminToken, {
      username: 'tech_access_user',
      password: 'pass1234',
      fullname: 'Tech Access User',
      role: 'tech',
    });

    const adminUserToken = await login(base, 'admin_access_user', 'pass1234');
    const techUserToken = await login(base, 'tech_access_user', 'pass1234');

    // GET /api/users/all requires perm_users, which neither user has been granted.
    const adminList = await get(base, adminUserToken, '/api/users/all');
    const techList = await get(base, techUserToken, '/api/users/all');
    assert.equal(adminList.status, 200);
    assert.equal(techList.status, 200);
    assert.ok(Array.isArray(adminList.json));
    assert.ok(Array.isArray(techList.json));

    void adminUser;
    void techUser;
  } finally {
    await close();
  }
});

test('a plain cashier without perm_users is still rejected — the admin/tech bypass does not leak to other roles', async () => {
  const { base, close } = await setupApp();
  try {
    const adminToken = await login(base, 'admin', 'admin');
    await createUser(base, adminToken, {
      username: 'plain_cashier',
      password: 'pass1234',
      fullname: 'Plain Cashier',
      role: 'cashier',
    });
    const cashierToken = await login(base, 'plain_cashier', 'pass1234');
    const res = await get(base, cashierToken, '/api/users/all');
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test('requireAnyPerm also treats admin/tech as fully permitted (demo seed/clear)', async () => {
  const { base, close } = await setupApp();
  try {
    const adminToken = await login(base, 'admin', 'admin');
    const techUser = await createUser(base, adminToken, {
      username: 'tech_demo_user',
      password: 'pass1234',
      fullname: 'Tech Demo User',
      role: 'tech',
    });
    void techUser;
    const techUserToken = await login(base, 'tech_demo_user', 'pass1234');

    const seedRes = await post(base, techUserToken, '/api/demo/seed', {});
    assert.equal(seedRes.status, 200);
  } finally {
    await close();
  }
});
