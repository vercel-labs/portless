import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as childProcess from "node:child_process";
import { ensureCerts, isCATrusted, trustCA, untrustCA } from "./certs.js";
import type * as windowsCA from "./windows-ca.js";

vi.mock("./windows-ca.js", async (importOriginal) => ({
  ...(await importOriginal<typeof windowsCA>()),
  isWSL: () => false,
}));

// Keep system trust and NSS operations isolated from the developer's machine.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
}));

describe.skipIf(process.platform !== "linux")("Linux browser CA trust", () => {
  let home: string;
  let stateDir: string;
  let ca: string;
  let systemCA: string | undefined;
  let databases: Map<string, Map<string, { pem: string; trust: string }>>;
  let certutilError: Error | undefined;
  let nssUsers: (string | undefined)[];
  const systemPath = "/usr/local/share/ca-certificates/portless-ca.crt";

  function createDB(relativePath = ".local/share/pki/nssdb") {
    const db = path.join(home, relativePath);
    fs.mkdirSync(db, { recursive: true });
    databases.set(db, new Map());
    return databases.get(db)!;
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "portless-nss-test-"));
    stateDir = path.join(home, ".portless");
    fs.mkdirSync(stateDir);
    ensureCerts(stateDir);
    ca = fs.readFileSync(path.join(stateDir, "ca.pem"), "utf-8");
    systemCA = ca;
    databases = new Map();
    nssUsers = [];
    certutilError = undefined;
    vi.stubEnv("HOME", home);
    vi.stubEnv("SUDO_USER", "");

    const readFile = fs.readFileSync;
    const access = fs.accessSync;
    const copy = fs.copyFileSync;
    const unlink = fs.unlinkSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      if (file === "/etc/os-release") return "ID=ubuntu\n";
      if (file === systemPath && systemCA !== undefined) return systemCA;
      return readFile(file, options);
    });
    vi.spyOn(fs, "accessSync").mockImplementation((file, mode) => {
      if (file === systemPath) {
        if (systemCA === undefined) throw new Error("not installed");
        return;
      }
      access(file, mode);
    });
    vi.spyOn(fs, "copyFileSync").mockImplementation((src, dest, mode) => {
      if (dest === systemPath) systemCA = readFile(src, "utf-8");
      else copy(src, dest, mode);
    });
    vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
      if (file === systemPath) systemCA = undefined;
      else unlink(file);
    });
    const exec = childProcess.execFileSync;
    vi.spyOn(childProcess, "execFileSync").mockImplementation((command, args, options) => {
      let user: string | undefined;
      if (command === "sudo") {
        user = args![1];
        command = "certutil";
        args = args!.slice(args!.indexOf("certutil") + 1);
      }
      if (command === "update-ca-certificates") return "";
      if (command !== "certutil") return exec(command, args, options);
      nssUsers.push(user);
      if (certutilError) throw certutilError;
      const dbPath = args![args!.indexOf("-d") + 1].replace(/^sql:/, "");
      const db = databases.get(dbPath);
      if (!db) throw new Error("NSS database unavailable");
      const nickname = args!.includes("-n") ? args![args!.indexOf("-n") + 1] : undefined;
      if (args!.includes("-A")) {
        db.set(nickname!, { pem: String(options!.input), trust: args![args!.indexOf("-t") + 1] });
        return "";
      }
      if (args!.includes("-D")) {
        if (!db.delete(nickname!)) throw new Error("certificate not found");
        return "";
      }
      if (nickname) {
        const cert = db.get(nickname);
        if (!cert) throw new Error("certificate not found");
        return cert.pem;
      }
      return [...db].map(([name, cert]) => `${name}    ${cert.trust}`).join("\n");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("does not treat system trust or an old marker as browser trust", () => {
    createDB();
    fs.writeFileSync(
      path.join(stateDir, "ca.trusted"),
      crypto.createHash("sha256").update(ca).digest("hex")
    );
    expect(isCATrusted(stateDir)).toBe(false);
  });

  it("trusts the active browser DB and notices SSL trust removal despite its marker", () => {
    const db = createDB();
    expect(trustCA(stateDir)).toEqual({ trusted: true });
    expect([...db.values()]).toEqual([{ pem: ca, trust: "C,," }]);
    expect(isCATrusted(stateDir)).toBe(true);
    [...db.values()][0].trust = ",,";
    expect(isCATrusted(stateDir)).toBe(false);
    expect(untrustCA(stateDir)).toEqual({ removed: true });
    expect([...db.keys()]).toEqual([]);
  });

  it("prefers the existing legacy DB over the new default", () => {
    const modern = createDB();
    const legacy = createDB(".pki/nssdb");
    expect(trustCA(stateDir)).toEqual({ trusted: true });
    expect([...legacy.values()]).toEqual([{ pem: ca, trust: "C,," }]);
    expect([...modern.values()]).toEqual([]);
  });

  it("runs NSS operations as the invoking user under sudo", () => {
    createDB();
    vi.stubEnv("SUDO_USER", "alice");
    vi.spyOn(process, "getuid").mockReturnValue(0);
    expect(trustCA(stateDir)).toEqual({ trusted: true });
    expect(isCATrusted(stateDir)).toBe(true);
    expect(new Set(nssUsers)).toEqual(new Set(["alice"]));
  });

  it("reports partial success when certutil is missing and completes trust on retry", () => {
    createDB();
    certutilError = Object.assign(new Error("spawnSync certutil ENOENT"), { code: "ENOENT" });
    const result = trustCA(stateDir);
    expect(result.trusted).toBe(true);
    expect(result.warning).toContain("libnss3-tools");
    expect(result.error).toBeUndefined();
    expect(isCATrusted(stateDir)).toBe(false);
    certutilError = undefined;
    expect(trustCA(stateDir)).toEqual({ trusted: true });
    expect(isCATrusted(stateDir)).toBe(true);
  });

  it("still fails when the system trust update fails", () => {
    createDB();
    vi.mocked(childProcess.execFileSync).mockImplementationOnce(() => {
      throw new Error("EACCES: permission denied");
    });
    const result = trustCA(stateDir);
    expect(result.trusted).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.warning).toBeUndefined();
    expect(nssUsers).toEqual([]);
  });

  it("preserves system-only support when no browser DB exists", () => {
    expect(trustCA(stateDir)).toEqual({ trusted: true });
    expect(isCATrusted(stateDir)).toBe(true);
    expect(nssUsers).toEqual([]);
    createDB();
    expect(isCATrusted(stateDir)).toBe(false);
  });

  it("removes its NSS root without removing unrelated certificates", () => {
    const db = createDB();
    db.set("another CA", { pem: "unrelated", trust: "C,," });
    expect(trustCA(stateDir)).toEqual({ trusted: true });
    expect(untrustCA(stateDir)).toEqual({ removed: true });
    expect([...db.keys()]).toEqual(["another CA"]);
    expect(isCATrusted(stateDir)).toBe(false);
  });

  it("keeps cleanup retryable when the NSS database cannot be accessed", () => {
    const db = createDB();
    expect(trustCA(stateDir)).toEqual({ trusted: true });
    certutilError = new Error("NSS database unavailable");
    expect(untrustCA(stateDir).removed).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "ca.pem"))).toBe(true);
    certutilError = undefined;
    expect(untrustCA(stateDir)).toEqual({ removed: true });
    expect([...db.keys()]).toEqual([]);
  });
});
