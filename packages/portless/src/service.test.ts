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
    lstatSync: vi.fn(mod.lstatSync),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(mod.readFileSync),
    readlinkSync: vi.fn(mod.readlinkSync),
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
  isCATrusted: vi.fn(() => true),
  trustCA: vi.fn(() => ({ trusted: true })),
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

const {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} = await import("node:fs");
const { isMdnsSupported } = await import("./mdns.js");
const { ensureCerts } = await import("./certs.js");
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

type MockRootControlledPath = {
  kind: "dir" | "file" | "symlink";
  uid?: number;
  mode?: number;
  target?: string;
  realpath?: string;
};

const trustedUnixPaths: Record<string, MockRootControlledPath> = {
  "/": { kind: "dir", uid: 0, mode: 0o40755 },
  "/usr": { kind: "dir", uid: 0, mode: 0o40755 },
  "/usr/local": { kind: "dir", uid: 0, mode: 0o40755 },
  "/usr/local/bin": { kind: "dir", uid: 0, mode: 0o40755 },
  "/usr/local/bin/node": { kind: "file", uid: 0, mode: 0o100755 },
  "/usr/bin": { kind: "dir", uid: 0, mode: 0o40755 },
  "/usr/bin/node": { kind: "file", uid: 0, mode: 0o100755 },
  "/bin": { kind: "dir", uid: 0, mode: 0o40755 },
  "/bin/node": { kind: "file", uid: 0, mode: 0o100755 },
};

function mockRootControlledPaths(
  entries: Record<string, MockRootControlledPath>,
  nodeExists: string[] = []
): void {
  const normalizedEntries = new Map(
    Object.entries(entries).map(
      ([entryPath, entry]) => [path.posix.resolve(entryPath), entry] as const
    )
  );
  const nodeLookup = new Set(nodeExists.map((entry) => path.posix.resolve(entry)));

  const makeStat = (entry: MockRootControlledPath) =>
    ({
      uid: entry.uid ?? 0,
      mode:
        entry.mode ??
        (entry.kind === "dir" ? 0o40755 : entry.kind === "file" ? 0o100755 : 0o120777),
      isDirectory: () => entry.kind === "dir",
      isFile: () => entry.kind === "file",
      isSymbolicLink: () => entry.kind === "symlink",
    }) as never;

  vi.mocked(lstatSync).mockImplementation((file, options) => {
    const resolved = path.posix.resolve(String(file));
    if (resolved === "/") {
      return makeStat(normalizedEntries.get("/") ?? { kind: "dir", uid: 0, mode: 0o40755 });
    }
    const entry = normalizedEntries.get(resolved);
    if (entry === undefined) {
      if (options && typeof options === "object" && options.throwIfNoEntry === false) {
        return undefined as never;
      }
      const err = new Error(`ENOENT: ${file}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return makeStat(entry);
  });

  vi.mocked(readlinkSync).mockImplementation((file) => {
    const entry = normalizedEntries.get(path.posix.resolve(String(file)));
    if (entry === undefined || entry.kind !== "symlink" || entry.target === undefined) {
      throw new Error(`EINVAL: ${file}`);
    }
    return entry.target;
  });

  vi.mocked(realpathSync).mockImplementation((file) => {
    const resolved = path.posix.resolve(String(file));
    if (nodeLookup.has(resolved)) {
      return resolved;
    }
    const entry = normalizedEntries.get(resolved);
    if (entry === undefined) {
      throw new Error(`ENOENT: ${file}`);
    }
    if (entry.kind === "symlink") {
      return (
        entry.realpath ?? path.posix.resolve(path.posix.dirname(resolved), entry.target ?? ".")
      );
    }
    return entry.realpath ?? resolved;
  });

  vi.mocked(existsSync).mockImplementation((file) =>
    nodeLookup.has(path.posix.resolve(String(file)))
  );
}

function mockTrustedUnixPaths(
  entries: Record<string, MockRootControlledPath> = {},
  nodeExists: string[] = []
): void {
  mockRootControlledPaths(
    {
      ...trustedUnixPaths,
      ...entries,
    },
    nodeExists
  );
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
  vi.mocked(lstatSync).mockRestore();
  vi.mocked(mkdirSync).mockRestore();
  vi.mocked(ensureStateDir).mockClear();
  vi.mocked(ensureCerts).mockClear();
  vi.mocked(readFileSync).mockRestore();
  vi.mocked(readlinkSync).mockRestore();
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
    mockTrustedUnixPaths();

    const spec = buildServiceSpec({
      platform: "darwin",
      nodePath: "/usr/local/bin/node",
      entryScript: "/usr/local/lib/node_modules/portless/dist/cli.js",
      userHome: "/Users/alice",
      uid: "501",
      gid: "20",
      pathEnv: "/usr/local/bin:/usr/bin:/bin",
    });

    expect(spec.platform).toBe("darwin");
    if (spec.platform !== "darwin") throw new Error("Expected macOS service spec");
    expect(spec.plistPath).toBe("/Library/LaunchDaemons/sh.portless.proxy.plist");
    expect(spec.programArguments).toEqual([
      "/usr/bin/env",
      "node",
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
    expect(spec.plist).toContain("<key>PATH</key>");
    expect(spec.plist).toContain("<key>PORTLESS_STATE_DIR</key>");
    expect(spec.plist).toContain("<string>/Users/alice/.portless</string>");
    expect(spec.plist).toContain("<key>SUDO_UID</key>");
    expect(spec.plist).toContain("<string>501</string>");
  });

  it("builds a Linux systemd unit for the HTTPS proxy", () => {
    mockTrustedUnixPaths(
      {
        "/opt": { kind: "dir", uid: 0, mode: 0o40755 },
        "/opt/node": { kind: "dir", uid: 0, mode: 0o40755 },
        "/opt/node/bin": { kind: "dir", uid: 0, mode: 0o40755 },
        "/opt/node/bin/node": { kind: "file", uid: 0, mode: 0o100755 },
      },
      ["/usr/local/bin/node"]
    );

    const spec = buildServiceSpec({
      platform: "linux",
      nodePath: "/opt/node/bin/node",
      entryScript: "/usr/lib/node_modules/portless/dist/cli.js",
      userHome: "/home/alice",
      uid: "1000",
      gid: "1000",
      pathEnv: "/usr/local/bin:/bin",
    });

    expect(spec.platform).toBe("linux");
    if (spec.platform !== "linux") throw new Error("Expected Linux service spec");
    expect(spec.scope).toBe("system");
    expect(spec.unitPath).toBe("/etc/systemd/system/portless.service");
    expect(spec.execStart).toEqual([
      "/usr/bin/env",
      "node",
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
    expect(spec.unit).toContain('Environment=PATH="/opt/node/bin:/usr/local/bin:/bin"');
    expect(spec.unit).toContain(
      'ExecStart="/usr/bin/env" "node" "/usr/lib/node_modules/portless/dist/cli.js" "proxy" "start" "--foreground" "--port" "443" "--https" "--skip-trust"'
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
  });

  it("treats dot-prefixed names under the home directory as contained", () => {
    const spec = buildServiceSpec({
      platform: "linux",
      nodePath: "/home/alice/..runtime/bin/node",
      entryScript: "/fake/cli.js",
      userHome: "/home/alice",
      uid: "1000",
    });

    if (spec.platform !== "linux") throw new Error("Expected Linux service spec");
    expect(spec.scope).toBe("user");
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
    { nodePath: "/home/alice2/bin/node", userHome: "/home/alice", uid: "1000" },
    { nodePath: "/home/alice/bin/node", userHome: "/home/alice", uid: "0" },
    { nodePath: "/home/alice/bin/node", userHome: "/home/alice", username: "root" },
    { nodePath: "/root/bin/node", userHome: "/root", uid: "1000" },
  ])("uses a system unit for a sibling or root context: %o", (context) => {
    mockTrustedUnixPaths();

    const spec = buildServiceSpec({
      platform: "linux",
      entryScript: "/usr/lib/portless/cli.js",
      pathEnv: "/usr/local/bin:/bin",
      ...context,
    });

    if (spec.platform !== "linux") throw new Error("Expected Linux service spec");
    expect(spec.scope).toBe("system");
    expect(spec.unitPath).toBe("/etc/systemd/system/portless.service");
    expect(spec.unit).toContain("WantedBy=multi-user.target");
    const unitSection = spec.unit.split("[Service]")[0];
    expect(unitSection).toContain("StartLimitIntervalSec=60");
    expect(unitSection).toContain("StartLimitBurst=5");
  });

  it("builds a Windows startup task for the HTTPS proxy", () => {
    const spec = buildServiceSpec({
      platform: "win32",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      entryScript: "C:\\Users\\Alice\\AppData\\Roaming\\npm\\node_modules\\portless\\dist\\cli.js",
      userHome: "C:\\Users\\Alice",
      pathEnv: "C:\\Program Files\\Git\\mingw64\\bin;C:\\Program Files\\nodejs;C:\\Tools\\100%Done",
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
    expect(spec.script).toContain(
      'set "PATH=C:\\Program Files\\Git\\mingw64\\bin;C:\\Program Files\\nodejs"'
    );
    expect(spec.script).not.toContain("C:\\Tools\\100%%Done");
    expect(spec.script).toContain(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Alice\\AppData\\Roaming\\npm\\node_modules\\portless\\dist\\cli.js" "proxy" "start"'
    );
    expect(spec.script).toContain("proxy");
    expect(spec.script).toContain("--port");
    expect(spec.script).toContain("443");
    expect(spec.script).toContain("--https");
    expect(spec.script).toContain("--skip-trust");
  });

  it("restricts PATH in the Windows startup script to trusted system directories", () => {
    const spec = buildServiceSpec({
      platform: "win32",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      entryScript: "C:\\cli.js",
      userHome: "C:\\Users\\Alice",
      pathEnv:
        "C:\\Windows\\System32;C:\\Windows\\Temp;C:\\Users\\Alice\\bin;C:\\Program Files\\Git\\mingw64\\bin;C:\\Program Files\\100%Tools;C:\\Tools\\100%Done;C:\\Program Files\\..\\Users\\Alice",
    });

    if (spec.platform !== "win32") throw new Error("Expected Windows service spec");
    expect(spec.script).toContain(
      'set "PATH=C:\\Windows\\System32;C:\\Program Files\\Git\\mingw64\\bin;C:\\Program Files\\100%%Tools"'
    );
    expect(spec.script).not.toContain("C:\\Windows\\Temp");
    expect(spec.script).not.toContain("C:\\Users\\Alice\\bin");
    expect(spec.script).not.toContain("C:\\Tools");
  });

  it("appends the install-time Node directory after existing macOS PATH entries", () => {
    mockTrustedUnixPaths({
      "/opt": { kind: "dir", uid: 0, mode: 0o40755 },
      "/opt/homebrew": { kind: "dir", uid: 0, mode: 0o40755 },
      "/opt/homebrew/Cellar": { kind: "dir", uid: 0, mode: 0o40755 },
      "/opt/homebrew/Cellar/node": { kind: "dir", uid: 0, mode: 0o40755 },
      "/opt/homebrew/Cellar/node/22.1.0": { kind: "dir", uid: 0, mode: 0o40755 },
      "/opt/homebrew/Cellar/node/22.1.0/bin": { kind: "dir", uid: 0, mode: 0o40755 },
      "/opt/homebrew/Cellar/node/22.1.0/bin/node": { kind: "file", uid: 0, mode: 0o100755 },
    });

    const spec = buildServiceSpec({
      platform: "darwin",
      nodePath: "/opt/homebrew/Cellar/node/22.1.0/bin/node",
      entryScript: "/usr/local/lib/portless/cli.js",
      userHome: "/Users/alice",
      pathEnv: "/Users/alice/.local/share/mise/shims:/usr/bin:/usr/bin/::/bin",
    });

    if (spec.platform !== "darwin") throw new Error("Expected macOS service spec");
    expect(spec.plist).toContain(
      "<key>PATH</key>\n    <string>/usr/bin:/bin:/opt/homebrew/Cellar/node/22.1.0/bin</string>"
    );
  });

  it.each(["darwin", "linux"] as const)(
    "rejects dot dot segments in privileged Unix PATH entries for a %s root service",
    (platform) => {
      mockTrustedUnixPaths({
        "/usr/opt": { kind: "dir", uid: 0, mode: 0o40755 },
        "/usr/opt/bin": { kind: "dir", uid: 0, mode: 0o40755 },
      });
      const spec = buildServiceSpec({
        platform,
        nodePath: "/usr/bin/node",
        entryScript: "/fake/cli.js",
        userHome: "/home/alice",
        pathEnv: "/usr/local/../opt/bin",
      });

      if (spec.platform === "win32") throw new Error("Expected Unix service spec");
      const serviceFile = spec.platform === "darwin" ? spec.plist : spec.unit;
      expect(serviceFile).not.toContain("/usr/local/../opt/bin");
      expect(serviceFile).not.toContain("/usr/opt/bin");
    }
  );

  it.each([
    ["a writable root", { "/": { kind: "dir" as const, uid: 0, mode: 0o40777 } }],
    ["a non-root ancestor", { "/usr": { kind: "dir" as const, uid: 1000, mode: 0o40755 } }],
  ])(
    "falls back to the absolute node path when %s is untrusted",
    (_label: string, overrides: Record<string, MockRootControlledPath>) => {
      mockTrustedUnixPaths(overrides);

      const spec = buildServiceSpec({
        platform: "darwin",
        nodePath: "/usr/local/bin/node",
        entryScript: "/usr/local/lib/portless/cli.js",
        userHome: "/Users/alice",
        pathEnv: "/usr/local/bin:/usr/bin:/bin",
      });

      if (spec.platform !== "darwin") throw new Error("Expected macOS service spec");
      expect(spec.programArguments).toEqual([
        "/usr/local/bin/node",
        "/usr/local/lib/portless/cli.js",
        "proxy",
        "start",
        "--foreground",
        "--port",
        "443",
        "--https",
        "--skip-trust",
      ]);
    }
  );

  it("falls back to the absolute node path when a trusted symlink resolves through an untrusted ancestor", () => {
    mockTrustedUnixPaths({
      "/usr/local/bin/node": { kind: "symlink", uid: 0, target: "/tmp/root/node" },
      "/tmp": { kind: "dir", uid: 1000, mode: 0o40755 },
      "/tmp/root": { kind: "dir", uid: 0, mode: 0o40755 },
      "/tmp/root/node": { kind: "file", uid: 0, mode: 0o100755 },
    });

    const spec = buildServiceSpec({
      platform: "darwin",
      nodePath: "/usr/local/bin/node",
      entryScript: "/usr/local/lib/portless/cli.js",
      userHome: "/Users/alice",
      pathEnv: "/usr/local/bin:/usr/bin:/bin",
    });

    if (spec.platform !== "darwin") throw new Error("Expected macOS service spec");
    expect(spec.programArguments.slice(0, 2)).toEqual([
      "/usr/local/bin/node",
      "/usr/local/lib/portless/cli.js",
    ]);
  });

  it("falls back to the absolute node path when a symlink loops", () => {
    mockTrustedUnixPaths({
      "/usr/local/bin/node": { kind: "symlink", uid: 0, target: "/usr/local/bin/node" },
    });

    const spec = buildServiceSpec({
      platform: "darwin",
      nodePath: "/usr/local/bin/node",
      entryScript: "/usr/local/lib/portless/cli.js",
      userHome: "/Users/alice",
      pathEnv: "/usr/local/bin:/usr/bin:/bin",
    });

    if (spec.platform !== "darwin") throw new Error("Expected macOS service spec");
    expect(spec.programArguments.slice(0, 2)).toEqual([
      "/usr/local/bin/node",
      "/usr/local/lib/portless/cli.js",
    ]);
  });

  it("drops a root-owned PATH directory whose node entry is not root-owned", () => {
    mockTrustedUnixPaths({
      "/usr/local/bin/node": { kind: "file", uid: 501, mode: 0o100755 },
      "/usr/bin/node": { kind: "file", uid: 0, mode: 0o100755 },
    });

    const spec = buildServiceSpec({
      platform: "darwin",
      nodePath: "/usr/bin/node",
      entryScript: "/usr/local/lib/portless/cli.js",
      userHome: "/Users/alice",
      pathEnv: "/usr/local/bin:/usr/bin:/bin",
    });

    if (spec.platform !== "darwin") throw new Error("Expected macOS service spec");
    expect(spec.programArguments.slice(0, 2)).toEqual(["/usr/bin/env", "node"]);
    expect(spec.plist).toContain("<key>PATH</key>\n    <string>/usr/bin:/bin</string>");
    expect(spec.plist).not.toContain("/usr/local/bin:");
  });

  it("traverses a root-owned relative symlink with dot dot one segment at a time", () => {
    mockTrustedUnixPaths({
      "/usr/bin/node": { kind: "symlink", uid: 0, target: "../lib/node/bin/node" },
      "/usr/lib": { kind: "dir", uid: 0, mode: 0o40755 },
      "/usr/lib/node": { kind: "dir", uid: 0, mode: 0o40755 },
      "/usr/lib/node/bin": { kind: "dir", uid: 0, mode: 0o40755 },
      "/usr/lib/node/bin/node": { kind: "file", uid: 0, mode: 0o100755 },
    });

    const trusted = buildServiceSpec({
      platform: "darwin",
      nodePath: "/usr/bin/node",
      entryScript: "/usr/local/lib/portless/cli.js",
      userHome: "/Users/alice",
      pathEnv: "/usr/bin:/bin",
    });

    if (trusted.platform !== "darwin") throw new Error("Expected macOS service spec");
    expect(trusted.programArguments.slice(0, 2)).toEqual(["/usr/bin/env", "node"]);

    mockTrustedUnixPaths({
      "/usr/bin/node": { kind: "symlink", uid: 0, target: "../lib/node/bin/node" },
      "/usr/lib": { kind: "dir", uid: 1000, mode: 0o40755 },
      "/usr/lib/node": { kind: "dir", uid: 0, mode: 0o40755 },
      "/usr/lib/node/bin": { kind: "dir", uid: 0, mode: 0o40755 },
      "/usr/lib/node/bin/node": { kind: "file", uid: 0, mode: 0o100755 },
    });

    const untrusted = buildServiceSpec({
      platform: "darwin",
      nodePath: "/usr/bin/node",
      entryScript: "/usr/local/lib/portless/cli.js",
      userHome: "/Users/alice",
      pathEnv: "/usr/bin:/bin",
    });

    if (untrusted.platform !== "darwin") throw new Error("Expected macOS service spec");
    expect(untrusted.programArguments.slice(0, 2)).toEqual([
      "/usr/bin/node",
      "/usr/local/lib/portless/cli.js",
    ]);
  });

  it("prepends the install-time Node directory when an earlier PATH Node differs", () => {
    mockTrustedUnixPaths(
      {
        "/opt": { kind: "dir", uid: 0, mode: 0o40755 },
        "/opt/node": { kind: "dir", uid: 0, mode: 0o40755 },
        "/opt/node/bin": { kind: "dir", uid: 0, mode: 0o40755 },
        "/opt/node/bin/node": { kind: "file", uid: 0, mode: 0o100755 },
      },
      ["/usr/bin/node"]
    );

    const spec = buildServiceSpec({
      platform: "linux",
      nodePath: "/opt/node/bin/node",
      entryScript: "/usr/lib/portless/cli.js",
      userHome: "/home/alice",
      uid: "1000",
      gid: "1000",
      pathEnv: "/usr/bin:/bin",
    });

    if (spec.platform !== "linux") throw new Error("Expected Linux service spec");
    expect(spec.execStart.slice(0, 2)).toEqual(["/usr/bin/env", "node"]);
    expect(spec.unit).toContain('Environment=PATH="/opt/node/bin:/usr/bin:/bin"');
  });

  it("keeps world-writable PATH entries for a Linux user service", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const spec = buildServiceSpec({
      platform: "linux",
      nodePath: "/home/alice/bin/node",
      entryScript: "/fake/cli.js",
      userHome: "/home/alice",
      pathEnv: ".:/tmp:/usr/bin",
    });

    if (spec.platform !== "linux") throw new Error("Expected Linux service spec");
    expect(spec.unit).toContain('Environment=PATH="/tmp:/usr/bin:/home/alice/bin"');
  });

  it("deduplicates an existing install-time Node directory in Linux PATH", () => {
    const spec = buildServiceSpec({
      platform: "linux",
      nodePath: "/home/alice/.nvm/versions/node/v22/bin/node",
      entryScript: "/usr/lib/portless/cli.js",
      userHome: "/home/alice",
      pathEnv:
        "/home/alice/.nvm/versions/node/v22/bin/:/usr/bin:/home/alice/.nvm/versions/node/v22/bin::/usr/bin/",
    });

    if (spec.platform !== "linux") throw new Error("Expected Linux service spec");
    expect(spec.scope).toBe("user");
    expect(spec.unit).toContain(
      'Environment=PATH="/home/alice/.nvm/versions/node/v22/bin/:/usr/bin"'
    );
    expect(spec.unit.match(/^Environment=PATH=/gm)).toHaveLength(1);
  });

  it("escapes percent signs in Windows batch env values", () => {
    const spec = buildServiceSpec({
      platform: "win32",
      nodePath: "C:\\nodejs\\node.exe",
      entryScript: "C:\\cli.js",
      userHome: "C:\\Users\\100%Done",
      pathEnv: "C:\\Program Files\\Git\\mingw64\\bin;C:\\Program Files\\100%Done",
    });

    if (spec.platform !== "win32") throw new Error("Expected Windows service spec");
    expect(spec.script).toContain("PORTLESS_STATE_DIR=C:\\Users\\100%%Done\\.portless");
    expect(spec.script).toContain(
      'set "PATH=C:\\Program Files\\Git\\mingw64\\bin;C:\\Program Files\\100%%Done"'
    );
    expect(spec.script).not.toMatch(/(?<!%)%(?!%)/);
  });

  it("uses unconditional KeepAlive in the macOS plist", () => {
    mockTrustedUnixPaths();

    const spec = buildServiceSpec({
      platform: "darwin",
      nodePath: "/usr/local/bin/node",
      entryScript: "/usr/local/lib/portless/cli.js",
      userHome: "/Users/bob",
      uid: "501",
      gid: "20",
      pathEnv: "/usr/local/bin:/usr/bin:/bin",
    });

    if (spec.platform !== "darwin") throw new Error("Expected macOS service spec");
    expect(spec.plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(spec.plist).not.toContain("SuccessfulExit");
  });

  it("persists LAN and wildcard settings in a macOS LaunchDaemon", () => {
    mockTrustedUnixPaths();

    const spec = buildServiceSpec({
      platform: "darwin",
      nodePath: "/usr/local/bin/node",
      entryScript: "/usr/local/lib/portless/cli.js",
      userHome: "/Users/alice",
      uid: "501",
      gid: "20",
      pathEnv: "/usr/local/bin:/usr/bin:/bin",
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

  it("finds and removes a user unit when Node is installed system-wide", () => {
    const home = setLinuxUser();
    const restoreExecPath = setExecPath("/usr/bin/node");
    const userUnit = path.posix.join(home, ".config/systemd/user/portless.service");
    vi.mocked(existsSync).mockImplementation((file) => file === userUnit);
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    try {
      expect(tryUninstallService("/fake/cli.js", runner)).toEqual({
        removed: true,
        installed: true,
      });
      expect(runner).toHaveBeenCalledWith("systemctl", [
        "--user",
        "disable",
        "--now",
        "portless.service",
      ]);
      expect(runner).toHaveBeenCalledWith("systemctl", ["--user", "daemon-reload"]);
      expect(rmSync).toHaveBeenCalledWith(userUnit, { force: true });
    } finally {
      restoreExecPath();
      vi.unstubAllEnvs();
    }
  });

  it("finds a system unit when Node has moved under the user's home", () => {
    const home = setLinuxUser();
    const restoreExecPath = setExecPath(path.posix.join(home, ".nvm/bin/node"));
    vi.mocked(existsSync).mockImplementation(
      (file) => file === "/etc/systemd/system/portless.service"
    );
    const runner = vi.fn(() => ({ status: 1, stdout: "", stderr: "Access denied" }));

    try {
      expect(tryUninstallService("/fake/cli.js", runner)).toEqual({
        removed: false,
        installed: true,
        error: "Access denied",
        needsElevation: true,
      });
      expect(runner).toHaveBeenCalledWith("systemctl", ["disable", "--now", "portless.service"]);
    } finally {
      restoreExecPath();
      vi.unstubAllEnvs();
    }
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
    }
  });

  it("refuses to remove a user unit as root", () => {
    const home = setLinuxUser();
    setGetuid(0);
    const restoreExecPath = setExecPath("/usr/bin/node");
    const userUnit = path.posix.join(home, ".config/systemd/user/portless.service");
    vi.mocked(existsSync).mockImplementation((file) => file === userUnit);
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    try {
      expect(tryUninstallService("/fake/cli.js", runner)).toEqual({
        removed: false,
        installed: true,
        error:
          "The installed service is a systemd user service. Re-run `portless service uninstall` without sudo.",
        needsElevation: false,
      });
      expect(runner).not.toHaveBeenCalled();
      expect(rmSync).not.toHaveBeenCalled();
    } finally {
      restoreExecPath();
    }
  });

  it("removes the system unit first for sudo uninstall when both scopes exist", () => {
    const home = setLinuxUser();
    setGetuid(0);
    const restoreExecPath = setExecPath(path.posix.join(home, ".nvm/bin/node"));
    const userUnit = path.posix.join(home, ".config/systemd/user/portless.service");
    const systemUnit = "/etc/systemd/system/portless.service";
    vi.mocked(existsSync).mockImplementation((file) => file === userUnit || file === systemUnit);
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    try {
      expect(tryUninstallService("/fake/cli.js", runner)).toMatchObject({
        removed: false,
        installed: true,
        error: expect.stringContaining("without sudo"),
        needsElevation: false,
      });
      expect(runner.mock.calls).toEqual([
        ["systemctl", ["disable", "--now", "portless.service"]],
        ["systemctl", ["daemon-reload"]],
      ]);
      expect(rmSync).toHaveBeenCalledTimes(1);
      expect(rmSync).toHaveBeenCalledWith(systemUnit, { force: true });
    } finally {
      restoreExecPath();
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
    expect(output).toContain("Linux user services resolve node from PATH at startup");
    expect(output).toContain("Windows SYSTEM tasks always use the explicit Node path");
    expect(output).toContain("systemctl --user");
    expect(output).toContain("SELinux enforcing mode");
    expect(output).toContain("loginctl enable-linger <user>");
    expect(output).toContain("unprivileged port access or --port 1024");
    expect(output).toContain("StartLimitIntervalSec=60, StartLimitBurst=5");
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
      expect(runner).toHaveBeenCalledWith("systemctl", [
        "--user",
        "disable",
        "--now",
        "portless.service",
      ]);
      expect(runner).toHaveBeenCalledWith("systemctl", ["--user", "daemon-reload"]);
      expect(runner).toHaveBeenCalledWith("systemctl", ["--user", "enable", "portless.service"]);
      expect(runner).toHaveBeenCalledWith("systemctl", ["--user", "restart", "portless.service"]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Remove it with \`sudo portless service uninstall\``)
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(systemUnit));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("loginctl enable-linger alice"));
    } finally {
      warnSpy.mockRestore();
      restoreExecPath();
      vi.unstubAllEnvs();
    }
  });

  it("uses XDG_CONFIG_HOME for Linux user install, status, and cleanup", async () => {
    const home = setLinuxUser();
    vi.stubEnv("SUDO_USER", "");
    vi.stubEnv("XDG_CONFIG_HOME", "/home/alice/custom-config");
    const restoreExecPath = setExecPath(path.posix.join(home, ".nvm/bin/node"));
    const userUnit = "/home/alice/custom-config/systemd/user/portless.service";
    vi.mocked(existsSync).mockImplementation((file) => file === userUnit);
    vi.mocked(readFileSync).mockReturnValue("");
    vi.mocked(isProxyRunning).mockResolvedValue(false);
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    try {
      await handleService(["service", "install", "--port", "8443"], {
        entryScript: "/fake/cli.js",
        runner,
      });
      expect(writeFileSync).toHaveBeenCalledWith(
        userUnit,
        expect.stringContaining("WantedBy=default.target")
      );
      await handleService(["service", "status"], { entryScript: "/fake/cli.js", runner });
      expect(logSpy.mock.calls.flat().join(" ")).toContain(`Service entry: ${userUnit}`);
      await handleService(["service", "uninstall"], { entryScript: "/fake/cli.js", runner });
      expect(rmSync).toHaveBeenCalledWith(userUnit, { force: true });
      expect(tryUninstallService("/fake/cli.js", runner)).toEqual({
        removed: true,
        installed: true,
      });
      expect(rmSync).toHaveBeenCalledWith(userUnit, { force: true });
    } finally {
      restoreExecPath();
    }
  });

  it.each([
    { xdgConfigHome: "relative/config", sudoUser: "" },
    { xdgConfigHome: "/root/config", sudoUser: "alice" },
  ])("ignores invalid or elevated XDG_CONFIG_HOME: %o", async ({ xdgConfigHome, sudoUser }) => {
    const home = setLinuxUser();
    vi.stubEnv("SUDO_USER", sudoUser);
    vi.stubEnv("XDG_CONFIG_HOME", xdgConfigHome);
    const restoreExecPath = setExecPath(path.posix.join(home, ".nvm/bin/node"));
    vi.mocked(existsSync).mockReturnValue(false);
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    try {
      await handleService(["service", "install", "--port", "8443"], {
        entryScript: "/fake/cli.js",
        runner,
      });
      expect(writeFileSync).toHaveBeenCalledWith(
        "/home/alice/.config/systemd/user/portless.service",
        expect.any(String)
      );
    } finally {
      restoreExecPath();
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
      expect(ensureStateDir).not.toHaveBeenCalled();
      expect(ensureCerts).not.toHaveBeenCalled();
      expect(writeFileSync).not.toHaveBeenCalled();
    } finally {
      restoreExecPath();
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
      expect(writeFileSync).not.toHaveBeenCalled();
      expect(mkdirSync).not.toHaveBeenCalled();
      expect(ensureStateDir).not.toHaveBeenCalled();
    } finally {
      restoreExecPath();
      vi.unstubAllEnvs();
    }
  });

  it("warns about an existing user unit when installing a system unit", async () => {
    const home = setLinuxUser();
    setGetuid(0);
    const restoreExecPath = setExecPath("/usr/bin/node");
    const userUnit = path.posix.join(home, ".config/systemd/user/portless.service");
    vi.mocked(existsSync).mockImplementation((file) => file === userUnit);
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await handleService(["service", "install", "--port", "8443"], {
        entryScript: "/fake/cli.js",
        runner,
      });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(userUnit));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("`portless service uninstall` (without sudo)")
      );
      expect(runner).toHaveBeenCalledWith("systemctl", ["restart", "portless.service"]);
    } finally {
      warnSpy.mockRestore();
      restoreExecPath();
      vi.unstubAllEnvs();
    }
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

  it("finds a user unit for status when Node is installed system-wide", async () => {
    const home = setLinuxUser();
    const restoreExecPath = setExecPath("/usr/bin/node");
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
    const runner = vi.fn(() => ({ status: 0, stdout: "active\n", stderr: "" }));

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
      expect(output).toContain("HTTPS: no");
      expect(output).toContain(`Service entry: ${installedSpec.unitPath}`);
    } finally {
      restoreExecPath();
      vi.unstubAllEnvs();
    }
  });

  it.each([
    { nodePath: "/usr/bin/node", expectedScope: "system" },
    { nodePath: "/home/alice/.nvm/bin/node", expectedScope: "user" },
  ])(
    "prefers the $expectedScope unit when both Linux units exist",
    async ({ nodePath, expectedScope }) => {
      const home = setLinuxUser();
      const restoreExecPath = setExecPath(nodePath);
      const userUnit = path.posix.join(home, ".config/systemd/user/portless.service");
      const systemUnit = "/etc/systemd/system/portless.service";
      vi.mocked(existsSync).mockImplementation((file) => file === userUnit || file === systemUnit);
      vi.mocked(readFileSync).mockReturnValue("");
      vi.mocked(isProxyRunning).mockResolvedValue(false);
      const runner = vi.fn(() => ({ status: 0, stdout: "active\n", stderr: "" }));

      try {
        await handleService(["service", "status"], { entryScript: "/fake/cli.js", runner });
        const output = logSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
        expect(output).toContain(
          `Service entry: ${expectedScope === "user" ? userUnit : systemUnit}`
        );
        expect(runner).toHaveBeenCalledWith(
          "systemctl",
          expectedScope === "user"
            ? ["--user", "is-active", "portless.service"]
            : ["is-active", "portless.service"]
        );
      } finally {
        restoreExecPath();
        vi.unstubAllEnvs();
      }
    }
  );

  it("uninstalls an existing user unit when Node is installed system-wide", async () => {
    const home = setLinuxUser();
    const restoreExecPath = setExecPath("/usr/bin/node");
    const userUnit = path.posix.join(home, ".config/systemd/user/portless.service");
    vi.mocked(existsSync).mockImplementation((file) => file === userUnit);
    const runner = vi.fn((_: string, _args: string[]) => ({ status: 0, stdout: "", stderr: "" }));

    try {
      await handleService(["service", "uninstall"], { entryScript: "/fake/cli.js", runner });
      expect(runner.mock.calls.some(([command]) => command === "sudo")).toBe(false);
      expect(runner).toHaveBeenCalledWith("systemctl", [
        "--user",
        "disable",
        "--now",
        "portless.service",
      ]);
      expect(runner).toHaveBeenCalledWith("systemctl", ["--user", "daemon-reload"]);
      expect(rmSync).toHaveBeenCalledWith(userUnit, { force: true });
    } finally {
      restoreExecPath();
      vi.unstubAllEnvs();
    }
  });

  it.each([
    { uid: 1000, nodePath: "/home/alice/.nvm/bin/node", remaining: "system" },
    { uid: 0, nodePath: "/usr/bin/node", remaining: "user" },
  ])("warns how to remove the remaining $remaining unit", async ({ uid, nodePath, remaining }) => {
    const home = setLinuxUser();
    setGetuid(uid);
    const restoreExecPath = setExecPath(nodePath);
    const userUnit = path.posix.join(home, ".config/systemd/user/portless.service");
    const systemUnit = "/etc/systemd/system/portless.service";
    vi.mocked(existsSync).mockImplementation((file) => file === userUnit || file === systemUnit);
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await handleService(["service", "uninstall"], { entryScript: "/fake/cli.js", runner });
      const expected =
        remaining === "system"
          ? "`sudo portless service uninstall`"
          : "`portless service uninstall` (without sudo)";
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(expected));
      expect(rmSync).toHaveBeenCalledWith(remaining === "system" ? userUnit : systemUnit, {
        force: true,
      });
    } finally {
      warnSpy.mockRestore();
      restoreExecPath();
    }
  });

  it("removes the system unit and keeps the home Node user unit for a sudo uninstall", async () => {
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
      expect(rmSync).not.toHaveBeenCalledWith(userUnit, { force: true });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(userUnit));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("`portless service uninstall` (without sudo)")
      );
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
    mockTrustedUnixPaths({}, ["/usr/bin/node"]);
    const installedSpec = buildServiceSpec({
      platform: "linux",
      nodePath: "/usr/bin/node",
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
    expect(installedSpec.execStart.slice(0, 3)).toEqual(["/usr/bin/env", "node", "/fake/cli.js"]);

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
