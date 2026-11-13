import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config";

const good = {
  JWT_SECRET: "s3cret#x",
  ALLOWED_ORIGINS: "http://localhost:3000, https://app.example.org",
  PUBLIC_BASE_URL: "https://pub-x.r2.dev/",
  WEBP_QUALITY: "85",
  CACHE_CONTROL: "public, max-age=31536000, immutable",
  MEDIA_MODULES: JSON.stringify({
    ig_cover: { folder: "interest_group/cover", maxBytes: 5242880, maxDimension: 2000 },
  }),
};

describe("loadConfig", () => {
  it("reads every value from env", () => {
    const c = loadConfig(good);
    expect(c.jwtSecret).toBe("s3cret#x");
    expect(c.allowedOrigins).toEqual(["http://localhost:3000", "https://app.example.org"]);
    expect(c.publicBaseUrl).toBe("https://pub-x.r2.dev");
    expect(c.webpQuality).toBe(85);
    expect(c.modules.ig_cover).toEqual({ folder: "interest_group/cover", maxBytes: 5242880, maxDimension: 2000 });
  });

  it.each(Object.keys(good))("fails when %s is missing", (name) => {
    const env: Record<string, unknown> = { ...good };
    delete env[name];
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it("accepts wrangler.toml types (number quality, object modules)", () => {
    const c = loadConfig({
      ...good,
      WEBP_QUALITY: 80,
      MEDIA_MODULES: { ig_icon: { folder: "interest_group/icon", maxBytes: 100, maxDimension: 512 } },
    });
    expect(c.webpQuality).toBe(80);
    expect(c.modules.ig_icon.maxDimension).toBe(512);
  });

  it("rejects bad quality and bad modules", () => {
    expect(() => loadConfig({ ...good, WEBP_QUALITY: "150" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...good, MEDIA_MODULES: "not json" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...good, MEDIA_MODULES: "{}" })).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...good, MEDIA_MODULES: JSON.stringify({ x: { folder: "../etc", maxBytes: 1, maxDimension: 1 } }) }),
    ).toThrow(ConfigError);
  });
});
