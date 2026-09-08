import { EventEmitter } from 'events';

// Periodic heartbeat + online/offline transition detection. Not built on `navigator.onLine`
// (unavailable in the Electron main process, and unreliable for "can we actually reach our
// cloud API" anyway) — it's a real health-check ping on a timer.
export class ConnectivityMonitor extends EventEmitter {
  constructor({ healthCheck, intervalMs = 15000 }) {
    super();
    this.healthCheck = healthCheck;
    this.intervalMs = intervalMs;
    this.online = false;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.check();
    this.timer = setInterval(() => this.check(), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check() {
    let isOnline = false;
    try {
      isOnline = await this.healthCheck();
    } catch {
      isOnline = false;
    }

    const wasOnline = this.online;
    this.online = isOnline;

    this.emit('checked', isOnline);
    if (isOnline && !wasOnline) this.emit('online');
    if (!isOnline && wasOnline) this.emit('offline');

    return isOnline;
  }
}
