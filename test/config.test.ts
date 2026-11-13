import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { ConfigError, getConfig, loadConfig, parseOrigins } from "../src/config";
import wranglerToml from "../wrangler.toml?raw";

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

  it("computes the largest module size", () => {
    const c = loadConfig({
      ...good,
      MEDIA_MODULES: JSON.stringify({
        a: { folder: "a", maxBytes: 100, maxDimension: 1 },
        b: { folder: "b", maxBytes: 900, maxDimension: 1 },
      }),
    });
    expect(c.maxFileBytes).toBe(900);
  });

  it("caches per env object and re-checks a broken config", () => {
    const env = { ...good };
    expect(getConfig(env)).toBe(getConfig(env));
    const broken: Record<string, unknown> = { ...good, PUBLIC_BASE_URL: "" };
    expect(() => getConfig(broken)).toThrow(ConfigError);
    broken.PUBLIC_BASE_URL = "https://ok.example";
    expect(getConfig(broken).publicBaseUrl).toBe("https://ok.example");
  });

  it("reads origins on their own", () => {
    expect(parseOrigins({ ALLOWED_ORIGINS: " https://a.example ,https://b.example," })).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
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

describe("wrangler.toml", () => {
  const toml = parseToml(wranglerToml) as any;
  const dev = toml.vars;
  const prod = toml.env?.production?.vars;
  // Per-environment values come from .env / the deploy environment, not wrangler.toml.
  const perEnv = { JWT_SECRET: "x", ALLOWED_ORIGINS: "https://app.example", PUBLIC_BASE_URL: "https://media.example" };

  it("production [vars] match dev [vars]", () => {
    expect(prod).toBeDefined();
    expect(prod).toEqual(dev);
  });

  it("[vars] form a valid config", () => {
    expect(() => loadConfig({ ...dev, ...perEnv })).not.toThrow();
    expect(() => loadConfig({ ...prod, ...perEnv })).not.toThrow();
  });

  it("keeps per-environment values out of [vars]", () => {
    for (const name of Object.keys(perEnv)) {
      expect(dev).not.toHaveProperty(name);
      expect(prod).not.toHaveProperty(name);
    }
  });
});
