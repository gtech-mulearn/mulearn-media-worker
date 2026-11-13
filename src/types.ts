// Bindings come from wrangler.toml; every other value comes from .env (see src/config.ts).
export interface Env {
  BUCKET: R2Bucket;
  IMAGES: ImagesBinding;
  [key: string]: unknown;
}
