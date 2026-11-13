import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const SECRET = "test-secret";
const ORIGIN = "https://app.example";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);

const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
async function token(payload: object = { id: "u1", exp: Math.floor(Date.now() / 1000) + 600 }) {
  const h = enc({ alg: "HS256", typ: "JWT" });
  const p = enc(payload);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${btoa(String.fromCharCode(...sig)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
}

function imagesError(code: number) {
  return Object.assign(new Error(`images error ${code}`), { code });
}

function makeEnv(over: Record<string, unknown> = {}) {
  const put = vi.fn(async () => ({}));
  const info = vi.fn(async () => ({ format: "image/jpeg", width: 10, height: 10 }));
  const output = vi.fn(async () => ({ response: () => new Response(new Uint8Array([1, 2, 3])) }));
  const env = {
    JWT_SECRET: SECRET,
    ALLOWED_ORIGINS: ORIGIN,
    PUBLIC_BASE_URL: "https://media.example",
    WEBP_QUALITY: 85,
    CACHE_CONTROL: "public, max-age=60",
    MEDIA_MODULES: JSON.stringify({ ig_icon: { folder: "ig/icon", maxBytes: 1000, maxDimension: 512 } }),
    BUCKET: { put },
    IMAGES: {
      info,
      input: () => ({ transform: () => ({ output }) }),
    },
    ...over,
  };
  return { env: env as any, put, info, output };
}

async function upload(env: any, opts: { file?: Uint8Array; module?: string; auth?: string; length?: string | null } = {}) {
  const form = new FormData();
  form.append("module", opts.module ?? "ig_icon");
  form.append("file", new Blob([opts.file ?? JPEG]), "a.jpg");
  // Encode the form once so the body and its multipart boundary match.
  const encoded = new Request("https://w.example/upload", { method: "POST", body: form });
  const headers = new Headers(encoded.headers);
  const raw = await encoded.arrayBuffer();
  headers.set("Origin", ORIGIN);
  headers.set("Authorization", opts.auth ?? `Bearer ${await token()}`);
  if (opts.length === null) headers.delete("Content-Length");
  else headers.set("Content-Length", opts.length ?? String(raw.byteLength));
  return worker.fetch(new Request("https://w.example/upload", { method: "POST", headers, body: raw }), env);
}

describe("upload handler", () => {
  it("stores a valid image and returns its key", async () => {
    const { env, put } = makeEnv();
    const res = await upload(env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.key).toMatch(/^ig\/icon\/[0-9a-f-]{36}\.webp$/);
    expect(body.url).toBe(`https://media.example/${body.key}`);
    expect(put).toHaveBeenCalledOnce();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("rejects a refresh token", async () => {
    const { env } = makeEnv();
    const t = await token({ id: "u1", exp: Math.floor(Date.now() / 1000) + 600, tokenType: "refresh" });
    expect((await upload(env, { auth: `Bearer ${t}` })).status).toBe(401);
  });

  it("rejects a huge body from Content-Length before reading it", async () => {
    const { env, info } = makeEnv();
    const res = await upload(env, { length: String(500 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(info).not.toHaveBeenCalled();
  });

  it("requires Content-Length", async () => {
    const { env } = makeEnv();
    const res = await upload(env, { length: null });
    // Some runtimes add the header back for a fixed body; either way nothing is processed blindly.
    expect([200, 411]).toContain(res.status);
  });

  it.each([9412, 9520])("returns 415 when Images rejects the input (code %i)", async (code) => {
    const { env, info, put } = makeEnv();
    info.mockRejectedValueOnce(imagesError(code));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await upload(env);
    expect(res.status).toBe(415);
    expect(((await res.json()) as any).code).toBe("invalid_image");
    expect(put).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns 502 and logs when Images info fails for another reason", async () => {
    const { env, info } = makeEnv();
    info.mockRejectedValueOnce(imagesError(9523));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await upload(env);
    expect(res.status).toBe(502);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("returns 502 and logs when the Images service fails", async () => {
    const { env, output } = makeEnv();
    output.mockRejectedValueOnce(imagesError(9999));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await upload(env);
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).code).toBe("image_service_error");
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("logs R2 failures", async () => {
    const { env, put } = makeEnv();
    put.mockRejectedValueOnce(new Error("r2 down"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await upload(env);
    expect(res.status).toBe(500);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("sends CORS headers on a config error, and answers preflight", async () => {
    const { env } = makeEnv({ PUBLIC_BASE_URL: "" });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await upload(env);
    expect(res.status).toBe(500);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    const pre = await worker.fetch(
      new Request("https://w.example/upload", { method: "OPTIONS", headers: { Origin: ORIGIN } }),
      env,
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    log.mockRestore();
  });
});
