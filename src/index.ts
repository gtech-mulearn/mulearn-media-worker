import { ConfigError, getConfig, parseOrigins, type Config } from "./config";
import { corsHeaders, fail, json } from "./http";
import { verifyJwt } from "./jwt";
import { sniffImage } from "./sniff";
import type { Env } from "./types";

// Room for the multipart wrapper around the file (boundaries, part headers,
// the "module" field) when checking Content-Length before reading the body.
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

// Cloudflare Images error codes that mean "the uploaded file is the problem":
//   9412  input is not an image (documented on ImagesBinding.info)
//   9520  unsupported image type
// Any other Images error is treated as a service problem (502, safe to retry) and
// logged with its code. Note: local `wrangler dev` reports a corrupt file as the
// generic code 9523, so locally a corrupt file shows as 502. Check the logged code
// in production and add input-error codes here if needed.
const IMAGES_INPUT_ERRORS = new Set([9412, 9520]);

function errorSummary(e: unknown): string {
  if (e && typeof e === "object") {
    const { code, message } = e as { code?: unknown; message?: unknown };
    return `${code !== undefined ? `code=${String(code)} ` : ""}${String(message ?? e)}`;
  }
  return String(e);
}

function imagesErrorCode(e: unknown): number | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin");

    let cfg: Config;
    try {
      cfg = getConfig(env);
    } catch (e) {
      // Log which setting is wrong (never its value); keep the response generic.
      console.error("Config error:", e instanceof ConfigError ? e.message : e);
      // Still send CORS headers when ALLOWED_ORIGINS itself is readable, so the
      // browser shows this error instead of a generic CORS failure.
      let cors: Record<string, string> = {};
      try {
        cors = corsHeaders(origin, parseOrigins(env));
      } catch {
        // ALLOWED_ORIGINS is the broken setting; nothing more we can do.
      }
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      return fail(500, "server_misconfigured", "Server is not configured correctly", cors);
    }

    const url = new URL(request.url);
    const cors = corsHeaders(origin, cfg.allowedOrigins);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname !== "/upload") return fail(404, "not_found", "Not found", cors);
    if (request.method !== "POST") return fail(405, "method_not_allowed", "Use POST", cors);

    // 1. Auth: same access token the dashboard uses for the backend.
    const auth = request.headers.get("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const payload = token ? await verifyJwt(token, cfg.jwtSecret) : null;
    if (!payload) return fail(401, "unauthorized", "Invalid or expired token", cors);

    // 2. Reject oversized bodies before reading them into memory.
    const lengthHeader = request.headers.get("Content-Length");
    const length = lengthHeader === null ? NaN : Number(lengthHeader);
    if (!Number.isFinite(length)) {
      return fail(411, "length_required", "Content-Length header is required", cors);
    }
    if (length > cfg.maxFileBytes + MULTIPART_OVERHEAD_BYTES) {
      return fail(413, "too_large", "Request body is too large", cors);
    }

    // 3. Parse the form.
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

    // 4. Size and real type (magic bytes, not the filename or Content-Type).
    //    Only the first bytes are read here; the file itself is streamed below.
    if (file.size === 0) return fail(400, "empty_file", "File is empty", cors);
    if (file.size > rule.maxBytes) {
      const mb = Math.round((rule.maxBytes / 1024 / 1024) * 10) / 10;
      return fail(413, "too_large", `File larger than ${mb} MB`, cors);
    }
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (!sniffImage(head)) {
      return fail(415, "unsupported_type", "Only JPEG, PNG, WebP or GIF images are allowed", cors);
    }

    // 5. Check the image can be decoded. A broken file is the client's fault (415);
    //    any other Images error is a service problem (502, safe to retry).
    try {
      await env.IMAGES.info(file.stream());
    } catch (e) {
      if (IMAGES_INPUT_ERRORS.has(imagesErrorCode(e) ?? -1)) {
        console.warn("Images rejected input:", errorSummary(e));
        return fail(415, "invalid_image", "Could not read this image", cors);
      }
      console.error("Images info failed:", errorSummary(e));
      return fail(502, "image_service_error", "Image service is unavailable, try again", cors);
    }

    // 6. Resize (never upscale) and convert to WebP.
    let out: Uint8Array;
    try {
      const result = await env.IMAGES
        .input(file.stream())
        .transform({ width: rule.maxDimension, height: rule.maxDimension, fit: "scale-down" })
        .output({ format: "image/webp", quality: cfg.webpQuality });
      out = new Uint8Array(await result.response().arrayBuffer());
    } catch (e) {
      if (IMAGES_INPUT_ERRORS.has(imagesErrorCode(e) ?? -1)) {
        console.warn("Images rejected input:", errorSummary(e));
        return fail(415, "invalid_image", "Could not read this image", cors);
      }
      console.error("Images transform failed:", errorSummary(e));
      return fail(502, "image_service_error", "Image service is unavailable, try again", cors);
    }

    // 7. Store in R2 under a random key.
    const key = `${rule.folder}/${crypto.randomUUID()}.webp`;
    try {
      await env.BUCKET.put(key, out, {
        httpMetadata: { contentType: "image/webp", cacheControl: cfg.cacheControl },
      });
    } catch (e) {
      console.error("R2 put failed:", errorSummary(e));
      return fail(500, "storage_error", "Could not store the image", cors);
    }

    return json({ key, url: `${cfg.publicBaseUrl}/${key}`, size: out.byteLength }, 200, cors);
  },
};
