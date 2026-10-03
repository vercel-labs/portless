import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigValidationError } from "./config.js";
import {
  PROXY_SETTING_ENV,
  applyProjectProxySettings,
  loadProjectProxySettings,
  proxySettingsToEnv,
} from "./proxy-settings.js";

describe("proxySettingsToEnv", () => {
  const source = "portless.json";

  it("maps every setting to the PORTLESS_* value it stands for", () => {
    expect(
      proxySettingsToEnv(
        {
          https: false,
          port: 8080,
          tld: ["localhost", "test"],
          wildcard: true,
          syncHosts: false,
          unprivileged: true,
        },
        {},
        source
      )
    ).toEqual({
      https: "0",
      port: "8080",
      tld: "localhost,test",
      wildcard: "1",
      syncHosts: "0",
      unprivileged: "1",
    });
  });

  it("accepts a single tld string", () => {
    expect(proxySettingsToEnv({ tld: "Test" }, {}, source)).toEqual({ tld: "test" });
  });

  it("leaves a variable alone when the environment already has it", () => {
    const env = { PORTLESS_HTTPS: "1", PORTLESS_WILDCARD: "" };
    expect(proxySettingsToEnv({ https: false, wildcard: true, port: 80 }, env, source)).toEqual({
      port: "80",
    });
  });

  it("produces nothing for empty settings", () => {
    expect(proxySettingsToEnv({}, {}, source)).toEqual({});
  });

  it("validates the tld with the same rules as --tld, naming the config", () => {
    expect(() => proxySettingsToEnv({ tld: "not a tld" }, {}, source)).toThrow(
      ConfigValidationError
    );
    expect(() => proxySettingsToEnv({ tld: "not a tld" }, {}, source)).toThrow(
      /"tld" in portless\.json/
    );
  });

  it("covers every setting with an env name", () => {
    expect(Object.values(PROXY_SETTING_ENV).sort()).toEqual([
      "PORTLESS_HTTPS",
      "PORTLESS_PORT",
      "PORTLESS_SYNC_HOSTS",
      "PORTLESS_TLD",
      "PORTLESS_UNPRIVILEGED",
      "PORTLESS_WILDCARD",
    ]);
  });
});

describe("loadProjectProxySettings", () => {
  let root: string;
  let pkg: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "portless-proxy-settings-"));
    pkg = path.join(root, "apps", "web");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n');
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@demo/web" }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns null when no config pins anything", () => {
    expect(loadProjectProxySettings(pkg)).toBeNull();
  });

  it("ignores app keys, which are not proxy settings", () => {
    fs.writeFileSync(path.join(root, "portless.json"), JSON.stringify({ name: "demo" }));
    expect(loadProjectProxySettings(root)).toBeNull();
  });

  it("falls back from a package directory to the workspace root", () => {
    fs.writeFileSync(
      path.join(root, "portless.json"),
      JSON.stringify({ name: "demo", https: false, wildcard: true })
    );
    expect(loadProjectProxySettings(pkg)).toEqual({
      settings: { https: false, wildcard: true },
      source: path.join(root, "portless.json"),
    });
  });

  it("prefers the package's own config over the root's", () => {
    fs.writeFileSync(path.join(root, "portless.json"), JSON.stringify({ port: 8080 }));
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@demo/web", portless: { port: 9090 } })
    );
    expect(loadProjectProxySettings(pkg)?.settings).toEqual({ port: 9090 });
  });
});

describe("applyProjectProxySettings", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-apply-settings-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sets only the variables nothing had set and reports them", () => {
    vi.stubEnv("PORTLESS_HTTPS", "1");
    vi.stubEnv("PORTLESS_WILDCARD", undefined);
    vi.stubEnv("PORTLESS_PORT", undefined);
    fs.writeFileSync(
      path.join(dir, "portless.json"),
      JSON.stringify({ https: false, wildcard: true, port: 8080 })
    );

    const applied = applyProjectProxySettings(dir);

    expect(applied?.applied).toEqual({ wildcard: "1", port: "8080" });
    expect(process.env.PORTLESS_HTTPS).toBe("1");
    expect(process.env.PORTLESS_WILDCARD).toBe("1");
    expect(process.env.PORTLESS_PORT).toBe("8080");
  });

  it("returns null and touches nothing without settings", () => {
    vi.stubEnv("PORTLESS_WILDCARD", undefined);
    expect(applyProjectProxySettings(dir)).toBeNull();
    expect(process.env.PORTLESS_WILDCARD).toBeUndefined();
  });
});
