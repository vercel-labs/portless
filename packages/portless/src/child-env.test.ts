import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildPeerUrlEnv,
  ChildEnvError,
  childEnv,
  formatShellExports,
  formatViteAllowedHosts,
  peerUrlEnvName,
  resolveEnvVarNaming,
  resolveExtraCaCerts,
} from "./child-env.js";

describe("formatViteAllowedHosts", () => {
  it("uses local TLDs when no valid share URL is provided", () => {
    expect(formatViteAllowedHosts(["localhost", "test"])).toBe(".localhost,.test");
    expect(formatViteAllowedHosts(["localhost", "test"], "not a URL")).toBe(".localhost,.test");
  });

  it.each([
    ["https://app.tailnet.ts.net:8443/path", "app.tailnet.ts.net"],
    ["https://app.ngrok-free.app:443/path?q=1", "app.ngrok-free.app"],
    ["https://app.trycloudflare.com:8443/path", "app.trycloudflare.com"],
  ])("uses the hostname of %s", (url, hostname) => {
    expect(formatViteAllowedHosts(["localhost"], url)).toBe(hostname);
  });
});

describe("peer URL environment", () => {
  it("normalizes names and preserves worktree-prefixed URLs", () => {
    expect(peerUrlEnvName("my.api-service")).toBe("PORTLESS_URL_MY_API_SERVICE");
    expect(
      buildPeerUrlEnv([
        { baseName: "my.api-service", url: "https://feature.my-api.localhost" },
        { baseName: "web", url: "https://feature.web.localhost" },
      ])
    ).toEqual({
      PORTLESS_URL_MY_API_SERVICE: "https://feature.my-api.localhost",
      PORTLESS_URL_WEB: "https://feature.web.localhost",
    });
  });

  it("keeps the first collision, warns about the skipped name, and ignores duplicate and empty names", () => {
    const warn = vi.fn<(message: string) => void>();
    const result = buildPeerUrlEnv(
      [
        { baseName: "my-app", url: "http://first.localhost" },
        { baseName: "my-app", url: "http://duplicate.localhost" },
        { baseName: "my.app", url: "http://second.localhost" },
        { baseName: "...", url: "http://empty.localhost" },
      ],
      warn
    );
    expect(result).toEqual({ PORTLESS_URL_MY_APP: "http://first.localhost" });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("PORTLESS_URL_MY_APP");
    expect(warn.mock.calls[0][0]).toContain("my-app");
    expect(warn.mock.calls[0][0]).toContain("my.app");
  });
});

describe("resolveEnvVarNaming", () => {
  it("uses defaults and gives CLI values precedence over env and config", () => {
    expect(resolveEnvVarNaming(undefined, undefined, {})).toEqual({
      portVar: "PORT",
      hostVar: "HOST",
    });
    const config = { portVar: "CONFIG_PORT", hostVar: "CONFIG_HOST" };
    const env = { PORTLESS_PORT_VAR: "ENV_PORT", PORTLESS_HOST_VAR: "ENV_HOST" };
    expect(resolveEnvVarNaming({ portVar: "CLI_PORT", hostVar: "CLI_HOST" }, config, env)).toEqual({
      portVar: "CLI_PORT",
      hostVar: "CLI_HOST",
    });
    expect(resolveEnvVarNaming(undefined, config, env)).toEqual({
      portVar: "ENV_PORT",
      hostVar: "ENV_HOST",
    });
    expect(resolveEnvVarNaming(undefined, config, { PORTLESS_PORT_VAR: "" })).toEqual(config);
  });

  it("rejects invalid names from overrides, environment and config", () => {
    expect(() => resolveEnvVarNaming({ portVar: "1PORT" }, undefined, {})).toThrow(ChildEnvError);
    expect(() =>
      resolveEnvVarNaming(undefined, undefined, { PORTLESS_HOST_VAR: "BAD-HOST" })
    ).toThrow(ChildEnvError);
    expect(() => resolveEnvVarNaming(undefined, { portVar: "BAD PORT" }, {})).toThrow(
      ChildEnvError
    );
  });

  it("rejects identical port and host names", () => {
    expect(() => resolveEnvVarNaming({ portVar: "SAME", hostVar: "SAME" }, undefined, {})).toThrow(
      /cannot use the same name/
    );
  });
});

describe("resolveExtraCaCerts", () => {
  let dir: string;
  let caPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-child-env-test-"));
    caPath = path.join(dir, "ca.pem");
    fs.writeFileSync(caPath, "PORTLESS CERT\n");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined for a missing or empty portless CA", () => {
    expect(resolveExtraCaCerts(undefined, {})).toBeUndefined();
    expect(resolveExtraCaCerts(path.join(dir, "missing.pem"), {})).toBeUndefined();
    const corporate = path.join(dir, "corporate.pem");
    fs.writeFileSync(corporate, "CORPORATE CERT\n");
    for (const content of ["", " \n\t"]) {
      fs.writeFileSync(caPath, content);
      expect(resolveExtraCaCerts(caPath, {})).toBeUndefined();
      expect(resolveExtraCaCerts(caPath, { NODE_EXTRA_CA_CERTS: corporate })).toBeUndefined();
    }
  });

  it("uses the portless CA when no existing CA is usable or both paths match", () => {
    expect(resolveExtraCaCerts(caPath, {})).toBe(caPath);
    expect(resolveExtraCaCerts(caPath, { NODE_EXTRA_CA_CERTS: caPath })).toBe(caPath);
    expect(
      resolveExtraCaCerts(caPath, { NODE_EXTRA_CA_CERTS: path.join(dir, "missing.pem") })
    ).toBe(caPath);
  });

  it("creates a content-addressed bundle and reuses it without creating another", () => {
    const corporate = path.join(dir, "corporate.pem");
    fs.writeFileSync(corporate, "CORPORATE CERT\n");
    const result = resolveExtraCaCerts(caPath, { NODE_EXTRA_CA_CERTS: corporate });
    expect(result).toBeDefined();
    const combined = "CORPORATE CERT\nPORTLESS CERT\n";
    const hash = crypto.createHash("sha256").update(combined).digest("hex").slice(0, 16);
    expect(result).toBe(path.join(dir, `ca-bundle-${hash}.pem`));
    expect(fs.readFileSync(result!, "utf-8")).toBe(combined);
    const filesBefore = fs.readdirSync(dir).sort();
    expect(resolveExtraCaCerts(caPath, { NODE_EXTRA_CA_CERTS: result })).toBe(result);
    expect(fs.readdirSync(dir).sort()).toEqual(filesBefore);
  });
});

describe("childEnv", () => {
  it("returns default and custom port and host variables with their display", () => {
    expect(childEnv({ port: 3100, host: "127.0.0.1", url: "http://app.localhost" })).toEqual({
      env: { PORT: "3100", HOST: "127.0.0.1", PORTLESS_URL: "http://app.localhost" },
      display: "PORT=3100 HOST=127.0.0.1 PORTLESS_URL=http://app.localhost",
    });
    expect(
      childEnv(
        { port: 3100, host: "0.0.0.0", url: "http://app.localhost" },
        { naming: { portVar: "APP_PORT", hostVar: "APP_HOST" } }
      )
    ).toEqual({
      env: { APP_PORT: "3100", APP_HOST: "0.0.0.0", PORTLESS_URL: "http://app.localhost" },
      display: "APP_PORT=3100 APP_HOST=0.0.0.0 PORTLESS_URL=http://app.localhost",
    });
    expect(childEnv({ port: 8081, lan: true })).toEqual({
      env: { PORT: "8081", PORTLESS_LAN: "1" },
      display: "PORT=8081",
    });
  });

  it("derives Vite hosts from the explicit share URL or the share environment", () => {
    const entry = {
      tlds: ["localhost"],
      shareEnv: { PORTLESS_TAILSCALE_URL: "https://app.tailnet.ts.net/path" },
    };
    expect(childEnv(entry).env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS).toBe("app.tailnet.ts.net");
    expect(
      childEnv(entry, { shareUrl: "https://app.ngrok-free.app:1234/path" }).env
        .__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS
    ).toBe("app.ngrok-free.app");
    expect(
      childEnv({
        tlds: ["localhost"],
        shareEnv: { CLOUDFLARE_URL: "https://app.trycloudflare.com/path" },
      }).env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS
    ).toBe("app.trycloudflare.com");
  });

  it("merges peers, named URLs, CA, LAN, and prefix into the child environment", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-child-env-test-"));
    try {
      const caPath = path.join(dir, "ca.pem");
      fs.writeFileSync(caPath, "PORTLESS CERT\n");
      expect(
        childEnv(
          {
            port: 3000,
            childPrefix: "feature",
            lan: true,
            namedUrls: { PORTLESS_URL_API: "https://override.localhost" },
          },
          {
            peers: [
              { baseName: "api", url: "https://feature.api.localhost" },
              { baseName: "web", url: "https://feature.web.localhost" },
            ],
            caPath,
            parentEnv: {},
          }
        )
      ).toEqual({
        env: {
          PORTLESS_URL_API: "https://override.localhost",
          PORTLESS_URL_WEB: "https://feature.web.localhost",
          PORTLESS_PREFIX: "feature",
          PORT: "3000",
          PORTLESS_LAN: "1",
          NODE_EXTRA_CA_CERTS: caPath,
        },
        display: `PORT=3000 NODE_EXTRA_CA_CERTS="${caPath}"`,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("formatShellExports", () => {
  it("quotes values and escapes embedded single quotes", () => {
    expect(formatShellExports({})).toBe("");
    expect(formatShellExports({ PORT: "3000", MESSAGE: "it's ready" })).toBe(
      "export PORT='3000'\nexport MESSAGE='it'\\''s ready'\n"
    );
  });
});
