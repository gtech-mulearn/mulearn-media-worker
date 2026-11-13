# mulearn-media-worker

Cloudflare Worker that receives image uploads from the dashboard, checks the user,
validates the image, resizes it, converts it to WebP, stores it in R2 and returns a **key**.
The Django backend only stores that key and builds the public URL from it.

## Environments and URLs
| | dev | production |
|---|---|---|
| Git branch | `dev-server` | `production` |
| Worker name | `mulearn-media-worker` | `mulearn-media-worker-prod` |
| Upload endpoint | `https://mulearn-media-worker.devwithpranav.in/upload` | TODO (`WORKER_DOMAIN` in the `production` GitHub environment) |
| R2 bucket | `mulearn-media` | `mulearn-media-prod` (TODO: create) |
| Public images | `https://media.devwithpranav.in/<key>` | TODO |

The dev worker also answers at `https://mulearn-media-worker.pranavp92075.workers.dev/upload`.

## Flow
1. `POST /upload` (multipart `file`, `module`) with `Authorization: Bearer <access token>`
2. Worker verifies the token (HS256 with `JWT_SECRET`; needs `id` and the backend's
   `expiry` string, or a numeric `exp`), the module, size and real image type
3. Worker resizes (no upscaling), converts to WebP, writes `<folder>/<uuid>.webp` to R2
4. Response: `{ "key": "...", "url": "<public url>", "size": 12345 }`
5. Frontend sends `{ "key": "..." }` to the backend endpoint it needs

## Configuration
| Name | Where it lives | Meaning |
|---|---|---|
| `WEBP_QUALITY` | `wrangler.toml` `[vars]` | WebP quality, 1-100 |
| `CACHE_CONTROL` | `wrangler.toml` `[vars]` | Cache-Control header stored with each image |
| `MEDIA_MODULES` | `wrangler.toml` `[vars]` | JSON: module -> `folder`, `maxBytes`, `maxDimension`. Folders must match the backend's `MEDIA_MODULES` |
| `JWT_SECRET` | `.env` locally, GitHub secret in CI | Same as backend `SECRET_KEY` |
| `ALLOWED_ORIGINS` | `.env` locally, GitHub variable in CI | Comma-separated browser origins allowed to call `/upload` |
| `PUBLIC_BASE_URL` | `.env` locally, GitHub variable in CI | Public URL of the bucket (same as backend `R2_PUBLIC_BASE_URL`) |
| `WORKER_DOMAIN` | `.env` locally, GitHub variable in CI | The worker's custom domain. Passed as `--domain` at deploy; not a secret and not read by the code |

No URL or domain is written in the code or in `wrangler.toml`. Only names remain in `wrangler.toml`
(worker name, bucket name), because Wrangler cannot take those from `.env` or the command line.

`wrangler.toml` top level is **dev**; `[env.production]` is **production**. Wrangler does not
copy `[vars]` or bindings into `[env.production]`, so change shared values in both places.

If any value is missing or invalid, the worker answers `500 server_misconfigured` and logs
which setting is wrong.

A name must not be both a `[vars]` entry and a Worker secret. When moving a value from secrets
to `wrangler.toml`, delete the secret first (`npx wrangler secret delete NAME --env ""`).

### Quoting values in .env
Wrangler's `.env` parser:
- Use **single quotes** for values with `#` or `"` (for example `JWT_SECRET='...'`).
- A `$` is treated as a variable even inside single quotes; escape it as `\$`.
- A `"` inside a double-quoted value cuts the value short.

These rules matter only for `npm run dev`. `npm run deploy` and CI upload secrets as JSON,
so they are not affected.

## CI/CD (GitHub Actions)
`.github/workflows/deploy.yml`:
- On every pull request into `dev-server` or `production`, it runs the typecheck and tests only.
- On a push to `dev-server`, it runs the checks, then deploys the **dev** worker.
- On a push to `production`, it runs the checks, then deploys the **production** worker.

### One-time GitHub setup
In the GitHub repo, open **Settings → Environments** and create two environments, `dev` and `production`.
In each one, add:

| Kind | Name | Value |
|---|---|---|
| Secret | `JWT_SECRET` | Backend `SECRET_KEY` for that environment |
| Secret | `CLOUDFLARE_API_TOKEN` | Cloudflare API token ("Edit Cloudflare Workers" template; add R2 edit) |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| Variable | `ALLOWED_ORIGINS` | Dashboard origin(s) for that environment |
| Variable | `PUBLIC_BASE_URL` | Public bucket URL for that environment |
| Variable | `WORKER_DOMAIN` | Worker custom domain for that environment (dev: `mulearn-media-worker.devwithpranav.in`) |

`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` can be repository secrets instead, if both
environments use the same Cloudflare account. Optionally, add required reviewers on the
`production` environment so every production deploy needs an approval.

### Before the first production deploy
1. Create the production R2 bucket and connect its public custom domain.
2. In `wrangler.toml` `[env.production]`, set the real `bucket_name`.
3. Fill in the `production` GitHub environment values, including `WORKER_DOMAIN`.

## Adding a module
Add an entry to `MEDIA_MODULES` in `wrangler.toml` (both dev and production) and in the backend
`.env` files, then deploy.

## Commands
| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | Run the dev config locally (reads `.env`, uses a simulated R2 bucket) |
| `npm run deploy` | Deploy the **dev** worker from your machine (`scripts/deploy-dev.mjs`: uses `WORKER_DOMAIN` from `.env` and uploads the three secrets as JSON). Add `-- --dry-run` to test |
| `npm run typecheck` / `npm test` | Checks |

Production is deployed only by CI from the `production` branch.
Needs Wrangler 4 (Wrangler 3 rejected every token in local dev).

## Errors
`401` bad or expired token, `400` bad module or missing field, `413` too large,
`415` not a real image, `500` server misconfigured or storage error.
Body: `{ "error": "...", "code": "..." }`.

## Notes
- Local `npm run dev` writes to a simulated bucket, so returned URLs only load after deploy.
- The database stores only keys, so changing the public domain changes every image URL at once;
  update `PUBLIC_BASE_URL` (worker) and `R2_PUBLIC_BASE_URL` (backend) together.
- Orphan images (uploaded but never attached, or replaced) are not deleted yet.
- Animated GIFs are stored as a single still frame.
