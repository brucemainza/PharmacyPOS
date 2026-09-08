// Thin HTTP client for Lenco's Access API v2 (https://lenco-api.readme.io/v2.0/reference).
// Response envelope per the docs: { status: boolean, message: string, data, meta? }.
export function createLencoClient({ baseUrl, secretKey }) {
  if (!secretKey) {
    throw new Error(
      'LENCO_SECRET_KEY is not set — see .env.example and docs/payments/lenco-integration.md'
    );
  }

  async function request(method, path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON error body, e.g. a gateway timeout page */
    }

    if (!res.ok || (json && json.status === false)) {
      const message = json?.message || `Lenco API error: HTTP ${res.status}`;
      const err = new Error(message);
      err.httpStatus = res.status;
      err.response = json;
      throw err;
    }

    return json;
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
  };
}
