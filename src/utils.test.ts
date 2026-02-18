import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  escapeHtml,
  formatUrl,
  isErrnoException,
  loadPortlessConfig,
  parseHostname,
  resolveAppName,
  sanitizePackageName,
} from "./utils.js";

describe("escapeHtml", () => {
  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes ampersands", () => {
    expect(escapeHtml("foo & bar")).toBe("foo &amp; bar");
  });

  it("escapes quotes", () => {
    expect(escapeHtml("\"hello\" & 'world'")).toBe("&quot;hello&quot; &amp; &#39;world&#39;");
  });

  it("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("leaves safe text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

describe("isErrnoException", () => {
  it("returns true for a Node.js system error", () => {
    const err = new Error("fail") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    expect(isErrnoException(err)).toBe(true);
  });

  it("returns false for a plain Error without code", () => {
    expect(isErrnoException(new Error("plain"))).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isErrnoException("something")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isErrnoException(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isErrnoException(undefined)).toBe(false);
  });

  it("returns false for a plain object with code", () => {
    expect(isErrnoException({ code: "ENOENT", message: "fail" })).toBe(false);
  });

  it("returns false for an Error with a non-string code", () => {
    const err = new Error("fail");
    (err as unknown as Record<string, unknown>).code = 42;
    expect(isErrnoException(err)).toBe(false);
  });
});

describe("formatUrl", () => {
  it("omits port for standard HTTP port (80)", () => {
    expect(formatUrl("myapp.localhost", 80)).toBe("http://myapp.localhost");
  });

  it("includes port for non-standard ports", () => {
    expect(formatUrl("myapp.localhost", 1355)).toBe("http://myapp.localhost:1355");
    expect(formatUrl("myapp.localhost", 8080)).toBe("http://myapp.localhost:8080");
    expect(formatUrl("myapp.localhost", 3000)).toBe("http://myapp.localhost:3000");
  });
});

describe("parseHostname", () => {
  it("appends .localhost to simple name", () => {
    expect(parseHostname("myapp")).toBe("myapp.localhost");
  });

  it("preserves existing .localhost suffix", () => {
    expect(parseHostname("myapp.localhost")).toBe("myapp.localhost");
  });

  it("strips http:// protocol", () => {
    expect(parseHostname("http://myapp")).toBe("myapp.localhost");
  });

  it("strips https:// protocol", () => {
    expect(parseHostname("https://myapp")).toBe("myapp.localhost");
  });

  it("strips path after hostname", () => {
    expect(parseHostname("myapp/some/path")).toBe("myapp.localhost");
  });

  it("strips protocol and path", () => {
    expect(parseHostname("http://myapp.localhost/path")).toBe("myapp.localhost");
  });

  it("converts to lowercase", () => {
    expect(parseHostname("MyApp")).toBe("myapp.localhost");
  });

  it("handles subdomain-style names", () => {
    expect(parseHostname("api.myapp")).toBe("api.myapp.localhost");
  });

  it("handles hyphens", () => {
    expect(parseHostname("my-app")).toBe("my-app.localhost");
  });

  it("throws on empty input", () => {
    expect(() => parseHostname("")).toThrow("Hostname cannot be empty");
  });

  it("throws on whitespace-only input", () => {
    expect(() => parseHostname("   ")).toThrow("Hostname cannot be empty");
  });

  it("throws on invalid characters", () => {
    expect(() => parseHostname("my app")).toThrow("Invalid hostname");
  });

  it("throws on hostname starting with hyphen", () => {
    expect(() => parseHostname("-myapp")).toThrow("Invalid hostname");
  });

  it("throws on hostname ending with hyphen", () => {
    expect(() => parseHostname("myapp-")).toThrow("Invalid hostname");
  });

  it("throws on special characters", () => {
    expect(() => parseHostname("my@app")).toThrow("Invalid hostname");
  });

  it("throws on consecutive dots", () => {
    expect(() => parseHostname("my..app")).toThrow("consecutive dots are not allowed");
  });

  it("accepts numeric hostnames", () => {
    expect(parseHostname("123")).toBe("123.localhost");
  });

  it("handles protocol with .localhost already present", () => {
    expect(parseHostname("https://test.localhost")).toBe("test.localhost");
  });
});

describe("sanitizePackageName", () => {
  it("strips npm scope", () => {
    expect(sanitizePackageName("@scope/pkg")).toBe("pkg");
  });

  it("strips scope and preserves hyphens", () => {
    expect(sanitizePackageName("@my-org/my-app")).toBe("my-app");
  });

  it("returns simple names unchanged", () => {
    expect(sanitizePackageName("simple-name")).toBe("simple-name");
  });

  it("lowercases and replaces underscores", () => {
    expect(sanitizePackageName("UPPER_Case")).toBe("upper-case");
  });

  it("replaces multiple invalid chars with hyphens", () => {
    expect(sanitizePackageName("my@weird!name")).toBe("my-weird-name");
  });

  it("returns null for all-hyphen input", () => {
    expect(sanitizePackageName("---")).toBe(null);
  });

  it("returns null for empty string", () => {
    expect(sanitizePackageName("")).toBe(null);
  });

  it("returns null for scope with empty name", () => {
    expect(sanitizePackageName("@scope/")).toBe(null);
  });
});

describe("loadPortlessConfig", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null when no config file exists", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-test-"));
    expect(loadPortlessConfig(tmpDir)).toBe(null);
  });

  it("finds config in the start directory", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-test-"));
    const config = { names: { "my-app": "custom" } };
    fs.writeFileSync(path.join(tmpDir, ".portlessrc.json"), JSON.stringify(config));
    expect(loadPortlessConfig(tmpDir)).toEqual(config);
  });

  it("finds config in a parent directory", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-test-"));
    const nested = path.join(tmpDir, "sub", "dir");
    fs.mkdirSync(nested, { recursive: true });
    const config = { names: { "my-app": "custom" } };
    fs.writeFileSync(path.join(tmpDir, ".portlessrc.json"), JSON.stringify(config));
    expect(loadPortlessConfig(nested)).toEqual(config);
  });

  it("returns null for invalid JSON", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-test-"));
    fs.writeFileSync(path.join(tmpDir, ".portlessrc.json"), "not valid json{{{");
    expect(loadPortlessConfig(tmpDir)).toBe(null);
  });
});

describe("resolveAppName", () => {
  let tmpDir: string;
  let savedNpmPackageName: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    if (savedNpmPackageName === undefined) {
      delete process.env.npm_package_name;
    } else {
      process.env.npm_package_name = savedNpmPackageName;
    }
  });

  it("uses npm_package_name env var when set", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-test-"));
    savedNpmPackageName = process.env.npm_package_name;
    process.env.npm_package_name = "my-cool-app";
    expect(resolveAppName(tmpDir)).toBe("my-cool-app");
  });

  it("falls back to package.json name when npm_package_name not set", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-test-"));
    savedNpmPackageName = process.env.npm_package_name;
    delete process.env.npm_package_name;
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "from-pkg-json" }));
    expect(resolveAppName(tmpDir)).toBe("from-pkg-json");
  });

  it("applies config name override from .portlessrc.json", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-test-"));
    savedNpmPackageName = process.env.npm_package_name;
    process.env.npm_package_name = "original-name";
    const config = { names: { "original-name": "overridden" } };
    fs.writeFileSync(path.join(tmpDir, ".portlessrc.json"), JSON.stringify(config));
    expect(resolveAppName(tmpDir)).toBe("overridden");
  });

  it("falls back to directory basename", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-test-"));
    const nested = path.join(tmpDir, "my-project");
    fs.mkdirSync(nested);
    savedNpmPackageName = process.env.npm_package_name;
    delete process.env.npm_package_name;
    expect(resolveAppName(nested)).toBe("my-project");
  });

  it("sanitizes scoped package names", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-test-"));
    savedNpmPackageName = process.env.npm_package_name;
    process.env.npm_package_name = "@my-org/my-app";
    expect(resolveAppName(tmpDir)).toBe("my-app");
  });
});
