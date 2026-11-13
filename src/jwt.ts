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

/** Returns the payload if signature and expiry are valid, otherwise null. */
export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || !secret) return null;
  const [h, p, s] = parts;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    if (header.alg !== "HS256") return null;

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlToBytes(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!ok) return null;

    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as JwtPayload;
    const exp = expiryMs(payload);
    if (exp === null || exp < Date.now()) return null;
    // The backend also requires a user id in the token.
    if (!payload.id) return null;
    return payload;
  } catch {
    return null;
  }
}
