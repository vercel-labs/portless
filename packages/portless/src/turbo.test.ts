import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  ensureEnvLoader,
  writeManifest,
  removeManifest,
  buildNodeOptions,
  hasTurboConfig,
  loaderPath,
  manifestPath,
  loaderSource,
} from "./turbo.js";

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "portless-turbo-test-"));
}

function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("hasTurboConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it("returns true when turbo.json exists", () => {
    fs.writeFileSync(path.join(tmpDir, "turbo.json"), "{}");
    expect(hasTurboConfig(tmpDir)).toBe(true);
  });

  it("returns false when turbo.json is missing", () => {
    expect(hasTurboConfig(tmpDir)).toBe(false);
  });
});

describe("ensureEnvLoader", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it("creates the loader file", () => {
    ensureEnvLoader(tmpDir);
    const target = loaderPath(tmpDir);
    expect(fs.existsSync(target)).toBe(true);
    const content = fs.readFileSync(target, "utf-8");
    expect(content).toContain("dev-manifest.json");
    expect(content).toContain("process.env");
  });

  it("is idempotent", () => {
    ensureEnvLoader(tmpDir);
    const first = fs.readFileSync(loaderPath(tmpDir), "utf-8");
    ensureEnvLoader(tmpDir);
    const second = fs.readFileSync(loaderPath(tmpDir), "utf-8");
    expect(first).toBe(second);
  });

  it("updates the loader if source changes", () => {
    const target = loaderPath(tmpDir);
    fs.writeFileSync(target, "old content");
    ensureEnvLoader(tmpDir);
    const content = fs.readFileSync(target, "utf-8");
    expect(content).toBe(loaderSource(tmpDir));
  });
});

describe("writeManifest / removeManifest", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it("writes and reads manifest JSON", () => {
    const entries = {
      "/path/to/app": {
        PORT: "3001",
        HOST: "127.0.0.1",
        PORTLESS_URL: "https://app.project.local",
      },
    };
    writeManifest(entries, tmpDir);
    const raw = fs.readFileSync(manifestPath(tmpDir), "utf-8");
    expect(JSON.parse(raw)).toEqual(entries);
  });

  it("includes NODE_EXTRA_CA_CERTS when provided", () => {
    const entries = {
      "/path/to/app": {
        PORT: "3001",
        HOST: "127.0.0.1",
        PORTLESS_URL: "https://app.project.local",
        NODE_EXTRA_CA_CERTS: "/home/user/.portless/ca.pem",
      },
    };
    writeManifest(entries, tmpDir);
    const raw = fs.readFileSync(manifestPath(tmpDir), "utf-8");
    expect(JSON.parse(raw)["/path/to/app"].NODE_EXTRA_CA_CERTS).toBe("/home/user/.portless/ca.pem");
  });

  it("removeManifest deletes the file", () => {
    writeManifest({}, tmpDir);
    expect(fs.existsSync(manifestPath(tmpDir))).toBe(true);
    removeManifest(tmpDir);
    expect(fs.existsSync(manifestPath(tmpDir))).toBe(false);
  });

  it("removeManifest is safe when file does not exist", () => {
    expect(() => removeManifest(tmpDir)).not.toThrow();
  });
});

describe("buildNodeOptions", () => {
  let tmpDir: string;
  const originalNodeOptions = process.env.NODE_OPTIONS;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
    if (originalNodeOptions !== undefined) {
      process.env.NODE_OPTIONS = originalNodeOptions;
    } else {
      delete process.env.NODE_OPTIONS;
    }
  });

  it("sets --require when NODE_OPTIONS is empty", () => {
    delete process.env.NODE_OPTIONS;
    const result = buildNodeOptions(tmpDir);
    expect(result).toBe(`--require ${loaderPath(tmpDir)}`);
  });

  it("prepends --require to existing NODE_OPTIONS", () => {
    process.env.NODE_OPTIONS = "--max-old-space-size=4096";
    const result = buildNodeOptions(tmpDir);
    expect(result).toBe(`--require ${loaderPath(tmpDir)} --max-old-space-size=4096`);
  });

  it("quotes the loader path when it contains spaces", () => {
    delete process.env.NODE_OPTIONS;
    const spacedDir = path.join(tmpDir, "path with spaces");
    fs.mkdirSync(spacedDir, { recursive: true });
    const result = buildNodeOptions(spacedDir);
    expect(result).toBe(`--require "${loaderPath(spacedDir)}"`);
  });
});

describe("loaderSource", () => {
  it("references the correct manifest path", () => {
    const source = loaderSource("/custom/base");
    expect(source).toContain("/custom/base");
    expect(source).toContain("dev-manifest.json");
  });

  it("escapes backslashes for Windows paths", () => {
    const source = loaderSource("C:\\Users\\test\\.portless");
    expect(source).toContain("dev-manifest.json");
    // JSON.stringify produces doubled backslashes in the JS source text.
    // Verify exactly doubled (not quadrupled from a redundant manual escape).
    expect(source).toContain("C:\\\\Users\\\\test\\\\.portless");
    expect(source).not.toContain("C:\\\\\\\\Users");
  });
});
