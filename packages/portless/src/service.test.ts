import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import {
  buildServiceSpec,
  buildServiceUninstallSudoArgs,
  handleService,
  tryUninstallService,
  parseServiceInstallConfig,
} from "./service.js";
import { UsageError } from "./args.js";

vi.mock("node:fs", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:fs")>();
  return {
    ...mod,
    chmodSync: vi.fn(),
    existsSync: vi.fn(mod.existsSync),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(mod.readFileSync),
    realpathSync: vi.fn(mod.realpathSync),
    rmSync: vi.fn(),
    statSync: vi.fn(mod.statSync),
    writeFileSync: vi.fn(),
  };
});

vi.mock("./certs.js", () => ({
  ensureCerts: vi.fn(() => ({
    certPath: "/fake/server.pem",
    keyPath: "/fake/server-key.pem",
    caPath: "/fake/ca.pem",
    caGenerated: false,
  })),
  ensureTrust: vi.fn(() => ({
    state: "trusted",
    stores: { system: "trusted", browser: "not-applicable" },
  })),
}));

vi.mock("./utils.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./utils.js")>();
  return {
    ...mod,
    ensureStateDir: vi.fn(() => null),
    fixOwnership: vi.fn(),
  };
});

vi.mock("./mdns.js", () => ({
  isMdnsSupported: vi.fn(() => ({ supported: true })),
}));

vi.mock("./cli-utils.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./cli-utils.js")>();
  return {
    ...mod,
    discoverState: vi.fn(mod.discoverState),
    isProxyRunning: vi.fn(mod.isProxyRunning),
  };
});

const { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } =
  await import("node:fs");
const { isMdnsSupported } = await import("./mdns.js");
const { ensureStateDir } = await import("./utils.js");
const { discoverState, isProxyRunning } = await import("./cli-utils.js");
const actualCliUtils = await vi.importActual<typeof import("./cli-utils.js")>("./cli-utils.js");

const originalPlatform = process.platform;
const originalGetuid = process.getuid;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

function setGetuid(uid: number): void {
  Object.defineProperty(process, "getuid", {
    configurable: true,
    value: () => uid,
  });
}

function setExecPath(value: string): () => void {
  const original = Object.getOwnPropertyDescriptor(process, "execPath")!;
  Object.defineProperty(process, "execPath", { configurable: true, value });
  return () => Object.defineProperty(process, "execPath", original);
}

function setLinuxUser(): string {
  setPlatform("linux");
  setGetuid(1000);
  vi.stubEnv("HOME", "/home/alice");
  vi.stubEnv("USERPROFILE", "/home/alice");
  vi.stubEnv("SUDO_USER", "alice");
  vi.stubEnv("SUDO_UID", "1000");
  return "/home/alice";
}

afterEach(() => {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: originalPlatform,
  });
  Object.defineProperty(process, "getuid", {
    configurable: true,
    value: originalGetuid,
  });
  vi.mocked(existsSync).mockRestore();
  vi.mocked(mkdirSync).mockRestore();
  vi.mocked(ensureStateDir).mockClear();
  vi.mocked(readFileSync).mockRestore();
  vi.mocked(realpathSync).mockRestore();
  vi.mocked(rmSync).mockRestore();
  vi.mocked(statSync).mockRestore();
  vi.mocked(writeFileSync).mockRestore();
  vi.mocked(isMdnsSupported).mockReturnValue({ supported: true });
  vi.mocked(discoverState).mockReset();
  vi.mocked(discoverState).mockImplementation(actualCliUtils.discoverState);
  vi.mocked(isProxyRunning).mockReset();
  vi.mocked(isProxyRunning).mockImplementation(actualCliUtils.isProxyRunning);
  vi.unstubAllEnvs();
});

describe("buildServiceSpec", () => {
  it("builds a macOS LaunchDaemon for the HTTPS proxy", () => {
    const spec = buildServiceSpec({
      platform: "darwin",
      nodePath: "/usr/local/bin/node",
      entryScript: "/usr/local/lib/node_modules/portless/dist/cli.js",
      userHome: "/Users/alice",
      uid: "501",
      gid: "20",
    });

    expect(spec.platform).toBe("darwin");
    if (spec.platform !== "darwin") throw new Error("Expected macOS service spec");
    expect(spec.plistPath).toBe("/Library/LaunchDaemons/sh.portless.proxy.plist");
    expect(spec.programArguments).toEqual([
      "/usr/local/bin/node",
      "/usr/local/lib/node_modules/portless/dist/cli.js",
      "proxy",
      "start",
      "--foreground",
      "--port",
      "443",
      "--https",
      "--skip-trust",
    ]);
    expect(spec.plist).toContain("<key>RunAtLoad</key>");
    expect(spec.plist).toContain("<key>KeepAlive</key>");
    expect(spec.plist).toContain("<key>PORTLESS_STATE_DIR</key>");
    expect(spec.plist).toContain("<string>/Users/alice/.portless</string>");
    expect(spec.plist).toContain("<key>SUDO_UID</key>");
    expect(spec.plist).toContain("<string>501</string>");
  });

  it("builds a Linux systemd unit for the HTTPS proxy", () => {
    const spec = buildServiceSpec({
      platform: "linux",
      nodePath: "/usr/bin/node",
      entryScript: "/usr/lib/node_modules/portless/dist/cli.js",
      userHome: "/home/alice",
      uid: "1000",
      gid: "1000",
      username: "alice",
    });

    expect(spec.platform).toBe("linux");
    if (spec.platform !== "linux") throw new Error("Expected Linux service spec");
    expect(spec.scope).toBe("system");
    expect(spec.unitPath).toBe("/etc/systemd/system/portless.service");
    expect(spec.execStart).toEqual([
      "/usr/bin/node",
      "/usr/lib/node_modules/portless/dist/cli.js",
      "proxy",
      "start",
      "--foreground",
      "--port",
      "443",
      "--https",
      "--skip-trust",
    ]);
    expect(spec.unit).toContain("Description=Portless HTTPS proxy");
    expect(spec.unit).toContain('Environment=PORTLESS_STATE_DIR="/home/alice/.portless"');
    expect(spec.unit).toContain('Environment=SUDO_UID="1000"');
    expect(spec.unit).toContain('Environment=SUDO_USER="alice"');
    expect(spec.unit).toContain('Environment=PATH="/usr/bin:/bin:/usr/sbin:/sbin"');
    expect(spec.unit).toContain(
      'ExecStart="/usr/bin/node" "/usr/lib/node_modules/portless/dist/cli.js" "proxy" "start" "--foreground" "--port" "443" "--https" "--skip-trust"'
    );
    expect(spec.unit).toContain("WantedBy=multi-user.target");
    const unitSection = spec.unit.split("[Service]")[0];
    expect(unitSection).toContain("After=network-online.target");
    expect(unitSection).toContain("Wants=network-online.target");
    expect(unitSection).toContain("StartLimitIntervalSec=60");
    expect(unitSection).toContain("StartLimitBurst=5");
  });

  it("builds a Linux user unit when Node is installed under the user's home", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const spec = buildServiceSpec({
      platform: "linux",
      nodePath: "/home/alice/.nvm/versions/node/v22/bin/node",
      entryScript: "/home/alice/portless/cli.js",
      userHome: "/home/alice",
      uid: "1000",
      gid: "1000",
      pathEnv: "/usr/bin:/bin",
      installConfig: { extraEnv: { SUDO_UID: "1000", SUDO_GID: "1000" } },
    });

    if (spec.platform !== "linux") throw new Error("Expected Linux service spec");
    expect(spec.scope).toBe("user");
    expect(spec.execStart.slice(0, 2)).toEqual(["/usr/bin/env", "node"]);
    expect(spec.unitPath).toBe("/home/alice/.config/systemd/user/portless.service");
    expect(spec.unit).toContain("WantedBy=default.target");
    expect(spec.unit).not.toContain("network-online.target");
    expect(spec.unit).not.toContain("SUDO_UID");
    expect(spec.unit).not.toContain("SUDO_GID");
    expect(spec.unit).toContain('Environment=HOME="/home/alice"');
    expect(spec.unit).toContain(
      'Environment=PATH="/usr/bin:/bin:/home/alice/.nvm/versions/node/v22/bin"'
    );
    const unitSection = spec.unit.split("[Service]")[0];
    expect(unitSection).toContain("StartLimitIntervalSec=60");
    expect(unitSection).toContain("StartLimitBurst=5");

    const deduped = buildServiceSpec({
      platform: "linux",
      nodePath: "/home/alice/.nvm/versions/node/v22/bin/node",
      entryScript: "/fake/cli.js",
      userHome: "/home/alice",
      uid: "1000",
      pathEnv:
        "/home/alice/.nvm/versions/node/v22/bin/:/usr/bin:/home/alice/.nvm/versions/node/v22/bin::/usr/bin/",
    });
    if (deduped.platform !== "linux") throw new Error("Expected Linux service spec");
    expect(deduped.unit).toContain(
      'Environment=PATH="/home/alice/.nvm/versions/node/v22/bin/:/usr/bin"'
    );
    expect(deduped.unit.match(/^Environment=PATH=/gm)).toHaveLength(1);

    vi.mocked(existsSync).mockImplementation((file) => file === "/usr/local/bin/node");
    const shadowed = buildServiceSpec({
      platform: "linux",
      nodePath: "/home/alice/.nvm/versions/node/v22/bin/node",
      entryScript: "/fake/cli.js",
      userHome: "/home/alice",
      uid: "1000",
      pathEnv: "/usr/local/bin:/usr/bin",
    });
    if (shadowed.platform !== "linux") throw new Error("Expected Linux service spec");
    expect(shadowed.unit).toContain(
      'Environment=PATH="/home/alice/.nvm/versions/node/v22/bin:/usr/local/bin:/usr/bin"'
    );
  });

  it("recognizes Node under a symlinked home directory", () => {
    vi.mocked(realpathSync).mockImplementation((value) => {
      if (value === "/home/alice") return "/var/home/alice";
      if (value === "/var/home/alice/bin/node") return "/var/home/alice/bin/node";
      throw new Error("missing path");
    });
    const spec = buildServiceSpec({
      platform: "linux",
      nodePath: "/var/home/alice/bin/node",
      entryScript: "/fake/cli.js",
      userHome: "/home/alice",
      uid: "1000",
    });

    if (spec.platform !== "linux") throw new Error("Expected Linux service spec");
    expect(spec.scope).toBe("user");
  });

  it.each([
    ["user", "/home/alice/..runtime/bin/node", "/home/alice", "1000", "alice"],
    ["system", "/home/alice2/bin/node", "/home/alice", "1000", "alice"],
    ["system", "/home/alice/bin/node", "/home/alice", "0", "root"],
    ["system", "/home/alice/bin/node", "/home/alice", "1000", "root"],
    ["system", "/root/bin/node", "/root", "1000", "someone"],
  ] as const)(
    "selects the %s Linux scope for %s",
    (expected, nodePath, userHome, uid, username) => {
      const spec = buildServiceSpec({
        platform: "linux",
        nodePath,
        userHome,
        uid,
        username,
        entryScript: "/usr/lib/portless/cli.js",
        pathEnv: "/usr/local/bin:/bin",
      });

      if (spec.platform !== "linux") throw new Error("Expected Linux service spec");
      expect(spec.scope).toBe(expected);
    }
  );

  it("builds a Windows startup task for the HTTPS proxy", () => {
    const spec = buildServiceSpec({
      platform: "win32",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      entryScript: "C:\\Users\\Alice\\AppData\\Roaming\\npm\\node_modules\\portless\\dist\\cli.js",
      userHome: "C:\\Users\\Alice",
    });

    expect(spec.platform).toBe("win32");
    if (spec.platform !== "win32") throw new Error("Expected Windows service spec");
    expect(spec.taskName).toBe("Portless Proxy");
    expect(spec.scriptPath).toBe("C:\\ProgramData\\portless\\service\\portless-service.cmd");
    expect(spec.taskXmlPath).toBe("C:\\ProgramData\\portless\\service\\portless-task.xml");
    expect(spec.createArgs).toEqual([
      "/Create",
      "/TN",
      "Portless Proxy",
      "/XML",
      "C:\\ProgramData\\portless\\service\\portless-task.xml",
      "/F",
    ]);
    expect(spec.taskXml).toContain("<BootTrigger>");
    expect(spec.taskXml).toContain("<UserId>S-1-5-18</UserId>");
    expect(spec.taskXml).toContain("<RunLevel>HighestAvailable</RunLevel>");
    expect(spec.taskXml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(spec.taskXml).toContain("<Command>cmd.exe</Command>");
    expect(spec.taskXml).toContain(
      "<Arguments>/d /s /c &quot;&quot;C:\\ProgramData\\portless\\service\\portless-service.cmd&quot;&quot;</Arguments>"
    );
    expect(spec.script).toContain("PORTLESS_STATE_DIR=C:\\Users\\Alice\\.portless");
    expect(spec.script).toContain('"C:\\Program Files\\nodejs\\node.exe"');
    expect(spec.script).toContain("proxy");
    expect(spec.script).toContain("--port");
    expect(spec.script).toContain("443");
    expect(spec.script).toContain("--https");
    expect(spec.script).toContain("--skip-trust");
  });

  it("limits PATH in the Windows startup script to core system and Program Files directories", () => {
    const spec = buildServiceSpec({
      platform: "win32",
      nodePath: "C:\\nodejs\\node.exe",
      entryScript: "C:\\cli.js",
      userHome: "C:\\Users\\Alice",
      pathEnv:
        "C:\\Windows\\System32;C:\\Windows\\Temp;C:\\Program Files\\Git\\mingw64\\bin;C:\\Program Files\\100%Done;C:\\Tools\\100%Done",
    });

    if (spec.platform !== "win32") throw new Error("Expected Windows service spec");
    expect(spec.script).toContain(
      'set "PATH=C:\\Windows\\System32;C:\\Program Files\\Git\\mingw64\\bin;C:\\Program Files\\100%%Done"'
    );
    expect(spec.script).not.toContain("C:\\Windows\\Temp");
    expect(spec.script).not.toContain("C:\\Tools");
  });

  it("escapes percent signs in Windows batch env values", () => {
    const spec = buildServiceSpec({
      platform: "win32",
      nodePath: "C:\\nodejs\\node.exe",
      entryScript: "C:\\cli.js",
      userHome: "C:\\Users\\100%Done",
    });

    if (spec.platform !== "win32") throw new Error("Expected Windows service spec");
    expect(spec.script).toContain("PORTLESS_STATE_DIR=C:\\Users\\100%%Done\\.portless");
    expect(spec.script).not.toMatch(/(?<!%)%(?!%)/);
  });

  it("uses unconditional KeepAlive in the macOS plist", () => {
    const spec = buildServiceSpec({
      platform: "darwin",
      nodePath: "/usr/local/bin/node",
      entryScript: "/usr/local/lib/portless/cli.js",
      userHome: "/Users/bob",
      uid: "501",
      gid: "20",
    });

    if (spec.platform !== "darwin") throw new Error("Expected macOS service spec");
    expect(spec.plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(spec.plist).not.toContain("SuccessfulExit");
  });

  it("persists LAN and wildcard settings in a macOS LaunchDaemon", () => {
    const spec = buildServiceSpec({
      platform: "darwin",
      nodePath: "/usr/local/bin/node",
      entryScript: "/usr/local/lib/portless/cli.js",
      userHome: "/Users/alice",
      uid: "501",
      gid: "20",
      installConfig: {
        proxyPort: 8443,
        lanMode: true,
        lanIp: "192.168.1.42",
        lanIpExplicit: true,
        useWildcard: true,
      },
    });

    if (spec.platform !== "darwin") throw new Error("Expected macOS service spec");
    expect(spec.programArguments).toContain("--lan");
    expect(spec.programArguments).toContain("--ip");
    expect(spec.programArguments).toContain("192.168.1.42");
    expect(spec.programArguments).toContain("--wildcard");
    expect(spec.programArguments).toContain("8443");
    expect(spec.plist).toContain("<key>PORTLESS_LAN</key>");
    expect(spec.plist).toContain("<string>1</string>");
    expect(spec.plist).toContain("<key>PORTLESS_LAN_IP</key>");
    expect(spec.plist).toContain("<string>192.168.1.42</string>");
    expect(spec.plist).toContain("<key>PORTLESS_WILDCARD</key>");
  });

  it("defaults an unprivileged service to plain HTTP on port 80", () => {
    const config = parseServiceInstallConfig(["service", "install", "--unprivileged"], {});
    expect(config).toMatchObject({ unprivileged: true, useHttps: false, proxyPort: 80 });
  });

  it("accepts --flag=value for install options", () => {
    const config = parseServiceInstallConfig(
      ["service", "install", "--port=8443", "--tld=mydb"],
      {}
    );
    expect(config).toMatchObject({ proxyPort: 8443, tld: "mydb" });
  });

  it("lets the last TLS option decide HTTPS", () => {
    expect(
      parseServiceInstallConfig(["service", "install", "--no-tls", "--https"], {}).useHttps
    ).toBe(true);
    expect(
      parseServiceInstallConfig(["service", "install", "--https", "--no-tls"], {}).useHttps
    ).toBe(false);

    const certThenNoTls = parseServiceInstallConfig(
      ["service", "install", "--cert", "a.pem", "--key", "b.pem", "--no-tls"],
      {}
    );
    expect(certThenNoTls.useHttps).toBe(false);
    expect(certThenNoTls.customCertPath).toBe("a.pem");

    const noTlsThenCert = parseServiceInstallConfig(
      ["service", "install", "--no-tls", "--cert", "a.pem", "--key", "b.pem"],
      {}
    );
    expect(noTlsThenCert.useHttps).toBe(true);
  });

  it("keeps the last value of a repeated scalar flag", () => {
    expect(
      parseServiceInstallConfig(["service", "install", "--port", "1000", "-p", "2000"], {})
        .proxyPort
    ).toBe(2000);
    expect(
      parseServiceInstallConfig(["service", "install", "-p", "1000", "--port=2000"], {}).proxyPort
    ).toBe(2000);
    expect(
      parseServiceInstallConfig(["service", "install", "--ip", "10.0.0.1", "--ip", "10.0.0.2"], {})
        .lanIp
    ).toBe("10.0.0.2");
    expect(
      parseServiceInstallConfig(
        ["service", "install", "--state-dir", "/one", "--state-dir", "/two"],
        {}
      ).stateDir
    ).toBe("/two");
  });

  it("accumulates repeated --tld flags in order", () => {
    const config = parseServiceInstallConfig(
      ["service", "install", "--tld=one", "--tld", "two"],
      {}
    );
    expect(config.tlds).toEqual(["one", "two"]);
    expect(config.tld).toBe("one");
  });

  it("rejects an invalid --port value as a usage error", () => {
    expect(() => parseServiceInstallConfig(["service", "install", "--port=abc"], {})).toThrow(
      "Invalid port number: abc"
    );
  });

  it("rejects a value given to a boolean install flag", () => {
    expect(() => parseServiceInstallConfig(["service", "install", "--https=1"], {})).toThrow(
      "--https does not take a value."
    );
  });

  it("rejects an invalid --tld value as a usage error", () => {
    expect(() => parseServiceInstallConfig(["service", "install", "--tld=_bad"], {})).toThrow(
      UsageError
    );
  });

  it.each([
    [["--unprivileged", "--https"], {}],
    [["--unprivileged"], { PORTLESS_HTTPS: "1" }],
  ])("keeps HTTPS for an unprivileged service when asked: %j %j", (flags, env) => {
    const config = parseServiceInstallConfig(["service", "install", ...flags], env);
    expect(config).toMatchObject({ unprivileged: true, useHttps: true, proxyPort: 443 });
  });

  it("persists unprivileged mode in a Linux service", () => {
    const spec = buildServiceSpec({
      platform: "linux",
      nodePath: "/usr/bin/node",
      entryScript: "/usr/lib/node_modules/portless/dist/cli.js",
      userHome: "/home/alice",
      uid: "1000",
      gid: "1000",
      installConfig: { proxyPort: 80, useHttps: false, unprivileged: true },
    });

    if (spec.platform !== "linux") throw new Error("Expected Linux service spec");
    expect(spec.execStart).toContain("--unprivileged");
    expect(spec.unit).toContain('Environment=PORTLESS_UNPRIVILEGED="1"');
  });

  it("persists no-TLS, custom TLD, and custom state in a Linux service", () => {
    const spec = buildServiceSpec({
      platform: "linux",
      nodePath: "/usr/bin/node",
      entryScript: "/usr/lib/node_modules/portless/dist/cli.js",
      userHome: "/home/alice",
      uid: "1000",
      gid: "1000",
      installConfig: {
        stateDir: "/srv/portless",
        proxyPort: 8080,
        useHttps: false,
        tld: "test",
        useWildcard: true,
      },
    });

    if (spec.platform !== "linux") throw new Error("Expected Linux service spec");
    expect(spec.execStart).toContain("--no-tls");
    expect(spec.execStart).toContain("--tld");
    expect(spec.execStart).toContain("test");
    expect(spec.execStart).toContain("--wildcard");
    expect(spec.unit).toContain('Environment=PORTLESS_STATE_DIR="/srv/portless"');
    expect(spec.unit).toContain('Environment=PORTLESS_PORT="8080"');
    expect(spec.unit).toContain('Environment=PORTLESS_HTTPS="0"');
    expect(spec.unit).toContain('Environment=PORTLESS_TLD="test"');
    expect(spec.stateDir).toBe("/srv/portless");
  });
});

describe("buildServiceUninstallSudoArgs", () => {
  it("builds a service-scoped sudo command that preserves user state", () => {
    const args = buildServiceUninstallSudoArgs("/fake/cli.js", {
      nodePath: "/usr/bin/node",
      home: "/Users/alice",
      env: {
        PORTLESS_STATE_DIR: "/Users/alice/.portless",
        PORTLESS_DEBUG: "1",
        OTHER_ENV: "ignored",
      },
    });

    expect(args).toEqual([
      "env",
      "PORTLESS_DEBUG=1",
      "HOME=/Users/alice",
      "PORTLESS_STATE_DIR=/Users/alice/.portless",
      "/usr/bin/node",
      "/fake/cli.js",
      "service",
      "uninstall",
    ]);
    expect(args).not.toContain("clean");
  });
});

describe("unloaded macOS service removal", () => {
  it.each(["clean", "uninstall"])("removes the plist during %s", async (command) => {
    setPlatform("darwin");
    setGetuid(0);
    vi.mocked(existsSync).mockReturnValue(true);
    const runner = vi.fn((_: string, args: string[]) => ({
      status: args.length === 2 ? 3 : 5,
      stdout: "",
      stderr:
        args.length === 2
          ? "Boot-out failed: 3: No such process"
          : "Boot-out failed: 5: Input/output error",
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      if (command === "clean") {
        expect(tryUninstallService("/fake/cli.js", runner)).toEqual({
          removed: true,
          installed: true,
        });
      } else {
        await handleService(["service", "uninstall"], { entryScript: "/fake/cli.js", runner });
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("uninstalled"));
      }
      expect(runner).toHaveBeenCalledWith("launchctl", ["bootout", "system/sh.portless.proxy"]);
      expect(rmSync).toHaveBeenCalledWith("/Library/LaunchDaemons/sh.portless.proxy.plist", {
        force: true,
      });
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("tryUninstallService", () => {
  it("returns removed: false when service is not installed", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const runner = () => ({ status: 1, stdout: "", stderr: "" });
    const result = tryUninstallService("/fake/cli.js", runner);
    expect(result.removed).toBe(false);
    expect(result.installed).toBe(false);
  });

  it("returns removed: false when runner throws", () => {
    setPlatform("linux");
    vi.mocked(existsSync).mockImplementation(
      (file) => file === "/etc/systemd/system/portless.service"
    );
    const runner = () => {
      throw new Error("spawn failed");
    };
    const result = tryUninstallService("/fake/cli.js", runner);
    vi.mocked(existsSync).mockRestore();
    expect(result.removed).toBe(false);
    expect(result.installed).toBe(true);
    expect(result.error).toContain("spawn failed");
  });

  it("marks installed services that need elevation", () => {
    setPlatform("linux");
    vi.mocked(existsSync).mockImplementation(
      (file) => file === "/etc/systemd/system/portless.service"
    );
    vi.mocked(rmSync).mockImplementation(() => {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    const result = tryUninstallService("/fake/cli.js", runner);

    expect(result.removed).toBe(false);
    expect(result.installed).toBe(true);
    expect(result.needsElevation).toBe(true);
  });

  it("marks systemctl's interactive authentication failure as needing elevation", () => {
    setPlatform("linux");
    vi.mocked(existsSync).mockImplementation(
      (file) => file === "/etc/systemd/system/portless.service"
    );
    const runner = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "Failed to disable unit: Interactive authentication required.",
    }));

    const result = tryUninstallService("/fake/cli.js", runner);

    expect(result.removed).toBe(false);
    expect(result.installed).toBe(true);
    expect(result.error).toContain("Interactive authentication required");
    expect(result.needsElevation).toBe(true);
    expect(rmSync).not.toHaveBeenCalled();
  });

  it("does not claim elevation when the removal runs as root", () => {
    setPlatform("linux");
    setGetuid(0);
    vi.mocked(existsSync).mockImplementation(
      (file) => file === "/etc/systemd/system/portless.service"
    );
    const runner = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "Failed to disable unit: Unit file is masked.",
    }));

    const result = tryUninstallService("/fake/cli.js", runner);

    expect(result.removed).toBe(false);
    expect(result.needsElevation).toBe(false);
  });

  it("does not claim elevation when the service manager is missing", () => {
    setPlatform("linux");
    vi.mocked(existsSync).mockImplementation(
      (file) => file === "/etc/systemd/system/portless.service"
    );
    const runner = vi.fn(() => {
      const err = new Error("spawn systemctl ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      return { status: null, error: err };
    });

    const result = tryUninstallService("/fake/cli.js", runner);

    expect(result.removed).toBe(false);
    expect(result.needsElevation).toBe(false);
  });

  it("removes the user unit first and requests elevation for a system unit", () => {
    const home = setLinuxUser();
    const restoreExecPath = setExecPath("/usr/bin/node");
    const userUnit = path.posix.join(home, ".config/systemd/user/portless.service");
    const systemUnit = "/etc/systemd/system/portless.service";
    vi.mocked(existsSync).mockImplementation((file) => file === userUnit || file === systemUnit);
    const runner = vi.fn((_: string, args: string[]) =>
      args[0] === "--user"
        ? { status: 0, stdout: "", stderr: "" }
        : { status: 1, stdout: "", stderr: "Access denied" }
    );

    try {
      expect(tryUninstallService("/fake/cli.js", runner)).toEqual({
        removed: false,
        installed: true,
        error: "Access denied",
        needsElevation: true,
      });
      expect(runner.mock.calls).toEqual([
        ["systemctl", ["--user", "disable", "--now", "portless.service"]],
        ["systemctl", ["--user", "daemon-reload"]],
        ["systemctl", ["disable", "--now", "portless.service"]],
      ]);
      expect(rmSync).toHaveBeenCalledTimes(1);
      expect(rmSync).toHaveBeenCalledWith(userUnit, { force: true });
    } finally {
      restoreExecPath();
      vi.unstubAllEnvs();
    }
  });

  it("does not request elevation when removing a user unit fails", () => {
    const home = setLinuxUser();
    const restoreExecPath = setExecPath("/usr/bin/node");
    const userUnit = path.posix.join(home, ".config/systemd/user/portless.service");
    vi.mocked(existsSync).mockImplementation((file) => file === userUnit);
    const runner = vi.fn(() => ({ status: 1, stdout: "", stderr: "Access denied" }));

    try {
      expect(tryUninstallService("/fake/cli.js", runner)).toEqual({
        removed: false,
        installed: true,
        error: "Access denied",
        needsElevation: false,
      });
      expect(runner).toHaveBeenCalledWith("systemctl", [
        "--user",
        "disable",
        "--now",
        "portless.service",
      ]);
      expect(rmSync).not.toHaveBeenCalled();
    } finally {
      restoreExecPath();
      vi.unstubAllEnvs();
    }
  });

  it("reports a failed launchctl bootout instead of claiming removal", () => {
    setPlatform("darwin");
    vi.mocked(existsSync).mockReturnValue(true);
    const runner = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "Boot-out failed: 1: Operation not permitted",
    }));

    const result = tryUninstallService("/fake/cli.js", runner);

    expect(result.removed).toBe(false);
    expect(result.installed).toBe(true);
    expect(result.error).toContain("Operation not permitted");
    expect(result.needsElevation).toBe(true);
    expect(rmSync).not.toHaveBeenCalled();
  });

  it("keeps Windows service files when the task store cannot be read", () => {
    setPlatform("win32");
    vi.mocked(statSync).mockImplementation(() => {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });
    const runner = vi.fn(() => ({ status: 1, stdout: "", stderr: "ERROR: Access is denied." }));

    const result = tryUninstallService("/fake/cli.js", runner);

    expect(result.removed).toBe(false);
    expect(result.error).toContain("permission denied");
    expect(runner).not.toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
  });
});

describe("handleService", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("prints help and exits 0 when no subcommand is given", async () => {
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    await expect(
      handleService(["service"], { entryScript: "/fake/cli.js", runner })
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(0);
    const output = logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(output).toContain("portless service");
    expect(output).toContain("service install");
    expect(output).toContain("service uninstall");
    expect(output).toContain("service status");
  });

  it("throws a usage error for an unknown subcommand", async () => {
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    await expect(
      handleService(["service", "bogus"], { entryScript: "/fake/cli.js", runner })
    ).rejects.toThrow('Unknown service command "bogus".');
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects unsupported LAN service installs before writing a Windows task", async () => {
    setPlatform("win32");
    vi.mocked(isMdnsSupported).mockReturnValue({
      supported: false,
      reason: "mDNS publishing is not supported on this platform",
    });
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    await expect(
      handleService(["service", "install", "--lan"], {
        entryScript: "/fake/cli.js",
        runner,
      })
    ).rejects.toThrow("LAN mode requires mDNS publishing");

    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(ensureStateDir).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("registers the Windows task with no execution time limit before starting it", async () => {
    setPlatform("win32");
    const originalUserProfile = process.env.USERPROFILE;
    const originalProgramData = process.env.ProgramData;
    process.env.USERPROFILE = "C:\\Users\\Alice";
    process.env.ProgramData = "C:\\ProgramData";
    const runner = vi.fn((_: string, _args: string[]) => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));

    try {
      await handleService(["service", "install"], {
        entryScript: "C:\\cli.js",
        runner,
      });
    } finally {
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
      if (originalProgramData === undefined) {
        delete process.env.ProgramData;
      } else {
        process.env.ProgramData = originalProgramData;
      }
    }

    const calls = runner.mock.calls.map(([command, args]) => ({ command, args }));
    const createIndex = calls.findIndex(
      (call) => call.command === "schtasks" && call.args[0] === "/Create"
    );
    const runIndex = calls.findIndex(
      (call) => call.command === "schtasks" && call.args[0] === "/Run"
    );
    const taskXmlWrite = vi
      .mocked(writeFileSync)
      .mock.calls.find(
        ([file]) => file === "C:\\ProgramData\\portless\\service\\portless-task.xml"
      );

    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(runIndex).toBeGreaterThan(createIndex);
    expect(calls.some((call) => call.command === "powershell.exe")).toBe(false);
    expect(taskXmlWrite?.[1]).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(taskXmlWrite?.[2]).toBe("utf16le");
  });

  it("does not start a Windows task when atomic registration fails", async () => {
    setPlatform("win32");
    const originalUserProfile = process.env.USERPROFILE;
    const originalProgramData = process.env.ProgramData;
    process.env.USERPROFILE = "C:\\Users\\Alice";
    process.env.ProgramData = "C:\\ProgramData";
    const runner = vi.fn((command: string, args: string[]) => ({
      status: command === "schtasks" && args[0] === "/Create" ? 1 : 0,
      stdout: "",
      stderr: command === "schtasks" && args[0] === "/Create" ? "registration failed" : "",
    }));

    try {
      await expect(
        handleService(["service", "install"], {
          entryScript: "C:\\cli.js",
          runner,
        })
      ).rejects.toThrow("registration failed");
    } finally {
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
      if (originalProgramData === undefined) {
        delete process.env.ProgramData;
      } else {
        process.env.ProgramData = originalProgramData;
      }
    }

    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    const calls = runner.mock.calls.map(([command, args]) => ({ command, args }));
    expect(calls.some((call) => call.command === "powershell.exe")).toBe(false);
    expect(calls.some((call) => call.command === "schtasks" && call.args[0] === "/Run")).toBe(
      false
    );
  });

  it("does not stop the previous Windows task when replacement registration fails", async () => {
    setPlatform("win32");
    const originalUserProfile = process.env.USERPROFILE;
    const originalProgramData = process.env.ProgramData;
    process.env.USERPROFILE = "C:\\Users\\Alice";
    process.env.ProgramData = "C:\\ProgramData";
    const runner = vi.fn((command: string, args: string[]) => ({
      status: command === "schtasks" && args[0] === "/Create" ? 1 : 0,
      stdout: "",
      stderr: command === "schtasks" && args[0] === "/Create" ? "registration failed" : "",
    }));

    try {
      await expect(
        handleService(["service", "install"], {
          entryScript: "C:\\cli.js",
          runner,
        })
      ).rejects.toThrow("registration failed");
    } finally {
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
      if (originalProgramData === undefined) {
        delete process.env.ProgramData;
      } else {
        process.env.ProgramData = originalProgramData;
      }
    }

    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    const taskCalls = runner.mock.calls
      .filter(([command]) => command === "schtasks")
      .map(([, args]) => args[0]);
    expect(taskCalls).toEqual(["/Create"]);
    expect(taskCalls).not.toContain("/Delete");
    expect(
      runner.mock.calls.some(
        ([command, args]) =>
          command === process.execPath && args.join(" ") === "C:\\cli.js proxy stop --port 443"
      )
    ).toBe(false);
  });

  it("keeps an atomically registered Windows task when immediate start fails", async () => {
    setPlatform("win32");
    const originalUserProfile = process.env.USERPROFILE;
    const originalProgramData = process.env.ProgramData;
    process.env.USERPROFILE = "C:\\Users\\Alice";
    process.env.ProgramData = "C:\\ProgramData";
    const runner = vi.fn((command: string, args: string[]) => ({
      status: command === "schtasks" && args[0] === "/Run" ? 1 : 0,
      stdout: "",
      stderr: "",
    }));

    try {
      await handleService(["service", "install"], {
        entryScript: "C:\\cli.js",
        runner,
      });
    } finally {
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
      if (originalProgramData === undefined) {
        delete process.env.ProgramData;
      } else {
        process.env.ProgramData = originalProgramData;
      }
    }

    const calls = runner.mock.calls.map(([command, args]) => ({ command, args }));
    expect(calls.some((call) => call.command === "schtasks" && call.args[0] === "/Create")).toBe(
      true
    );
    expect(calls.some((call) => call.command === "schtasks" && call.args[0] === "/Delete")).toBe(
      false
    );
    expect(logSpy.mock.calls.flat().join(" ")).toContain("Portless service installed.");
  });

  it("removes Windows service files even when no task was registered", async () => {
    setPlatform("win32");
    const originalUserProfile = process.env.USERPROFILE;
    const originalProgramData = process.env.ProgramData;
    process.env.USERPROFILE = "C:\\Users\\Alice";
    process.env.ProgramData = "C:\\ProgramData";
    const runner = vi.fn((_: string, _args: string[]) => ({
      status: 1,
      stdout: "",
      stderr: "",
    }));

    try {
      await handleService(["service", "uninstall"], {
        entryScript: "C:\\cli.js",
        runner,
      });
    } finally {
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
      if (originalProgramData === undefined) {
        delete process.env.ProgramData;
      } else {
        process.env.ProgramData = originalProgramData;
      }
    }

    expect(rmSync).toHaveBeenCalledWith("C:\\ProgramData\\portless\\service", {
      recursive: true,
      force: true,
    });
  });

  it("keeps Windows service files when the registered task cannot be removed", async () => {
    setPlatform("win32");
    vi.mocked(statSync).mockReturnValue({} as never);
    const runner = vi.fn((_: string, _args: string[]) => ({
      status: 1,
      stdout: "",
      stderr: "ERROR: Access is denied.",
    }));

    await expect(
      handleService(["service", "uninstall"], {
        entryScript: "C:\\cli.js",
        runner,
      })
    ).rejects.toThrow("Access is denied.");

    expect(rmSync).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join(" ")).not.toContain("uninstalled");
  });

  it("repeated Windows installs always register the PT0S task definition", async () => {
    setPlatform("win32");
    const originalUserProfile = process.env.USERPROFILE;
    const originalProgramData = process.env.ProgramData;
    process.env.USERPROFILE = "C:\\Users\\Alice";
    process.env.ProgramData = "C:\\ProgramData";
    const runner = vi.fn((_: string, _args: string[]) => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));

    try {
      await handleService(["service", "install"], {
        entryScript: "C:\\cli.js",
        runner,
      });
      await handleService(["service", "install"], {
        entryScript: "C:\\cli.js",
        runner,
      });
    } finally {
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
      if (originalProgramData === undefined) {
        delete process.env.ProgramData;
      } else {
        process.env.ProgramData = originalProgramData;
      }
    }

    const taskXmlWrites = vi
      .mocked(writeFileSync)
      .mock.calls.filter(
        ([file]) => file === "C:\\ProgramData\\portless\\service\\portless-task.xml"
      );
    const createCalls = runner.mock.calls.filter(
      ([command, args]) => command === "schtasks" && args[0] === "/Create"
    );
    expect(taskXmlWrites).toHaveLength(2);
    expect(
      taskXmlWrites.every(([, content]) =>
        String(content).includes("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>")
      )
    ).toBe(true);
    expect(taskXmlWrites.every(([, , encoding]) => encoding === "utf16le")).toBe(true);
    expect(createCalls).toHaveLength(2);
    expect(createCalls.every(([, args]) => args.includes("/XML"))).toBe(true);
  });

  it("stops an existing proxy before restarting the Linux service", async () => {
    setPlatform("linux");
    setGetuid(0);
    const runner = vi.fn((_: string, _args: string[]) => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));

    await handleService(["service", "install"], {
      entryScript: "/fake/cli.js",
      runner,
    });

    const calls = runner.mock.calls.map(([command, args]) => ({ command, args }));
    const stopIndex = calls.findIndex(
      (call) =>
        call.command === process.execPath &&
        call.args.join(" ") === "/fake/cli.js proxy stop --port 443"
    );
    const restartIndex = calls.findIndex(
      (call) => call.command === "systemctl" && call.args.join(" ") === "restart portless.service"
    );

    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(restartIndex).toBeGreaterThan(stopIndex);
  });

  it("uses install flags when stopping an existing proxy before restart", async () => {
    setPlatform("linux");
    setGetuid(0);
    const runner = vi.fn((_: string, _args: string[]) => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));

    await handleService(["service", "install", "--port", "8443", "--wildcard"], {
      entryScript: "/fake/cli.js",
      runner,
    });

    const calls = runner.mock.calls.map(([command, args]) => ({ command, args }));
    expect(calls).toContainEqual({
      command: process.execPath,
      args: ["/fake/cli.js", "proxy", "stop", "--port", "8443"],
    });
  });

  it("stops the discovered proxy before a different install port", async () => {
    setPlatform("linux");
    setGetuid(0);
    const currentPort = 19000;
    const targetPort = 19001;
    vi.mocked(discoverState).mockResolvedValue({
      dir: "/tmp/portless-service-current-test",
      port: currentPort,
      tls: true,
      tld: "localhost",
      tlds: ["localhost"],
      lanMode: false,
      lanIp: null,
    });
    vi.mocked(isProxyRunning).mockImplementation(async (port) => port === currentPort);
    const runner = vi.fn((_: string, _args: string[]) => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));

    await handleService(["service", "install", "--port", targetPort.toString()], {
      entryScript: "/fake/cli.js",
      runner,
    });

    const stopPorts = runner.mock.calls
      .filter(
        ([command, args]) =>
          command === process.execPath &&
          args[0] === "/fake/cli.js" &&
          args[1] === "proxy" &&
          args[2] === "stop"
      )
      .map(([, args]) => args[4]);
    expect(stopPorts).toEqual([currentPort.toString(), targetPort.toString()]);
  });

  it("does not validate proxy env while uninstalling", async () => {
    setPlatform("linux");
    setGetuid(0);
    const originalPort = process.env.PORTLESS_PORT;
    const originalTld = process.env.PORTLESS_TLD;
    process.env.PORTLESS_PORT = "abc";
    process.env.PORTLESS_TLD = "bad-name";
    const runner = vi.fn((_: string, _args: string[]) => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));

    try {
      await handleService(["service", "uninstall"], {
        entryScript: "/fake/cli.js",
        runner,
      });
    } finally {
      if (originalPort === undefined) {
        delete process.env.PORTLESS_PORT;
      } else {
        process.env.PORTLESS_PORT = originalPort;
      }
      if (originalTld === undefined) {
        delete process.env.PORTLESS_TLD;
      } else {
        process.env.PORTLESS_TLD = originalTld;
      }
    }

    expect(exitSpy).not.toHaveBeenCalled();
    expect(runner).toHaveBeenCalledWith("systemctl", ["disable", "--now", "portless.service"]);
  });

  it("fails the uninstall when the Linux service still cannot be disabled", async () => {
    setPlatform("linux");
    setGetuid(0);
    const runner = vi.fn((_: string, _args: string[]) => ({
      status: 1,
      stdout: "",
      stderr: "Failed to disable unit: Access denied",
    }));

    await expect(
      handleService(["service", "uninstall"], {
        entryScript: "/fake/cli.js",
        runner,
      })
    ).rejects.toThrow("Access denied");

    expect(rmSync).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join(" ")).not.toContain("uninstalled");
  });

  it("normalizes relative install paths before writing the Linux service", async () => {
    setPlatform("linux");
    setGetuid(0);
    const runner = vi.fn((_: string, _args: string[]) => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));

    await handleService(
      [
        "service",
        "install",
        "--state-dir",
        "relative-state",
        "--cert",
        "cert.pem",
        "--key",
        "key.pem",
      ],
      {
        entryScript: "/fake/cli.js",
        runner,
      }
    );

    const stateDir = path.resolve("relative-state");
    const certPath = path.resolve("cert.pem");
    const keyPath = path.resolve("key.pem");
    const systemdStateDir = stateDir.replace(/\\/g, "\\\\");
    const systemdCertPath = certPath.replace(/\\/g, "\\\\");
    const systemdKeyPath = keyPath.replace(/\\/g, "\\\\");
    const unitWrite = vi
      .mocked(writeFileSync)
      .mock.calls.find(([file]) => file === "/etc/systemd/system/portless.service");
    const unit = String(unitWrite?.[1] ?? "");

    expect(ensureStateDir).toHaveBeenCalledWith(stateDir);
    expect(unit).toContain(`Environment=PORTLESS_STATE_DIR="${systemdStateDir}"`);
    expect(unit).toContain(`"--cert" "${systemdCertPath}" "--key" "${systemdKeyPath}"`);
  });

  it("refuses to install when another user controls the state directory", async () => {
    setPlatform("linux");
    setGetuid(0);
    vi.mocked(ensureStateDir).mockReturnValueOnce("it is owned by another user");
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    await expect(
      handleService(["service", "install", "--state-dir", "/shared/state"], {
        entryScript: "/fake/cli.js",
        runner,
      })
    ).rejects.toThrow(
      `Cannot install the service with state in ${path.resolve("/shared/state")}: it is owned by another user`
    );

    expect(runner).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("installs a user unit without sudo when Node is under the user's home", async () => {
    const home = setLinuxUser();
    const restoreExecPath = setExecPath(path.posix.join(home, ".nvm/versions/node/v22/bin/node"));
    const userDir = path.posix.join(home, ".config/systemd/user");
    const systemUnit = "/etc/systemd/system/portless.service";
    vi.mocked(existsSync).mockImplementation((file) => file === systemUnit);
    const runner = vi.fn((_: string, _args: string[]) => ({ status: 0, stdout: "", stderr: "" }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await handleService(["service", "install", "--port", "8443"], {
        entryScript: "/fake/cli.js",
        runner,
      });

      expect(runner.mock.calls.some(([command]) => command === "sudo")).toBe(false);
      expect(mkdirSync).toHaveBeenCalledWith(userDir, { recursive: true });
      expect(writeFileSync).toHaveBeenCalledWith(
        path.posix.join(userDir, "portless.service"),
        expect.stringContaining("WantedBy=default.target")
      );
      expect(runner).toHaveBeenCalledWith("systemctl", ["--user", "daemon-reload"]);
      expect(runner).toHaveBeenCalledWith("systemctl", ["--user", "enable", "portless.service"]);
      expect(runner).toHaveBeenCalledWith("systemctl", ["--user", "restart", "portless.service"]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("`sudo portless service uninstall`")
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("loginctl enable-linger alice"));
    } finally {
      warnSpy.mockRestore();
      restoreExecPath();
      vi.unstubAllEnvs();
    }
  });

  it("honors an absolute XDG_CONFIG_HOME for a non-sudo user install", async () => {
    const home = setLinuxUser();
    vi.stubEnv("SUDO_USER", "");
    vi.stubEnv("XDG_CONFIG_HOME", "/home/alice/custom-config");
    const restoreExecPath = setExecPath(path.posix.join(home, ".nvm/bin/node"));
    const userUnit = "/home/alice/custom-config/systemd/user/portless.service";
    vi.mocked(existsSync).mockReturnValue(false);
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    try {
      await handleService(["service", "install", "--port", "8443"], {
        entryScript: "/fake/cli.js",
        runner,
      });
      expect(mkdirSync).toHaveBeenCalledWith("/home/alice/custom-config/systemd/user", {
        recursive: true,
      });
      expect(writeFileSync).toHaveBeenCalledWith(
        userUnit,
        expect.stringContaining("WantedBy=default.target")
      );
    } finally {
      restoreExecPath();
      vi.unstubAllEnvs();
    }
  });

  it("rejects a user service that cannot bind its configured port before side effects", async () => {
    const home = setLinuxUser();
    const restoreExecPath = setExecPath(path.posix.join(home, ".nvm/bin/node"));
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockImplementation((file) =>
      file === "/proc/sys/net/ipv4/ip_unprivileged_port_start" ? "1024" : ""
    );
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    try {
      await expect(
        handleService(["service", "install", "--port", "443"], {
          entryScript: "/fake/cli.js",
          runner,
        })
      ).rejects.toThrow(
        /Cannot install a systemd user service on port 443:[\s\S]*ip_unprivileged_port_start=443/
      );
      expect(runner).not.toHaveBeenCalled();
      expect(mkdirSync).not.toHaveBeenCalled();
      expect(writeFileSync).not.toHaveBeenCalled();
      expect(ensureStateDir).not.toHaveBeenCalled();
    } finally {
      restoreExecPath();
      vi.unstubAllEnvs();
    }
  });

  it("rejects a sudo install of a user service before writing files", async () => {
    const home = setLinuxUser();
    setGetuid(0);
    const restoreExecPath = setExecPath(path.posix.join(home, ".nvm/bin/node"));
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    try {
      await expect(
        handleService(["service", "install"], { entryScript: "/fake/cli.js", runner })
      ).rejects.toThrow(
        `Node is installed under ${home}, which uses a systemd user service. Re-run \`portless service install\` without sudo.`
      );
      expect(runner).not.toHaveBeenCalled();
      expect(mkdirSync).not.toHaveBeenCalled();
      expect(writeFileSync).not.toHaveBeenCalled();
    } finally {
      restoreExecPath();
      vi.unstubAllEnvs();
    }
  });

  it("finds and uninstalls a user unit when Node is installed system-wide", async () => {
    const home = setLinuxUser();
    const restoreExecPath = setExecPath("/usr/bin/node");
    const userUnit = path.posix.join(home, ".config/systemd/user/portless.service");
    const installedSpec = buildServiceSpec({
      platform: "linux",
      nodePath: path.posix.join(home, ".nvm/bin/node"),
      entryScript: "/fake/cli.js",
      userHome: home,
      installConfig: { proxyPort: 8443, useHttps: false },
    });
    if (installedSpec.platform !== "linux") throw new Error("Expected Linux service spec");
    vi.mocked(existsSync).mockImplementation((file) => file === installedSpec.unitPath);
    vi.mocked(readFileSync).mockImplementation((file) =>
      file === installedSpec.unitPath ? installedSpec.unit : ""
    );
    vi.mocked(isProxyRunning).mockResolvedValue(false);
    const runner = vi.fn((_: string, _args: string[]) => ({
      status: 0,
      stdout: "active\n",
      stderr: "",
    }));

    try {
      await handleService(["service", "status"], { entryScript: "/fake/cli.js", runner });
      expect(runner).toHaveBeenCalledWith("systemctl", [
        "--user",
        "is-enabled",
        "portless.service",
      ]);
      expect(runner).toHaveBeenCalledWith("systemctl", ["--user", "is-active", "portless.service"]);
      const output = logSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
      expect(output).toContain("Proxy on 8443");
      expect(output).toContain(`Service entry: ${installedSpec.unitPath}`);

      await handleService(["service", "uninstall"], { entryScript: "/fake/cli.js", runner });
      expect(runner.mock.calls.some(([command]) => command === "sudo")).toBe(false);
      expect(rmSync).toHaveBeenCalledWith(userUnit, { force: true });
    } finally {
      restoreExecPath();
      vi.unstubAllEnvs();
    }
  });

  it("removes the system unit and warns to keep the home Node user unit for sudo", async () => {
    const home = setLinuxUser();
    setGetuid(0);
    const restoreExecPath = setExecPath(path.posix.join(home, ".nvm/bin/node"));
    const userUnit = path.posix.join(home, ".config/systemd/user/portless.service");
    const systemUnit = "/etc/systemd/system/portless.service";
    vi.mocked(existsSync).mockImplementation((file) => file === userUnit || file === systemUnit);
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await handleService(["service", "uninstall"], { entryScript: "/fake/cli.js", runner });
      expect(runner.mock.calls).toEqual([
        ["systemctl", ["disable", "--now", "portless.service"]],
        ["systemctl", ["daemon-reload"]],
      ]);
      expect(rmSync).toHaveBeenCalledTimes(1);
      expect(rmSync).toHaveBeenCalledWith(systemUnit, { force: true });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(userUnit));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("(without sudo)"));
    } finally {
      warnSpy.mockRestore();
      restoreExecPath();
      vi.unstubAllEnvs();
    }
  });

  it("rejects a sudo uninstall of an installed user unit", async () => {
    const home = setLinuxUser();
    setGetuid(0);
    const restoreExecPath = setExecPath("/usr/bin/node");
    const userUnit = path.posix.join(home, ".config/systemd/user/portless.service");
    vi.mocked(existsSync).mockImplementation((file) => file === userUnit);
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    try {
      await expect(
        handleService(["service", "uninstall"], { entryScript: "/fake/cli.js", runner })
      ).rejects.toThrow(
        "The installed service is a systemd user service. Re-run `portless service uninstall` without sudo."
      );
      expect(runner).not.toHaveBeenCalled();
      expect(rmSync).not.toHaveBeenCalled();
    } finally {
      restoreExecPath();
      vi.unstubAllEnvs();
    }
  });

  it("prints installed service config from a Linux unit", async () => {
    setPlatform("linux");
    setGetuid(0);
    const installedSpec = buildServiceSpec({
      platform: "linux",
      nodePath: process.execPath,
      entryScript: "/fake/cli.js",
      userHome: "/home/alice",
      installConfig: {
        stateDir: "/srv/portless",
        proxyPort: 8443,
        useHttps: false,
        lanMode: true,
        lanIp: "192.168.1.42",
        lanIpExplicit: true,
        useWildcard: true,
      },
    });
    if (installedSpec.platform !== "linux") throw new Error("Expected Linux service spec");

    vi.mocked(existsSync).mockImplementation((file) => file === installedSpec.unitPath);
    vi.mocked(readFileSync).mockImplementation((file) => {
      if (file === installedSpec.unitPath) return installedSpec.unit;
      return "";
    });
    const runner = vi.fn((command: string, args: string[]) => {
      if (command === "systemctl" && args[0] === "is-enabled") {
        return { status: 0, stdout: "enabled\n", stderr: "" };
      }
      if (command === "systemctl" && args[0] === "is-active") {
        return { status: 1, stdout: "inactive\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    await handleService(["service", "status"], {
      entryScript: "/fake/cli.js",
      runner,
    });

    const output = logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(output).toContain("Proxy on 8443");
    expect(output).toContain("HTTPS: no");
    expect(output).toContain("TLDs: .local");
    expect(output).toContain("LAN mode: yes");
    expect(output).toContain("LAN IP: 192.168.1.42");
    expect(output).toContain("Wildcard: yes");
    expect(output).toContain("State directory: /srv/portless");
  });
});
