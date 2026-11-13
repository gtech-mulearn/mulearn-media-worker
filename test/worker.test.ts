import { describe, expect, it } from "vitest";
import { verifyJwt } from "../src/jwt";
import { sniffImage } from "../src/sniff";

const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

async function sign(payload: object, secret: string): Promise<string> {
  const h = enc({ alg: "HS256", typ: "JWT" });
  const p = enc(payload);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${h}.${p}`)));
  const s = btoa(String.fromCharCode(...sig)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${h}.${p}.${s}`;
}

// Same format as the Django backend: "%Y-%m-%d %H:%M:%S%z"
const djangoExpiry = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ") + "+0000";

describe("verifyJwt", () => {
  const future = Math.floor(Date.now() / 1000) + 60;
  it("accepts a valid token", async () => {
    expect(await verifyJwt(await sign({ id: "u1", exp: future }, "s3cret"), "s3cret")).not.toBeNull();
  });
  it("accepts a Django-style token with an expiry string", async () => {
    const tok = await sign({ id: "u1", expiry: djangoExpiry(Date.now() + 3600_000) }, "s3cret");
    expect(await verifyJwt(tok, "s3cret")).not.toBeNull();
  });
  it("rejects an expired Django-style token", async () => {
    const tok = await sign({ id: "u1", expiry: djangoExpiry(Date.now() - 3600_000) }, "s3cret");
    expect(await verifyJwt(tok, "s3cret")).toBeNull();
  });
  it("rejects a token with no expiry or no id", async () => {
    expect(await verifyJwt(await sign({ id: "u1" }, "s3cret"), "s3cret")).toBeNull();
    expect(await verifyJwt(await sign({ exp: future }, "s3cret"), "s3cret")).toBeNull();
  });
  it("rejects wrong secret", async () => {
    expect(await verifyJwt(await sign({ id: "u1", exp: future }, "s3cret"), "other")).toBeNull();
  });
  it("rejects expired token", async () => {
    expect(await verifyJwt(await sign({ id: "u1", exp: 1 }, "s3cret"), "s3cret")).toBeNull();
  });
  it("rejects garbage", async () => {
    expect(await verifyJwt("a.b.c", "s3cret")).toBeNull();
    expect(await verifyJwt("nope", "s3cret")).toBeNull();
  });
});

describe("sniffImage", () => {
  it("detects real types", () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
    expect(sniffImage(new TextEncoder().encode("GIF89a"))).toBe("gif");
    expect(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBP"))).toBe("webp");
  });
  it("rejects non-images", () => {
    expect(sniffImage(new TextEncoder().encode("<?php echo 1;"))).toBeNull();
  });
});
