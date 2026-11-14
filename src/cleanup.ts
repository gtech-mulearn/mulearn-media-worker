// Scheduled cleanup: delete images that no record uses any more.
//
// Replaced, removed and never-attached uploads stay in the bucket, because the
// backend holds no storage credentials. Once a day this job lists the images,
// asks the backend which of them nothing points at, and deletes those.
//
// Safety rules:
//   - only images older than the grace period are considered (an upload may
//     still be waiting to be attached);
//   - only keys that match the exact format the worker issues are considered;
//   - only keys the backend names, and that this run asked about, are deleted;
//   - if the backend cannot be reached or answers oddly, nothing is deleted;
//   - one run deletes at most CLEANUP_MAX_DELETES images;
//   - CLEANUP_DRY_RUN=true only logs what would be deleted.
import { ConfigError, getConfig, loadCleanupConfig, type CleanupConfig } from "./config";
import type { Env } from "./types";

/** Keys asked about per backend call. The backend accepts up to 500. */
export const CLEANUP_BATCH_SIZE = 200;

const BACKEND_TIMEOUT_MS = 15_000;
const UNREFERENCED_PATH = "/api/v1/media/unreferenced-keys/";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export interface CleanupResult {
  /** Why the run did nothing or stopped early, if it did. */
  skipped?: string;
  aborted?: string;
  /** Old, correctly named images that were checked against the backend. */
  checked: number;
  /** Images the backend said nothing uses. */
  unreferenced: number;
  /** Images deleted (or, in a dry run, that would be deleted). */
  deleted: number;
  dryRun: boolean;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function askBackend(cc: CleanupConfig, keys: string[], doFetch: FetchLike): Promise<string[]> {
  const res = await doFetch(`${cc.backendUrl}${UNREFERENCED_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Api-Key": cc.backendApiKey },
    body: JSON.stringify({ keys }),
    signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`backend answered HTTP ${res.status}`);

  const data = (await res.json().catch(() => null)) as {
    hasError?: boolean;
    response?: { unreferenced?: unknown };
  } | null;
  const list = data?.response?.unreferenced;
  if (data?.hasError || !Array.isArray(list) || !list.every((k) => typeof k === "string")) {
    throw new Error("backend answer was not a list of keys");
  }
  return list as string[];
}

export async function runCleanup(
  env: Env,
  now: number = Date.now(),
  doFetch: FetchLike = fetch,
): Promise<CleanupResult> {
  const result: CleanupResult = { checked: 0, unreferenced: 0, deleted: 0, dryRun: true };

  let cc: CleanupConfig | null;
  let folders: string[];
  try {
    cc = loadCleanupConfig(env);
    folders = [...new Set(Object.values(getConfig(env).modules).map((m) => m.folder))];
  } catch (e) {
    result.aborted = e instanceof ConfigError ? e.message : String(e);
    console.error("Cleanup config error:", result.aborted);
    return result;
  }
  if (!cc) {
    result.skipped = "BACKEND_URL or BACKEND_API_KEY is not set";
    console.log("Cleanup skipped:", result.skipped);
    return result;
  }
  result.dryRun = cc.dryRun;

  const cutoff = now - cc.graceMs;
  const wouldDelete: string[] = [];

  // Ask about one batch and delete what the backend says is unused.
  const processBatch = async (batch: string[]): Promise<void> => {
    const answer = await askBackend(cc, batch, doFetch);
    const asked = new Set(batch);
    // Ignore anything the backend names that this run did not ask about.
    let unused = [...new Set(answer)].filter((k) => asked.has(k));
    result.checked += batch.length;
    result.unreferenced += unused.length;

    unused = unused.slice(0, cc.maxDeletes - result.deleted);
    if (unused.length === 0) return;
    if (!cc.dryRun) await env.BUCKET.delete(unused);
    result.deleted += unused.length;
    wouldDelete.push(...unused);
  };

  const budgetLeft = () => result.deleted < cc.maxDeletes;

  try {
    for (const folder of folders) {
      const keyPattern = new RegExp(`^${escapeRegex(folder)}/${UUID}\\.webp$`);
      let candidates: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await env.BUCKET.list({ prefix: `${folder}/`, cursor, limit: 1000 });
        for (const obj of page.objects) {
          if (obj.uploaded.getTime() <= cutoff && keyPattern.test(obj.key)) candidates.push(obj.key);
        }
        while (candidates.length >= CLEANUP_BATCH_SIZE && budgetLeft()) {
          await processBatch(candidates.splice(0, CLEANUP_BATCH_SIZE));
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor && budgetLeft());
      if (candidates.length > 0 && budgetLeft()) await processBatch(candidates);
      if (!budgetLeft()) break;
    }
  } catch (e) {
    // Nothing in the failing batch was deleted: the delete only runs after a good answer.
    result.aborted = e instanceof Error ? e.message : String(e);
    console.error("Cleanup stopped:", result.aborted);
  }

  console.log(
    `Cleanup ${cc.dryRun ? "(dry run) " : ""}done: checked=${result.checked} ` +
      `unreferenced=${result.unreferenced} ${cc.dryRun ? "would_delete" : "deleted"}=${result.deleted}` +
      (result.aborted ? ` stopped_early="${result.aborted}"` : "") +
      (result.deleted >= cc.maxDeletes ? " (hit CLEANUP_MAX_DELETES)" : ""),
  );
  if (cc.dryRun && wouldDelete.length > 0) {
    console.log("Would delete (first 20):", wouldDelete.slice(0, 20).join(", "));
  }
  return result;
}
