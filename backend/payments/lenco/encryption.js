import * as jose from 'jose';

// Card payloads must be JWE-encrypted (RSA-OAEP-256 / A256GCM) with Lenco's current public key
// before POSTing to /collections/card — see
// https://lenco-api.readme.io/v2.0/reference/encryption and
// https://lenco-api.readme.io/v2.0/reference/get-encryption-key. The docs are explicit that the
// key "might change anytime and therefore should not be stored and reused", so this fetches a
// fresh key on every call rather than caching one.
export async function encryptCardPayload(client, payload) {
  const keyRes = await client.get('/encryption-key');
  const jwk = keyRes.data;

  const publicKey = await jose.importJWK(jwk, 'RSA-OAEP-256');

  const jwe = await new jose.CompactEncrypt(
    new TextEncoder().encode(JSON.stringify(payload))
  )
    .setProtectedHeader({
      alg: 'RSA-OAEP-256',
      enc: 'A256GCM',
      cty: 'application/json',
      kid: jwk.kid,
    })
    .encrypt(publicKey);

  return jwe;
}
