import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServiceSpec, handleService, tryUninstallService } from "./service.js";

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
});

describe("tryUninstallService", () => {
  it("returns removed: false when service is not installed (darwin)", () => {
    const runner = () => ({ status: 0, stdout: "", stderr: "" });
    const result = tryUninstallService("/fake/cli.js", runner);
    expect(result.removed).toBe(false);
  });

  it("returns removed: false when runner throws", () => {
    const runner = () => {
      throw new Error("spawn failed");
    };
    const result = tryUninstallService("/fake/cli.js", runner);
    expect(result.removed).toBe(false);
    expect(result.error).toContain("spawn failed");
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
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
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
    const output = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("bogus");
  });
});
