# mulearn-media-worker

A Cloudflare Worker that receives image uploads, checks the user, validates the image,
resizes it, converts it to WebP, stores it in R2 and returns a **key**.
The backend only stores that key and builds the public URL from it. It never handles image bytes.

> All names, domains and values in this file are **examples**. Real values live in `wrangler.toml`,
> your local `.env`, and your GitHub environments. Never put secrets in this file.

## How it works
1. The client sends `POST <worker-url>/upload` (multipart `file` and `module`) with
   `Authorization: Bearer <access token>`.
2. The worker checks the token (only access tokens are accepted), the body size, the module,
   the file size and the real image type.
3. The worker resizes the image (never upscales), converts it to WebP and writes
   `<folder>/<uuid>.webp` to the R2 bucket.
4. The worker answers `{ "key": "...", "url": "<public-url>/<key>", "size": 12345 }`.
5. The client sends `{ "key": "..." }` to the backend endpoint that needs the image.
6. The backend saves the key. When it returns the record, it builds the public URL from the key.

## Environments
| | dev | production |
|---|---|---|
| Git branch | `dev-server` | `production` |
| Worker name | `<worker-name>` | `<worker-name>-prod` |
| R2 bucket | `<dev-bucket>` | `<prod-bucket>` |
| Upload URL | `https://<worker-domain>/upload` | `https://<prod-worker-domain>/upload` |
| Public image URL | `https://<media-domain>/<key>` | `https://<prod-media-domain>/<key>` |

In `wrangler.toml`, the top level is dev and `[env.production]` is production.
Wrangler does not copy `[vars]` or bindings into `[env.production]`, so shared values appear in both.

## Configuration
Nothing is hard-coded in the code. If a value is missing or invalid, the worker answers
`500 server_misconfigured` and logs which setting is wrong (never its value).

| Name | Kind | Where it lives | Meaning |
|---|---|---|---|
| `WEBP_QUALITY` | setting | `wrangler.toml` `[vars]` | WebP quality, 1-100 |
| `CACHE_CONTROL` | setting | `wrangler.toml` `[vars]` | Cache-Control header stored with each image |
| `MEDIA_MODULES` | setting | `wrangler.toml` `[vars]` | JSON describing each upload module (see below) |
| `JWT_SECRET` | **secret** | `.env` locally, GitHub secret in CI | Key that signs the access tokens (same as the backend) |
| `ALLOWED_ORIGINS` | value | `.env` locally, GitHub variable in CI | Comma-separated browser origins allowed to call `/upload` |
| `PUBLIC_BASE_URL` | value | `.env` locally, GitHub variable in CI | Public URL of the bucket (same as the backend's public URL setting) |
| `WORKER_DOMAIN` | value | `.env` locally, GitHub variable in CI | Custom domain the worker is deployed to. Passed as `--domain`; not read by the code |

`wrangler.toml` also holds the names Wrangler needs at deploy time: the worker name and the
R2 bucket name. Wrangler cannot read those from `.env` or the command line.

### MEDIA_MODULES format
```json
{
  "<module_name>": {
    "folder": "<r2/folder/path>",
    "maxBytes": 5242880,
    "maxDimension": 1024
  }
}
```
- `module_name`: what the client sends in the `module` field.
- `folder`: where files go in the bucket. It must match the backend's module setting.
- `maxBytes`: largest accepted upload.
- `maxDimension`: images are scaled down to fit inside this width and height.

To add a module, add an entry here (dev and production) and in the backend, then deploy.

### Local `.env`
Copy `.env.example` to `.env` and fill it in. `.env` is git-ignored.
```
JWT_SECRET='<same-secret-as-the-backend>'
ALLOWED_ORIGINS=http://localhost:3000
PUBLIC_BASE_URL=https://<media-domain>
WORKER_DOMAIN=<worker-domain>
```
Quoting rules for `npm run dev` (Wrangler's `.env` parser):
- Use single quotes for values that contain `#` or `"`. Without quotes, everything after `#` is dropped.
- A `$` is read as a variable, even inside single quotes. Write it as `\$`.
- A `"` inside a double-quoted value cuts the value short.

`npm run deploy` and CI send secrets as JSON, so these rules do not apply there.

## Commands
| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | Run locally with `.env`. R2 is simulated on your machine |
| `npm run deploy` | Deploy the dev worker from your machine (`scripts/deploy-dev.mjs`). Add `-- --dry-run` to test without deploying |
| `npm run typecheck` | Type check |
| `npm test` | Unit tests |

Production is deployed only by CI. Wrangler 4 and Node 22.12 or newer are required.

## Errors
Body: `{ "error": "...", "code": "..." }`

| Status | Code | Meaning |
|---|---|---|
| 400 | `bad_request`, `bad_module`, `empty_file` | Missing field, unknown module, or empty file |
| 401 | `unauthorized` | Missing, invalid or expired token, or not an access token (refresh and signup tokens are refused) |
| 411 | `length_required` | No `Content-Length` header |
| 413 | `too_large` | Body bigger than the largest module allows (checked before reading it), or file over the module's `maxBytes` |
| 415 | `unsupported_type`, `invalid_image` | Not a real JPEG, PNG, WebP or GIF, or the image could not be read |
| 500 | `server_misconfigured`, `storage_error` | A setting is missing, or R2 failed |
| 502 | `image_service_error` | Cloudflare Images failed; safe to retry |

Images, R2 and config failures are logged with their error code (never secret values).

## Troubleshooting
- **401 on every request locally:** the secret in `.env` was cut short (see the quoting rules), or the
  token was signed with a different secret.
- **Uploaded images do not open locally:** `npm run dev` writes to a simulated bucket. Images only load
  from the public URL after a real deploy.
- **Deploy fails with Cloudflare error `10013`:** check the Cloudflare status page first, since
  this error appeared during a Workers API incident. If a name exists as both a secret on the
  worker and a `[vars]` entry, delete the secret (`npx wrangler secret delete <NAME>`).
- **"Wrangler requires at least Node.js v22.12.0":** use Node 22 or newer (the workflow sets it).
- **Custom domain is not attached after deploy:** confirm `WORKER_DOMAIN` is set and the token covers that zone.

## Notes
- The database stores only keys, so changing the public domain changes every image URL at once. Update
  `PUBLIC_BASE_URL` (worker) and the backend's public URL setting together.
- Images that are replaced or never attached are not deleted yet.
- Animated GIFs are stored as a single still frame.
- The `workers.dev` address and preview URLs are turned off. Only the custom domain answers.
