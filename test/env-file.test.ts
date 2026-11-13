import { describe, expect, it } from "vitest";
import { EnvFileError, parseEnvFile } from "../scripts/env-file.mjs";

describe("parseEnvFile (matches how wrangler dev reads .env)", () => {
  it("reads plain, quoted and commented lines", () => {
    const env = parseEnvFile(
      [
        "# comment",
        "",
        "A=plain",
        "B='single # kept'   ",
        'C="double # kept"  # trailing comment',
        "D=http://localhost:3000 # dev",
        "export E=exported",
        "F=",
        "  G = spaced  ",
      ].join("\r\n"),
    );
    expect(env).toEqual({
      A: "plain",
      B: "single # kept",
      C: "double # kept",
      D: "http://localhost:3000",
      E: "exported",
      F: "",
      G: "spaced",
    });
  });

  it("keeps # without a space before it in unquoted values", () => {
    expect(parseEnvFile("A=ab#cd").A).toBe("ab#cd");
  });

  it("turns \\$ into $ like wrangler dev", () => {
    expect(parseEnvFile("A='ab\\$cd'").A).toBe("ab$cd");
    expect(parseEnvFile("A=ab\\$cd").A).toBe("ab$cd");
  });

  it("rejects an unescaped $", () => {
    expect(() => parseEnvFile("A='ab$cd'")).toThrow(EnvFileError);
    expect(() => parseEnvFile("A=$HOME")).toThrow(EnvFileError);
  });

  it("handles \\n in double quotes only", () => {
    expect(parseEnvFile('A="a\\nb"').A).toBe("a\nb");
    expect(parseEnvFile("A='a\\nb'").A).toBe("a\\nb");
  });

  it("rejects bad lines and unclosed quotes", () => {
    expect(() => parseEnvFile("not a pair")).toThrow(EnvFileError);
    expect(() => parseEnvFile("A='open")).toThrow(EnvFileError);
  });
});
