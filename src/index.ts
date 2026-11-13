import { ConfigError, loadConfig, type Config } from "./config";
import { corsHeaders, fail, json } from "./http";
import { verifyJwt } from "./jwt";
import { sniffImage } from "./sniff";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let cfg: Config;
    try {
      cfg = loadConfig(env);
    } catch (e) {
      // Log which setting is wrong (never its value); keep the response generic.
      console.error("Config error:", e instanceof ConfigError ? e.message : e);
      return fail(500, "server_misconfigured", "Server is not configured correctly");
    }

    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get("Origin"), cfg.allowedOrigins);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname !== "/upload") return fail(404, "not_found", "Not found", cors);
    if (request.method !== "POST") return fail(405, "method_not_allowed", "Use POST", cors);

    // 1. Auth: same access token the dashboard uses for the backend.
    const auth = request.headers.get("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const payload = token ? await verifyJwt(token, cfg.jwtSecret) : null;
    if (!payload) return fail(401, "unauthorized", "Invalid or expired token", cors);

    // 2. Parse the form.
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return fail(400, "bad_request", "Expected multipart form data", cors);
    }
    const moduleName = form.get("module");
    const fileEntry = form.get("file");
    if (typeof moduleName !== "string" || fileEntry === null || typeof fileEntry === "string") {
      return fail(400, "bad_request", "'module' and 'file' are required", cors);
    }
    const file = fileEntry as unknown as Blob;
    const rule = Object.hasOwn(cfg.modules, moduleName) ? cfg.modules[moduleName] : undefined;
    if (!rule) return fail(400, "bad_module", "Unknown module", cors);

    // 3. Size and real type (magic bytes, not the filename or Content-Type).
    if (file.size === 0) return fail(400, "empty_file", "File is empty", cors);
    if (file.size > rule.maxBytes) {
      const mb = Math.round((rule.maxBytes / 1024 / 1024) * 10) / 10;
      return fail(413, "too_large", `File larger than ${mb} MB`, cors);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!sniffImage(bytes)) {
      return fail(415, "unsupported_type", "Only JPEG, PNG, WebP or GIF images are allowed", cors);
    }

    // 4. Resize (never upscale) and convert to WebP.
    let out: Uint8Array;
    try {
      const result = await env.IMAGES
        .input(new Blob([bytes]).stream())
        .transform({ width: rule.maxDimension, height: rule.maxDimension, fit: "scale-down" })
        .output({ format: "image/webp", quality: cfg.webpQuality });
      out = new Uint8Array(await result.response().arrayBuffer());
    } catch {
      return fail(415, "invalid_image", "Could not process this image", cors);
    }

    // 5. Store in R2 under a random key.
    const key = `${rule.folder}/${crypto.randomUUID()}.webp`;
    try {
      await env.BUCKET.put(key, out, {
        httpMetadata: { contentType: "image/webp", cacheControl: cfg.cacheControl },
      });
    } catch {
      return fail(500, "storage_error", "Could not store the image", cors);
    }

    return json({ key, url: `${cfg.publicBaseUrl}/${key}`, size: out.byteLength }, 200, cors);
  },
};
