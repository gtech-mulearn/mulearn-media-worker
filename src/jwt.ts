// Verifies the HS256 access token issued by the Django backend.
// Kept in its own file so it can be swapped for JWKS/RS256 later.

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface JwtPayload {
  id?: string;
  exp?: number;
  expiry?: string;
  tokenType?: string;
  [k: string]: unknown;
}

/**
 * Expiry time in ms. The Django backend puts "expiry": "YYYY-MM-DD HH:MM:SS+0000"
 * in its tokens (see JWTUtils.is_jwt_authenticated); a standard numeric "exp"
 * is honoured too. Returns null when neither is usable.
 */
function expiryMs(p: JwtPayload): number | null {
  if (typeof p.exp === "number") return p.exp * 1000;
  if (typeof p.expiry === "string") {
    const m = p.expiry.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})([+-]\d{2}):?(\d{2})$/);
    if (!m) return null;
    const t = Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

// The secret is fixed for the life of the isolate, so import the HMAC key once
// and reuse it. Re-imported only if the secret changes.
let cachedKey: { secret: string; key: Promise<CryptoKey> } | null = null;

function hmacKey(secret: string): Promise<CryptoKey> {
  if (!cachedKey || cachedKey.secret !== secret) {
    const key = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    // Do not keep a failed import around.
    key.catch(() => {
      if (cachedKey?.key === key) cachedKey = null;
    });
    cachedKey = { secret, key };
  }
  return cachedKey.key;
}

/**
 * Returns the payload if this is a valid, unexpired **access** token, otherwise null.
 *
 * The backend signs several token kinds with the same secret (refresh tokens,
 * signup tokens, ...). They carry a "tokenType"; only "access" may upload.
 * A token without "tokenType" is treated as an access token, as the backend does.
 */
export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || !secret) return null;
  const [h, p, s] = parts;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    if (header.alg !== "HS256") return null;

    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      b64urlToBytes(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!ok) return null;

    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as JwtPayload;
    if (payload.tokenType !== undefined && payload.tokenType !== "access") return null;
    const exp = expiryMs(payload);
    if (exp === null || exp < Date.now()) return null;
    // The backend also requires a user id in the token.
    if (!payload.id) return null;
    return payload;
  } catch {
    return null;
  }
}
