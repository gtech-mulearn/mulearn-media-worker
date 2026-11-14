// All runtime settings come from the environment. Shared, non-secret values are
// [vars] in wrangler.toml; per-environment values (JWT_SECRET, ALLOWED_ORIGINS,
// PUBLIC_BASE_URL) come from .env locally and from the deploy environment.
// Nothing here has a built-in default: a missing or invalid value is a
// configuration error.

export interface ModuleRule {
  folder: string;
  maxBytes: number;
  maxDimension: number;
}

export interface Config {
  jwtSecret: string;
  allowedOrigins: string[];
  publicBaseUrl: string;
  webpQuality: number;
  cacheControl: string;
  modules: Record<string, ModuleRule>;
  /** Largest maxBytes of any module; used to reject huge bodies before reading them. */
  maxFileBytes: number;
}

export type RawEnv = Record<string, unknown>;

export class ConfigError extends Error {}

function str(env: RawEnv, name: string): string {
  const v = env[name];
  if (typeof v !== "string" || v.trim() === "") throw new ConfigError(`${name} is not set`);
  return v.trim();
}

function int(env: RawEnv, name: string, min: number, max: number): number {
  // wrangler.toml numbers arrive as numbers; .env values arrive as strings.
  const v = env[name];
  const n = typeof v === "number" ? v : Number(str(env, name));
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

function parseModules(env: RawEnv): Record<string, ModuleRule> {
  // Accept a JSON string (as written in wrangler.toml) or an already-parsed
  // object (if written as a TOML table). Names and folders must match the
  // backend's utils/media_modules.py.
  const v = env.MEDIA_MODULES;
  let data: unknown = v;
  if (typeof v !== "object" || v === null) {
    try {
      data = JSON.parse(str(env, "MEDIA_MODULES"));
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      throw new ConfigError("MEDIA_MODULES is not valid JSON");
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ConfigError("MEDIA_MODULES must be a JSON object");
  }
  const out: Record<string, ModuleRule> = {};
  for (const [name, r] of Object.entries(data as Record<string, any>)) {
    const folder = typeof r?.folder === "string" ? r.folder.replace(/^\/+|\/+$/g, "") : "";
    const ok =
      /^[a-z0-9_]+$/.test(name) &&
      /^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/.test(folder) &&
      Number.isInteger(r?.maxBytes) && r.maxBytes > 0 &&
      Number.isInteger(r?.maxDimension) && r.maxDimension > 0;
    if (!ok) throw new ConfigError(`MEDIA_MODULES entry "${name}" is invalid`);
    out[name] = { folder, maxBytes: r.maxBytes, maxDimension: r.maxDimension };
  }
  if (Object.keys(out).length === 0) throw new ConfigError("MEDIA_MODULES is empty");
  return out;
}

/** ALLOWED_ORIGINS on its own, so CORS still works when another setting is broken. */
export function parseOrigins(env: RawEnv): string[] {
  return str(env, "ALLOWED_ORIGINS").split(",").map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env: RawEnv): Config {
  const modules = parseModules(env);
  return {
    jwtSecret: str(env, "JWT_SECRET"),
    allowedOrigins: parseOrigins(env),
    publicBaseUrl: str(env, "PUBLIC_BASE_URL").replace(/\/+$/, ""),
    webpQuality: int(env, "WEBP_QUALITY", 1, 100),
    cacheControl: str(env, "CACHE_CONTROL"),
    modules,
    maxFileBytes: Math.max(...Object.values(modules).map((m) => m.maxBytes)),
  };
}

// env is fixed for the life of the isolate, so parse it once per env object.
// Only successful parses are cached; a broken config is re-checked each time.
const cache = new WeakMap<object, Config>();

export function getConfig(env: RawEnv): Config {
  let cfg = cache.get(env);
  if (!cfg) {
    cfg = loadConfig(env);
    cache.set(env, cfg);
  }
  return cfg;
}

// ─────────────────────────────────────────────────────────────
// Scheduled cleanup of unused images (see src/cleanup.ts)
// ─────────────────────────────────────────────────────────────

export interface CleanupConfig {
  /** Backend base URL, no trailing slash. */
  backendUrl: string;
  /** Sent as the Api-Key header; same value as the backend's BACKEND_API_KEY. */
  backendApiKey: string;
  /** Images younger than this are never touched (an upload may not be attached yet). */
  graceMs: number;
  /** Most images one run may delete, as a safety limit. */
  maxDeletes: number;
  /** When true, the run only logs what it would delete. */
  dryRun: boolean;
}

function bool(env: RawEnv, name: string): boolean {
  const v = env[name];
  if (typeof v === "boolean") return v;
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "true") return true;
  if (s === "false") return false;
  throw new ConfigError(`${name} must be true or false`);
}

/**
 * Cleanup settings, or null when the backend connection is not configured
 * (cleanup is then skipped; uploads are not affected). A backend connection
 * with invalid tuning values is a ConfigError, so a typo cannot turn into a
 * run that deletes more than intended.
 */
export function loadCleanupConfig(env: RawEnv): CleanupConfig | null {
  const url = typeof env.BACKEND_URL === "string" ? env.BACKEND_URL.trim() : "";
  const key = typeof env.BACKEND_API_KEY === "string" ? env.BACKEND_API_KEY.trim() : "";
  if (!url || !key) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError("BACKEND_URL is not a valid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ConfigError("BACKEND_URL must start with https:// or http://");
  }

  return {
    backendUrl: url.replace(/\/+$/, ""),
    backendApiKey: key,
    graceMs: int(env, "CLEANUP_GRACE_HOURS", 1, 24 * 365) * 3_600_000,
    maxDeletes: int(env, "CLEANUP_MAX_DELETES", 1, 100_000),
    dryRun: bool(env, "CLEANUP_DRY_RUN"),
  };
}
