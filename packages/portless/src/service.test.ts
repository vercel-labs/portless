import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import {
  buildServiceSpec,
  buildServiceUninstallSudoArgs,
  handleService,
  tryUninstallService,
} from "./service.js";

vi.mock("node:fs", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:fs")>();
  return {
    ...mod,
    chmodSync: vi.fn(),
    existsSync: vi.fn(mod.existsSync),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(mod.readFileSync),
    rmSync: vi.fn(),
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
  isCATrusted: vi.fn(() => true),
  trustCA: vi.fn(() => ({ trusted: true })),
}));

vi.mock("./utils.js", () => ({
  fixOwnership: vi.fn(),
}));

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

const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
const { isMdnsSupported } = await import("./mdns.js");
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
  vi.mocked(readFileSync).mockRestore();
  vi.mocked(rmSync).mockRestore();
  vi.mocked(writeFileSync).mockRestore();
  vi.mocked(isMdnsSupported).mockReturnValue({ supported: true });
  vi.mocked(discoverState).mockReset();
  vi.mocked(discoverState).mockImplementation(actualCliUtils.discoverState);
  vi.mocked(isProxyRunning).mockReset();
  vi.mocked(isProxyRunning).mockImplementation(actualCliUtils.isProxyRunning);
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
    });

    expect(spec.platform).toBe("linux");
    if (spec.platform !== "linux") throw new Error("Expected Linux service spec");
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
    expect(spec.unit).toContain(
      'ExecStart="/usr/bin/node" "/usr/lib/node_modules/portless/dist/cli.js" "proxy" "start" "--foreground" "--port" "443" "--https" "--skip-trust"'
    );
    expect(spec.unit).toContain("WantedBy=multi-user.target");
  });

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
    expect(spec.createArgs).toContain("/SC");
    expect(spec.createArgs).toContain("ONSTART");
    expect(spec.createArgs).toContain("/RU");
    expect(spec.createArgs).toContain("SYSTEM");
    expect(spec.scriptPath).toBe("C:\\ProgramData\\portless\\service\\portless-service.cmd");
    expect(spec.taskRun).toBe('"C:\\ProgramData\\portless\\service\\portless-service.cmd"');
    expect(spec.script).toContain("PORTLESS_STATE_DIR=C:\\Users\\Alice\\.portless");
    expect(spec.script).toContain('"C:\\Program Files\\nodejs\\node.exe"');
    expect(spec.script).toContain("proxy");
    expect(spec.script).toContain("--port");
    expect(spec.script).toContain("443");
    expect(spec.script).toContain("--https");
    expect(spec.script).toContain("--skip-trust");
  });

  it("preserves PATH in the Windows startup script", () => {
    const spec = buildServiceSpec({
      platform: "win32",
      nodePath: "C:\\nodejs\\node.exe",
      entryScript: "C:\\cli.js",
      userHome: "C:\\Users\\Alice",
      pathEnv: "C:\\Program Files\\Git\\mingw64\\bin;C:\\Tools\\100%Done",
    });

    if (spec.platform !== "win32") throw new Error("Expected Windows service spec");
    expect(spec.script).toContain(
      'set "PATH=C:\\Program Files\\Git\\mingw64\\bin;C:\\Tools\\100%%Done"'
    );
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
    vi.mocked(existsSync).mockReturnValue(true);
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
    vi.mocked(existsSync).mockReturnValue(true);
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

  it("prints help and exits 0 for --help", async () => {
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    await expect(
      handleService(["service", "--help"], { entryScript: "/fake/cli.js", runner })
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(0);
    const output = logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(output).toContain("portless service");
    expect(output).toContain("service install");
    expect(output).toContain("service uninstall");
    expect(output).toContain("service status");
  });

  it("prints help and exits 0 when no subcommand is given", async () => {
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    await expect(
      handleService(["service"], { entryScript: "/fake/cli.js", runner })
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("exits 1 for unknown subcommand", async () => {
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    await expect(
      handleService(["service", "bogus"], { entryScript: "/fake/cli.js", runner })
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = errorSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(output).toContain("bogus");
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
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(runner).not.toHaveBeenCalled();
    expect(mkdirSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
    const output = errorSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(output).toContain("LAN mode requires mDNS publishing");
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

    expect(mkdirSync).toHaveBeenCalledWith(stateDir, { recursive: true });
    expect(unit).toContain(`Environment=PORTLESS_STATE_DIR="${systemdStateDir}"`);
    expect(unit).toContain(`"--cert" "${systemdCertPath}" "--key" "${systemdKeyPath}"`);
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
    expect(output).toContain("TLD: local");
    expect(output).toContain("LAN mode: yes");
    expect(output).toContain("LAN IP: 192.168.1.42");
    expect(output).toContain("Wildcard: yes");
    expect(output).toContain("State directory: /srv/portless");
  });
});
