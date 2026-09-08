import { ConnectivityMonitor } from './connectivity.js';
import { pushPending } from './push.js';
import { pullRemote } from './pull.js';
import { pendingCount } from './outbox.js';

// Orchestrates the sync engine: a connectivity heartbeat drives sync passes (push queued
// writes, then pull remote changes for each tracked entity type). Only ever runs against a
// local db that exists (Standalone/Server Electron modes) — Network Terminal mode has no
// local db and relies on its LAN server instead, per electron/main.js's existing
// shouldStartServer gating.
export function createSyncEngine({ db, transport, entityTypes = [], intervalMs = 15000 }) {
  const monitor = new ConnectivityMonitor({
    healthCheck: () => transport.health(),
    intervalMs,
  });

  let syncing = false;
  let lastResult = null;
  let lastError = null;

  async function runSyncPass() {
    if (syncing) return lastResult;
    syncing = true;
    try {
      const pushResult = await pushPending(db, transport);
      const pullResults = {};
      for (const entityType of entityTypes) {
        pullResults[entityType] = await pullRemote(db, transport, entityType);
      }
      lastResult = { pushResult, pullResults, at: new Date().toISOString() };
      lastError = null;
      return lastResult;
    } catch (err) {
      lastError = err.message;
      throw err;
    } finally {
      syncing = false;
    }
  }

  monitor.on('checked', (isOnline) => {
    if (isOnline) runSyncPass().catch(() => {});
  });

  return {
    start: () => monitor.start(),
    stop: () => monitor.stop(),
    runSyncPass,
    getStatus: () => ({
      online: monitor.online,
      syncing,
      pendingCount: pendingCount(db),
      lastResult,
      lastError,
    }),
    on: (...args) => monitor.on(...args),
  };
}
