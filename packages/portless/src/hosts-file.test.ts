import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanHostsFile, getManagedHostnames, syncHostsFile } from "./hosts.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const originalHosts = "127.0.0.1 localhost\n::1 localhost\n10.0.0.9 vpn.internal\n";
const managedBlock = "# portless-start\n127.0.0.1 myapp.localhost\n# portless-end\n";
let tempDir: string;
let hostsFile: string;

beforeEach(() => {
  tempDir = actualFs.mkdtempSync(path.join(os.tmpdir(), "portless-hosts-"));
  hostsFile = path.join(tempDir, "hosts");
  actualFs.writeFileSync(hostsFile, originalHosts);

  // Redirect hosts-file I/O to a fixture, including writes on the failing path.
  vi.mocked(fs.readFileSync)
    .mockReset()
    .mockImplementation(() => actualFs.readFileSync(hostsFile, "utf-8"));
  vi.mocked(fs.writeFileSync)
    .mockReset()
    .mockImplementation((_file, content) => {
      actualFs.writeFileSync(hostsFile, content);
    });
});

afterEach(() => {
  actualFs.rmSync(tempDir, { recursive: true, force: true });
});

describe("hosts-file read failures", () => {
  it.each([
    { code: "EIO", hostnames: ["myapp.localhost"] },
    { code: "EACCES", hostnames: ["myapp.localhost"] },
    { code: "EIO", hostnames: [] },
  ])(
    "preserves existing entries when the initial sync read fails with $code for $hostnames",
    ({ code, hostnames }) => {
      vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
        throw Object.assign(new Error("Cannot read hosts file"), { code });
      });

      const synced = syncHostsFile(hostnames);

      expect.soft(actualFs.readFileSync(hostsFile, "utf-8")).toBe(originalHosts);
      expect(synced).toBe(false);
    }
  );

  it("does not replace a missing hosts file with only portless entries", () => {
    actualFs.unlinkSync(hostsFile);

    expect(syncHostsFile(["myapp.localhost"])).toBe(false);
    expect(actualFs.existsSync(hostsFile)).toBe(false);
  });

  it("reports cleanup failure without changing unreadable entries", () => {
    const content = originalHosts + "\n" + managedBlock;
    actualFs.writeFileSync(hostsFile, content);
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw new Error("Cannot read hosts file");
    });

    expect(cleanHostsFile()).toBe(false);
    expect(actualFs.readFileSync(hostsFile, "utf-8")).toBe(content);
  });

  it.each([{ hostnames: ["other.localhost"] }, { hostnames: [] }])(
    "reports failure when the write cannot be verified for $hostnames",
    ({ hostnames }) => {
      actualFs.writeFileSync(hostsFile, originalHosts + "\n" + managedBlock);
      vi.mocked(fs.readFileSync)
        .mockImplementationOnce(() => actualFs.readFileSync(hostsFile, "utf-8"))
        .mockImplementationOnce(() => {
          throw new Error("Cannot verify hosts file");
        });

      expect(syncHostsFile(hostnames)).toBe(false);
      expect(actualFs.readFileSync(hostsFile, "utf-8")).toContain(originalHosts);
    }
  );

  it("keeps hostname discovery nonthrowing when the file cannot be read", () => {
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw new Error("Cannot read hosts file");
    });

    expect(getManagedHostnames()).toEqual([]);
  });
});

describe("readable hosts files", () => {
  it("syncs and cleans managed entries without losing other entries", () => {
    expect(syncHostsFile(["myapp.localhost"])).toBe(true);
    expect(actualFs.readFileSync(hostsFile, "utf-8")).toBe(originalHosts + "\n" + managedBlock);
    expect(getManagedHostnames()).toEqual(["myapp.localhost"]);

    expect(cleanHostsFile()).toBe(true);
    expect(actualFs.readFileSync(hostsFile, "utf-8")).toBe(originalHosts);
  });

  it("allows syncing a successfully read empty file", () => {
    actualFs.writeFileSync(hostsFile, "");

    expect(syncHostsFile(["myapp.localhost"])).toBe(true);
    expect(getManagedHostnames()).toEqual(["myapp.localhost"]);
  });

  it("does not rewrite an already matching block", () => {
    const content = originalHosts + "\n" + managedBlock;
    actualFs.writeFileSync(hostsFile, content);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw new Error("Hosts file is read-only");
    });

    expect(syncHostsFile(["myapp.localhost"])).toBe(true);
    expect(actualFs.readFileSync(hostsFile, "utf-8")).toBe(content);
  });
});
