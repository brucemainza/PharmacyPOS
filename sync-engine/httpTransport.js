// Real transport for talking to the cloud sync API (cloud-sync-api/). Kept separate from
// push.js/pull.js so those stay unit-testable without a live server — see __tests__ for the
// fake transport used there.
export function createHttpTransport(baseUrl) {
  return {
    async health() {
      try {
        const res = await fetch(`${baseUrl}/health`);
        return res.ok;
      } catch {
        return false;
      }
    },

    async push(records) {
      const res = await fetch(`${baseUrl}/sync/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records }),
      });
      if (!res.ok) throw new Error(`sync push failed: HTTP ${res.status}`);
      return res.json();
    },

    async pull(entityType, cursor) {
      const url = new URL('sync/pull', baseUrl);
      url.searchParams.set('entityType', entityType);
      if (cursor) url.searchParams.set('cursor', cursor);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`sync pull failed: HTTP ${res.status}`);
      return res.json();
    },
  };
}
