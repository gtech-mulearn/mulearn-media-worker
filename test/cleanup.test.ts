import { describe, expect, it, vi } from "vitest";
import { CLEANUP_BATCH_SIZE, runCleanup } from "../src/cleanup";
import { ConfigError, loadCleanupConfig } from "../src/config";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const HOUR = 3_600_000;
const uuid = (n: number) => `${String(n).padStart(8, "0")}-1111-4222-8333-444444444444`;
const key = (folder: string, n: number) => `${folder}/${uuid(n)}.webp`;

type Obj = { key: string; uploaded: Date };
const old = (k: string): Obj => ({ key: k, uploaded: new Date(NOW - 48 * HOUR) });
const young = (k: string): Obj => ({ key: k, uploaded: new Date(NOW - 2 * HOUR) });

/** A bucket that lists in pages of `pageSize` and records deletes. */
function fakeBucket(objects: Obj[], pageSize = 1000) {
  const deleted: string[] = [];
  return {
    deleted,
    list: vi.fn(async ({ prefix, cursor }: { prefix: string; cursor?: string }) => {
      const all = objects.filter((o) => o.key.startsWith(prefix));
      const start = cursor ? Number(cursor) : 0;
      const objs = all.slice(start, start + pageSize);
      const truncated = start + pageSize < all.length;
      return { objects: objs, truncated, cursor: truncated ? String(start + pageSize) : undefined };
    }),
    delete: vi.fn(async (keys: string[]) => {
      deleted.push(...keys);
    }),
  };
}

const MODULES = JSON.stringify({
  ig_cover: { folder: "ig/cover", maxBytes: 1000, maxDimension: 100 },
  ig_icon: { folder: "ig/icon", maxBytes: 1000, maxDimension: 100 },
});

function makeEnv(bucket: ReturnType<typeof fakeBucket>, over: Record<string, unknown> = {}) {
  return {
    JWT_SECRET: "s",
    ALLOWED_ORIGINS: "https://app.example",
    PUBLIC_BASE_URL: "https://media.example",
    WEBP_QUALITY: 85,
    CACHE_CONTROL: "public",
    MEDIA_MODULES: MODULES,
    BACKEND_URL: "https://api.example/",
    BACKEND_API_KEY: "api-key",
    CLEANUP_GRACE_HOURS: 24,
    CLEANUP_MAX_DELETES: 1000,
    CLEANUP_DRY_RUN: false,
    BUCKET: bucket,
    IMAGES: {},
    ...over,
  } as any;
}

/** Backend stand-in: answers with every asked key not in `inUse`. */
function fakeBackend(inUse: Set<string> = new Set(), extra: string[] = []) {
  const calls: { url: string; headers: Record<string, string>; keys: string[] }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const keys = JSON.parse(String(init.body)).keys as string[];
    calls.push({ url, headers: init.headers as Record<string, string>, keys });
    return new Response(
      JSON.stringify({ hasError: false, response: { unreferenced: [...keys.filter((k) => !inUse.has(k)), ...extra] } }),
      { status: 200 },
    );
  });
  return { fn, calls };
}

const quiet = () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
};

describe("runCleanup", () => {
  it("deletes old images the backend says nothing uses, and keeps the rest", async () => {
    quiet();
    const a = key("ig/cover", 1), b = key("ig/cover", 2), c = key("ig/icon", 3);
    const bucket = fakeBucket([old(a), old(b), old(c)]);
    const backend = fakeBackend(new Set([b]));
    const res = await runCleanup(makeEnv(bucket), NOW, backend.fn as any);
    expect(bucket.deleted.sort()).toEqual([a, c].sort());
    expect(res).toMatchObject({ checked: 3, unreferenced: 2, deleted: 2, dryRun: false });
  });

  it("calls the backend with the Api-Key header and without a double slash", async () => {
    quiet();
    const bucket = fakeBucket([old(key("ig/cover", 1))]);
    const backend = fakeBackend();
    await runCleanup(makeEnv(bucket), NOW, backend.fn as any);
    expect(backend.calls[0].url).toBe("https://api.example/api/v1/media/unreferenced-keys/");
    expect(backend.calls[0].headers["Api-Key"]).toBe("api-key");
  });

  it("never touches images younger than the grace period", async () => {
    quiet();
    const fresh = key("ig/cover", 1);
    const bucket = fakeBucket([young(fresh)]);
    const backend = fakeBackend();
    const res = await runCleanup(makeEnv(bucket), NOW, backend.fn as any);
    expect(backend.fn).not.toHaveBeenCalled();
    expect(bucket.deleted).toEqual([]);
    expect(res.checked).toBe(0);
  });

  it("ignores objects that are not named like worker uploads", async () => {
    quiet();
    const bucket = fakeBucket([
      old("ig/cover/notes.txt"),
      old("ig/cover/not-a-uuid.webp"),
      old(`ig/cover/sub/${uuid(9)}.webp`),
      old(key("ig/cover", 1)),
    ]);
    const backend = fakeBackend();
    await runCleanup(makeEnv(bucket), NOW, backend.fn as any);
    expect(backend.calls[0].keys).toEqual([key("ig/cover", 1)]);
  });

  it("dry run logs but deletes nothing", async () => {
    quiet();
    const bucket = fakeBucket([old(key("ig/cover", 1))]);
    const res = await runCleanup(makeEnv(bucket, { CLEANUP_DRY_RUN: true }), NOW, fakeBackend().fn as any);
    expect(bucket.delete).not.toHaveBeenCalled();
    expect(res).toMatchObject({ unreferenced: 1, deleted: 1, dryRun: true });
  });

  it("deletes nothing when the backend errors", async () => {
    quiet();
    const bucket = fakeBucket([old(key("ig/cover", 1))]);
    const failing = vi.fn(async () => new Response("nope", { status: 500 }));
    const res = await runCleanup(makeEnv(bucket), NOW, failing as any);
    expect(bucket.delete).not.toHaveBeenCalled();
    expect(res.aborted).toContain("HTTP 500");
  });

  it("deletes nothing when the backend cannot be reached", async () => {
    quiet();
    const bucket = fakeBucket([old(key("ig/cover", 1))]);
    const down = vi.fn(async () => {
      throw new Error("network down");
    });
    const res = await runCleanup(makeEnv(bucket), NOW, down as any);
    expect(bucket.delete).not.toHaveBeenCalled();
    expect(res.aborted).toBe("network down");
  });

  it.each([
    ["wrong shape", { hasError: false, response: {} }],
    ["error flag", { hasError: true, response: { unreferenced: [] } }],
    ["non-string entries", { hasError: false, response: { unreferenced: [1, 2] } }],
  ])("deletes nothing on a malformed backend answer (%s)", async (_name, body) => {
    quiet();
    const bucket = fakeBucket([old(key("ig/cover", 1))]);
    const odd = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    const res = await runCleanup(makeEnv(bucket), NOW, odd as any);
    expect(bucket.delete).not.toHaveBeenCalled();
    expect(res.aborted).toBeTruthy();
  });

  it("ignores keys the backend names that this run did not ask about", async () => {
    quiet();
    const asked = key("ig/cover", 1);
    const stranger = key("ig/cover", 99); // exists in the bucket? no - never asked about
    const bucket = fakeBucket([old(asked)]);
    const backend = fakeBackend(new Set(), [stranger]);
    await runCleanup(makeEnv(bucket), NOW, backend.fn as any);
    expect(bucket.deleted).toEqual([asked]);
  });

  it("stops at CLEANUP_MAX_DELETES", async () => {
    quiet();
    const objects = Array.from({ length: 10 }, (_, i) => old(key("ig/cover", i + 1)));
    const bucket = fakeBucket(objects);
    const res = await runCleanup(makeEnv(bucket, { CLEANUP_MAX_DELETES: 4 }), NOW, fakeBackend().fn as any);
    expect(bucket.deleted).toHaveLength(4);
    expect(res.deleted).toBe(4);
  });

  it("walks every bucket page and batches the questions", async () => {
    quiet();
    const total = CLEANUP_BATCH_SIZE * 2 + 5;
    const objects = Array.from({ length: total }, (_, i) => old(key("ig/cover", i + 1)));
    const bucket = fakeBucket(objects, 150); // several list pages
    const backend = fakeBackend();
    const res = await runCleanup(makeEnv(bucket), NOW, backend.fn as any);
    expect(bucket.list.mock.calls.length).toBeGreaterThan(1);
    expect(res.checked).toBe(total);
    expect(bucket.deleted).toHaveLength(total);
    expect(Math.max(...backend.calls.map((c) => c.keys.length))).toBeLessThanOrEqual(CLEANUP_BATCH_SIZE);
  });

  it("is skipped, without error, when the backend is not configured", async () => {
    quiet();
    const bucket = fakeBucket([old(key("ig/cover", 1))]);
    const backend = fakeBackend();
    const res = await runCleanup(makeEnv(bucket, { BACKEND_URL: "", BACKEND_API_KEY: "" }), NOW, backend.fn as any);
    expect(res.skipped).toBeTruthy();
    expect(backend.fn).not.toHaveBeenCalled();
    expect(bucket.list).not.toHaveBeenCalled();
  });

  it("stops on invalid tuning values instead of guessing", async () => {
    quiet();
    const bucket = fakeBucket([old(key("ig/cover", 1))]);
    const res = await runCleanup(makeEnv(bucket, { CLEANUP_DRY_RUN: "maybe" }), NOW, fakeBackend().fn as any);
    expect(res.aborted).toContain("CLEANUP_DRY_RUN");
    expect(bucket.list).not.toHaveBeenCalled();
  });
});

describe("loadCleanupConfig", () => {
  const base = {
    BACKEND_URL: "https://api.example/",
    BACKEND_API_KEY: " key ",
    CLEANUP_GRACE_HOURS: 24,
    CLEANUP_MAX_DELETES: 500,
    CLEANUP_DRY_RUN: "true",
  };

  it("reads values from wrangler.toml types and strings", () => {
    expect(loadCleanupConfig(base)).toEqual({
      backendUrl: "https://api.example",
      backendApiKey: "key",
      graceMs: 24 * HOUR,
      maxDeletes: 500,
      dryRun: true,
    });
    expect(loadCleanupConfig({ ...base, CLEANUP_GRACE_HOURS: "6", CLEANUP_DRY_RUN: false })).toMatchObject({
      graceMs: 6 * HOUR,
      dryRun: false,
    });
  });

  it("is null when the backend connection is not set", () => {
    expect(loadCleanupConfig({ ...base, BACKEND_URL: "" })).toBeNull();
    expect(loadCleanupConfig({ ...base, BACKEND_API_KEY: undefined })).toBeNull();
  });

  it.each([
    { BACKEND_URL: "not a url" },
    { BACKEND_URL: "ftp://api.example" },
    { CLEANUP_GRACE_HOURS: 0 },
    { CLEANUP_MAX_DELETES: "lots" },
    { CLEANUP_DRY_RUN: "yes" },
    { CLEANUP_DRY_RUN: undefined },
  ])("rejects bad values %j", (bad) => {
    expect(() => loadCleanupConfig({ ...base, ...bad })).toThrow(ConfigError);
  });
});
