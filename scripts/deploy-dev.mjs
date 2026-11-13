// Local deploy of the dev worker: `npm run deploy`.
// Reads .env, passes WORKER_DOMAIN as --domain, and uploads only the worker's
// secrets (as JSON, so # " $ in values are not mangled by Wrangler's .env parser).
// CI does the same thing in .github/workflows/deploy.yml.
//
// Wrangler is started directly with Node (no shell), so values are passed as
// separate arguments and are never interpreted by cmd.exe or sh.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { EnvFileError, parseEnvFile } from "./env-file.mjs";

const SECRETS = ["JWT_SECRET", "ALLOWED_ORIGINS", "PUBLIC_BASE_URL"];
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function fail(message) {
  console.error(message);
  process.exit(1);
}

let env;
try {
  env = parseEnvFile(readFileSync(".env", "utf8"));
} catch (e) {
  fail(e instanceof EnvFileError ? `.env ${e.message}` : `Could not read .env: ${e.message}`);
}

const missing = [...SECRETS, "WORKER_DOMAIN"].filter((k) => !env[k]);
if (missing.length) fail(`Missing in .env: ${missing.join(", ")}`);
if (!HOSTNAME.test(env.WORKER_DOMAIN)) fail("WORKER_DOMAIN must be a plain hostname, e.g. media-worker.example.com");

// Locate the wrangler CLI installed in node_modules.
const require = createRequire(import.meta.url);
const pkgPath = require.resolve("wrangler/package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.wrangler;
const wrangler = join(dirname(pkgPath), bin);

const file = "secrets.json";
writeFileSync(file, JSON.stringify(Object.fromEntries(SECRETS.map((k) => [k, env[k]]))), { mode: 0o600 });
try {
  const r = spawnSync(
    process.execPath,
    // --env "" targets the top-level (dev) config. Extra args pass through,
    // e.g. `npm run deploy -- --dry-run`.
    [wrangler, "deploy", "--env", "", "--domain", env.WORKER_DOMAIN, "--secrets-file", file, ...process.argv.slice(2)],
    { stdio: "inherit", shell: false },
  );
  if (r.error) console.error(r.error.message);
  process.exitCode = r.status ?? 1;
} finally {
  rmSync(file, { force: true });
}
