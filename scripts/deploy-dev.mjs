// Local deploy of the dev worker: `npm run deploy`.
// Reads .env, passes WORKER_DOMAIN as --domain, and uploads only the worker's
// secrets (as JSON, so # " $ in values are not mangled by Wrangler's .env parser).
// CI does the same thing in .github/workflows/deploy.yml.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";

const SECRETS = ["JWT_SECRET", "ALLOWED_ORIGINS", "PUBLIC_BASE_URL"];

function readEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (v.length >= 2 && (v[0] === "'" || v[0] === '"') && v.at(-1) === v[0]) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const env = readEnv(".env");
const missing = [...SECRETS, "WORKER_DOMAIN"].filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(", ")}`);
  process.exit(1);
}

const file = "secrets.json";
writeFileSync(file, JSON.stringify(Object.fromEntries(SECRETS.map((k) => [k, env[k]]))), { mode: 0o600 });
try {
  const r = spawnSync(
    "npx",
    // Extra args are passed through, e.g. `npm run deploy -- --dry-run`.
    ["wrangler", "deploy", "--env", '""', "--domain", env.WORKER_DOMAIN, "--secrets-file", file, ...process.argv.slice(2)],
    { stdio: "inherit", shell: true },
  );
  process.exitCode = r.status ?? 1;
} finally {
  rmSync(file, { force: true });
}
