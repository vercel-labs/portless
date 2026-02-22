import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import {
  DEFAULT_PROXY_PORT,
  PRIVILEGED_PORT_THRESHOLD,
  SYSTEM_STATE_DIR,
  USER_STATE_DIR,
  findFreePort,
  formatBranchName,
  getCurrentBranch,
  getDefaultPort,
  injectFrameworkFlags,
  isProxyRunning,
  resolveStateDir,
  shouldIncludeBranch,
} from "./cli-utils.js";

describe("findFreePort", () => {
  it("returns a port in the default range", async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThanOrEqual(4000);
    expect(port).toBeLessThanOrEqual(4999);
  });

  it("returns a port that is actually bindable", async () => {
    const port = await findFreePort();
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(port, () => resolve());
      server.on("error", reject);
    });
    server.close();
  });

  it("respects custom port range", async () => {
    const port = await findFreePort(9000, 9010);
    expect(port).toBeGreaterThanOrEqual(9000);
    expect(port).toBeLessThanOrEqual(9010);
  });

  it("throws when no port is available in a tiny occupied range", async () => {
    // Occupy a single-port range
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(9999, () => resolve()));
    try {
      await expect(findFreePort(9999, 9999)).rejects.toThrow("No free port found");
    } finally {
      server.close();
    }
  });

  it("throws when minPort > maxPort", async () => {
    await expect(findFreePort(5000, 4000)).rejects.toThrow("minPort");
  });
});

describe("isProxyRunning", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    for (const s of servers) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    servers.length = 0;
  });

  it("returns false when nothing is listening", async () => {
    const result = await isProxyRunning(19876);
    expect(result).toBe(false);
  });

  it("returns true when a portless proxy is listening", async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader("X-Portless", "1");
      res.end("ok");
    });
    servers.push(server);

    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr !== "string") {
          resolve(addr.port);
        }
      });
    });

    const result = await isProxyRunning(port);
    expect(result).toBe(true);
  });

  it("returns false when a non-portless server is listening", async () => {
    const server = http.createServer((_req, res) => {
      res.end("not portless");
    });
    servers.push(server);

    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr !== "string") {
          resolve(addr.port);
        }
      });
    });

    const result = await isProxyRunning(port);
    expect(result).toBe(false);
  });
});

describe("resolveStateDir", () => {
  it("returns system dir for privileged ports", () => {
    expect(resolveStateDir(80)).toBe(SYSTEM_STATE_DIR);
    expect(resolveStateDir(443)).toBe(SYSTEM_STATE_DIR);
    expect(resolveStateDir(1023)).toBe(SYSTEM_STATE_DIR);
  });

  it("returns user dir for non-privileged ports", () => {
    expect(resolveStateDir(1024)).toBe(USER_STATE_DIR);
    expect(resolveStateDir(8080)).toBe(USER_STATE_DIR);
    expect(resolveStateDir(3000)).toBe(USER_STATE_DIR);
  });
});

describe("constants", () => {
  it("DEFAULT_PROXY_PORT is 1355", () => {
    expect(DEFAULT_PROXY_PORT).toBe(1355);
  });

  it("PRIVILEGED_PORT_THRESHOLD is 1024", () => {
    expect(PRIVILEGED_PORT_THRESHOLD).toBe(1024);
  });

  it("SYSTEM_STATE_DIR is /tmp/portless", () => {
    expect(SYSTEM_STATE_DIR).toBe("/tmp/portless");
  });

  it("USER_STATE_DIR is in home directory", () => {
    expect(USER_STATE_DIR).toBe(`${os.homedir()}/.portless`);
  });
});

describe("getDefaultPort", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.PORTLESS_PORT;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PORTLESS_PORT;
    } else {
      process.env.PORTLESS_PORT = originalEnv;
    }
  });

  it("returns DEFAULT_PROXY_PORT when PORTLESS_PORT is not set", () => {
    delete process.env.PORTLESS_PORT;
    expect(getDefaultPort()).toBe(DEFAULT_PROXY_PORT);
  });

  it("returns PORTLESS_PORT when set to a valid port", () => {
    process.env.PORTLESS_PORT = "8080";
    expect(getDefaultPort()).toBe(8080);
  });

  it("returns DEFAULT_PROXY_PORT when PORTLESS_PORT is invalid", () => {
    process.env.PORTLESS_PORT = "not-a-number";
    expect(getDefaultPort()).toBe(DEFAULT_PROXY_PORT);
  });

  it("returns DEFAULT_PROXY_PORT when PORTLESS_PORT is out of range", () => {
    process.env.PORTLESS_PORT = "0";
    expect(getDefaultPort()).toBe(DEFAULT_PROXY_PORT);

    process.env.PORTLESS_PORT = "70000";
    expect(getDefaultPort()).toBe(DEFAULT_PROXY_PORT);
  });

  it("returns DEFAULT_PROXY_PORT when PORTLESS_PORT is empty", () => {
    process.env.PORTLESS_PORT = "";
    expect(getDefaultPort()).toBe(DEFAULT_PROXY_PORT);
  });
});

describe("injectFrameworkFlags", () => {
  it("injects --port, --strictPort, and --host for vite command", () => {
    const args = ["vite", "dev"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["vite", "dev", "--port", "4567", "--strictPort", "--host", "127.0.0.1"]);
  });

  it("injects flags for absolute/relative vite paths", () => {
    const args = ["./node_modules/.bin/vite", "dev"];
    injectFrameworkFlags(args, 4000);
    expect(args).toEqual([
      "./node_modules/.bin/vite",
      "dev",
      "--port",
      "4000",
      "--strictPort",
      "--host",
      "127.0.0.1",
    ]);
  });

  it("skips --port injection when --port is already present", () => {
    const args = ["vite", "dev", "--port", "3000"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["vite", "dev", "--port", "3000", "--host", "127.0.0.1"]);
  });

  it("skips --host injection when --host is already present", () => {
    const args = ["vite", "dev", "--host", "0.0.0.0"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["vite", "dev", "--host", "0.0.0.0", "--port", "4567", "--strictPort"]);
  });

  it("skips all injection when both --port and --host are present", () => {
    const args = ["vite", "dev", "--port", "3000", "--host", "0.0.0.0"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["vite", "dev", "--port", "3000", "--host", "0.0.0.0"]);
  });

  it("injects for react-router with --strictPort", () => {
    const args = ["react-router", "dev"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual([
      "react-router",
      "dev",
      "--port",
      "4567",
      "--strictPort",
      "--host",
      "127.0.0.1",
    ]);
  });

  it("injects for astro without --strictPort", () => {
    const args = ["astro", "dev"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["astro", "dev", "--port", "4567", "--host", "127.0.0.1"]);
  });

  it("injects for ng without --strictPort", () => {
    const args = ["ng", "serve"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["ng", "serve", "--port", "4567", "--host", "127.0.0.1"]);
  });

  it("does not inject for frameworks that read PORT", () => {
    const nextArgs = ["next", "dev"];
    injectFrameworkFlags(nextArgs, 4567);
    expect(nextArgs).toEqual(["next", "dev"]);

    const nuxtArgs = ["nuxt", "dev"];
    injectFrameworkFlags(nuxtArgs, 4567);
    expect(nuxtArgs).toEqual(["nuxt", "dev"]);

    const nodeArgs = ["node", "server.js"];
    injectFrameworkFlags(nodeArgs, 4567);
    expect(nodeArgs).toEqual(["node", "server.js"]);
  });

  it("does nothing for empty args", () => {
    const args: string[] = [];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual([]);
  });
});

describe("getCurrentBranch", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns branch name when in a git repo", () => {
    const branch = getCurrentBranch();
    expect(typeof branch).toBe("string");
  });

  it("returns null when not in a git repo (uses temp dir)", async () => {
    const branch = getCurrentBranch("/tmp");
    expect(branch).toBeNull();
  });
});

describe("formatBranchName", () => {
  it("converts slashes to hyphens", () => {
    expect(formatBranchName("feat/auth")).toBe("feat-auth");
  });

  it("converts to lowercase", () => {
    expect(formatBranchName("FEAT/Test")).toBe("feat-test");
  });

  it("removes invalid hostname characters", () => {
    expect(formatBranchName("feat@test$123")).toBe("feattest123");
  });

  it("removes consecutive hyphens", () => {
    expect(formatBranchName("feat--test")).toBe("feat-test");
  });

  it("removes leading hyphens", () => {
    expect(formatBranchName("-feat-test")).toBe("feat-test");
  });

  it("removes trailing hyphens", () => {
    expect(formatBranchName("feat-test-")).toBe("feat-test");
  });

  it("handles branch names with underscores", () => {
    expect(formatBranchName("feat_test")).toBe("feat_test");
  });
});

describe("shouldIncludeBranch", () => {
  it("returns original name when includeBranch is false", () => {
    expect(shouldIncludeBranch("myapp", "feat/test", false)).toBe("myapp");
  });

  it("returns original name when branch is null", () => {
    expect(shouldIncludeBranch("myapp", null, true)).toBe("myapp");
  });

  it("returns original name for main branch", () => {
    expect(shouldIncludeBranch("myapp", "main", true)).toBe("myapp");
  });

  it("returns original name for master branch", () => {
    expect(shouldIncludeBranch("myapp", "master", true)).toBe("myapp");
  });

  it("returns original name for dev branch", () => {
    expect(shouldIncludeBranch("myapp", "dev", true)).toBe("myapp");
  });

  it("returns original name for MAIN (case insensitive)", () => {
    expect(shouldIncludeBranch("myapp", "MAIN", true)).toBe("myapp");
  });

  it("prepends branch name for feature branches", () => {
    expect(shouldIncludeBranch("myapp", "feat/auth", true)).toBe("feat-auth-myapp");
  });

  it("prepends branch name for bugfix branches", () => {
    expect(shouldIncludeBranch("myapp", "bugfix/login", true)).toBe("bugfix-login-myapp");
  });
});
