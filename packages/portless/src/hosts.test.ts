import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:fs")>();
  return {
    ...mod,
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

import {
  checkHostResolution,
  blockMatchesHostnames,
  cleanHostsFile,
  extractManagedBlock,
  getManagedHostnames,
  removeBlock,
  buildBlock,
  shouldAutoSyncHosts,
  syncHostsFile,
} from "./hosts.js";

const { readFileSync, writeFileSync } = await import("node:fs");

beforeEach(() => {
  vi.mocked(readFileSync).mockReset();
  vi.mocked(writeFileSync).mockReset();
});

// ---------------------------------------------------------------------------
// extractManagedBlock
// ---------------------------------------------------------------------------

describe("extractManagedBlock", () => {
  it("returns empty array when no markers exist", () => {
    const content = "127.0.0.1 localhost\n::1 localhost\n";
    expect(extractManagedBlock(content)).toEqual([]);
  });

  it("returns empty array when only start marker exists", () => {
    const content = "# portless-start\n127.0.0.1 myapp.localhost\n";
    expect(extractManagedBlock(content)).toEqual([]);
  });

  it("returns empty array when only end marker exists", () => {
    const content = "127.0.0.1 myapp.localhost\n# portless-end\n";
    expect(extractManagedBlock(content)).toEqual([]);
  });

  it("returns empty array when end marker comes before start marker", () => {
    const content = "# portless-end\n127.0.0.1 myapp.localhost\n# portless-start\n";
    expect(extractManagedBlock(content)).toEqual([]);
  });

  it("extracts lines between markers", () => {
    const content = [
      "127.0.0.1 localhost",
      "# portless-start",
      "127.0.0.1 myapp.localhost",
      "127.0.0.1 api.localhost",
      "# portless-end",
      "",
    ].join("\n");
    expect(extractManagedBlock(content)).toEqual([
      "127.0.0.1 myapp.localhost",
      "127.0.0.1 api.localhost",
    ]);
  });

  it("trims whitespace from extracted lines", () => {
    const content = "# portless-start\n  127.0.0.1 myapp.localhost  \n# portless-end\n";
    expect(extractManagedBlock(content)).toEqual(["127.0.0.1 myapp.localhost"]);
  });

  it("filters out empty lines", () => {
    const content = "# portless-start\n\n127.0.0.1 myapp.localhost\n\n# portless-end\n";
    expect(extractManagedBlock(content)).toEqual(["127.0.0.1 myapp.localhost"]);
  });

  it("returns empty array when block is empty", () => {
    const content = "# portless-start\n# portless-end\n";
    expect(extractManagedBlock(content)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// removeBlock
// ---------------------------------------------------------------------------

describe("removeBlock", () => {
  it("returns content unchanged when no markers exist", () => {
    const content = "127.0.0.1 localhost\n";
    expect(removeBlock(content)).toBe("127.0.0.1 localhost\n");
  });

  it("removes the managed block and normalizes newlines", () => {
    const content = [
      "127.0.0.1 localhost",
      "",
      "# portless-start",
      "127.0.0.1 myapp.localhost",
      "# portless-end",
      "",
    ].join("\n");
    const result = removeBlock(content);
    expect(result).not.toContain("portless-start");
    expect(result).not.toContain("myapp.localhost");
    expect(result).toContain("127.0.0.1 localhost");
    expect(result.endsWith("\n")).toBe(true);
  });

  it("does not leave more than 2 consecutive newlines", () => {
    const content =
      "127.0.0.1 localhost\n\n\n# portless-start\n127.0.0.1 x.localhost\n# portless-end\n\n\nother\n";
    const result = removeBlock(content);
    expect(result).not.toMatch(/\n{3,}/);
  });

  it("preserves content before and after the block", () => {
    const content = "before\n# portless-start\nentry\n# portless-end\nafter\n";
    const result = removeBlock(content);
    expect(result).toContain("before");
    expect(result).toContain("after");
  });
});

// ---------------------------------------------------------------------------
// buildBlock
// ---------------------------------------------------------------------------

describe("buildBlock", () => {
  it("returns empty string for empty hostnames array", () => {
    expect(buildBlock([])).toBe("");
  });

  it("builds a single-entry block with markers", () => {
    const result = buildBlock(["myapp.localhost"]);
    expect(result).toBe("# portless-start\n127.0.0.1 myapp.localhost\n# portless-end");
  });

  it("builds a multi-entry block", () => {
    const result = buildBlock(["myapp.localhost", "api.localhost"]);
    const lines = result.split("\n");
    expect(lines[0]).toBe("# portless-start");
    expect(lines[1]).toBe("127.0.0.1 myapp.localhost");
    expect(lines[2]).toBe("127.0.0.1 api.localhost");
    expect(lines[3]).toBe("# portless-end");
  });

  it("produces a block that extractManagedBlock can parse", () => {
    const hostnames = ["a.localhost", "b.localhost"];
    const block = buildBlock(hostnames);
    const extracted = extractManagedBlock(block);
    expect(extracted).toEqual(["127.0.0.1 a.localhost", "127.0.0.1 b.localhost"]);
  });
});

// ---------------------------------------------------------------------------
// shouldAutoSyncHosts
// ---------------------------------------------------------------------------

describe("shouldAutoSyncHosts", () => {
  it("returns true when unset", () => {
    expect(shouldAutoSyncHosts(undefined)).toBe(true);
  });

  it("returns false for 0 and false", () => {
    expect(shouldAutoSyncHosts("0")).toBe(false);
    expect(shouldAutoSyncHosts("false")).toBe(false);
  });

  it("returns true for 1 and true", () => {
    expect(shouldAutoSyncHosts("1")).toBe(true);
    expect(shouldAutoSyncHosts("true")).toBe(true);
  });

  it("returns true for other non-empty values", () => {
    expect(shouldAutoSyncHosts("yes")).toBe(true);
    expect(shouldAutoSyncHosts("")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkHostResolution
// ---------------------------------------------------------------------------

describe("checkHostResolution", () => {
  it("accepts localhost through either loopback family", async () => {
    const result = await checkHostResolution("localhost");
    expect(result).toBe(true);
  });

  it("accepts IPv4 loopback", async () => {
    const result = await checkHostResolution("127.0.0.1");
    expect(result).toBe(true);
  });

  it("accepts IPv6 loopback", async () => {
    const result = await checkHostResolution("::1");
    expect(result).toBe(true);
  });

  it("rejects non-loopback IPv4", async () => {
    const result = await checkHostResolution("198.51.100.7");
    expect(result).toBe(false);
  });

  it("rejects non-loopback IPv6", async () => {
    const result = await checkHostResolution("2001:db8::1");
    expect(result).toBe(false);
  });

  it("returns false for a nonexistent domain", async () => {
    const result = await checkHostResolution("this-should-never-exist.invalid");
    expect(result).toBe(false);
  });
});

// syncHostsFile verifies that the readable managed block exactly matches the
// requested hostnames. This pure predicate pins that exact verification without
// depending on the hosts path, which is a module constant.
describe("blockMatchesHostnames", () => {
  const block = "# portless-start\n127.0.0.1 a.localhost\n127.0.0.1 b.localhost\n# portless-end";

  it("is true only when the block is exactly the wanted set", () => {
    expect(blockMatchesHostnames(block, ["a.localhost", "b.localhost"])).toBe(true);
    expect(
      blockMatchesHostnames(`127.0.0.1 localhost\n${block}\n`, ["b.localhost", "a.localhost"])
    ).toBe(true);
  });

  it("is false when a hostname is missing", () => {
    expect(blockMatchesHostnames(block, ["a.localhost", "c.localhost"])).toBe(false);
    expect(blockMatchesHostnames("127.0.0.1 localhost\n", ["a.localhost"])).toBe(false);
  });

  // The defect a subset test cannot see. A removed route leaves its hostname in
  // the block; if that still counts as correct, the sync skips its write and the
  // stale entry resolves forever.
  it("is false when the block carries a hostname that is no longer wanted", () => {
    expect(blockMatchesHostnames(block, ["a.localhost"])).toBe(false);
  });

  it("is false when an extra hostname shares a wanted line", () => {
    const aliases = "# portless-start\n127.0.0.1 a.localhost stale.localhost\n# portless-end";
    expect(blockMatchesHostnames(aliases, ["a.localhost"])).toBe(false);
  });

  it("ignores inline comments after all hostname aliases", () => {
    const commented = "# portless-start\n127.0.0.1 a.localhost # managed\n# portless-end";
    expect(blockMatchesHostnames(commented, ["a.localhost"])).toBe(true);
  });

  // A line only helps if it points at loopback.
  it("is false when a wanted hostname maps to another address", () => {
    const wrong = "# portless-start\n10.0.0.1 a.localhost\n# portless-end";
    expect(blockMatchesHostnames(wrong, ["a.localhost"])).toBe(false);
  });

  it("is false on a duplicate entry, which is not what a sync would write", () => {
    const dupe = "# portless-start\n127.0.0.1 a.localhost\n127.0.0.1 a.localhost\n# portless-end";
    expect(blockMatchesHostnames(dupe, ["a.localhost"])).toBe(false);
  });

  it("ignores entries outside the managed block", () => {
    expect(blockMatchesHostnames("127.0.0.1 a.localhost\n", ["a.localhost"])).toBe(false);
  });

  it("treats no hostnames as satisfied only when no block remains", () => {
    expect(blockMatchesHostnames("127.0.0.1 localhost\n", [])).toBe(true);
    expect(blockMatchesHostnames(block, [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hosts file mutation safety
// ---------------------------------------------------------------------------

describe("hosts file mutation safety", () => {
  const systemAndCustomEntries = "127.0.0.1 localhost\n192.0.2.10 custom.test\n";
  const staleBlock =
    "127.0.0.1 localhost\n\n# portless-start\n127.0.0.1 stale.test\n# portless-end\n\n192.0.2.10 custom.test\n";

  function throwReadError(): never {
    throw new Error("EACCES");
  }

  function useInMemoryHosts(initial: string): () => string {
    let hosts = initial;
    vi.mocked(readFileSync).mockImplementation((() => hosts) as unknown as typeof readFileSync);
    vi.mocked(writeFileSync).mockImplementation(((_, data) => {
      hosts = String(data);
    }) as typeof writeFileSync);
    return () => hosts;
  }

  it("does not write when the initial read fails before a populated sync", () => {
    vi.mocked(readFileSync)
      .mockImplementationOnce(throwReadError as typeof readFileSync)
      .mockReturnValue(systemAndCustomEntries);

    expect(syncHostsFile(["app.test"])).toBe(false);
    expect(readFileSync).toHaveBeenCalledTimes(1);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("does not write when the initial read fails before an empty sync", () => {
    vi.mocked(readFileSync)
      .mockImplementationOnce(throwReadError as typeof readFileSync)
      .mockReturnValue(staleBlock);

    expect(syncHostsFile([])).toBe(false);
    expect(readFileSync).toHaveBeenCalledTimes(1);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("does not write when the initial read fails before cleanup", () => {
    vi.mocked(readFileSync)
      .mockImplementationOnce(throwReadError as typeof readFileSync)
      .mockReturnValue(staleBlock);

    expect(cleanHostsFile()).toBe(false);
    expect(readFileSync).toHaveBeenCalledTimes(1);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it.each([
    ["populated", ["app.test"]],
    ["empty", []],
  ])("returns false when verification cannot read a %s sync", (_description, hostnames) => {
    vi.mocked(readFileSync)
      .mockReturnValueOnce(staleBlock)
      .mockImplementationOnce(throwReadError as typeof readFileSync);

    expect(syncHostsFile(hostnames)).toBe(false);
    expect(writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("returns false when the hosts write fails", () => {
    vi.mocked(readFileSync).mockReturnValue(systemAndCustomEntries);
    vi.mocked(writeFileSync).mockImplementation((() => {
      throw new Error("EACCES");
    }) as typeof writeFileSync);

    expect(syncHostsFile(["app.test"])).toBe(false);
    expect(readFileSync).toHaveBeenCalledTimes(1);
    expect(writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("returns false when a successful write does not produce the requested block", () => {
    vi.mocked(readFileSync)
      .mockReturnValueOnce(systemAndCustomEntries)
      .mockReturnValueOnce(systemAndCustomEntries);

    expect(syncHostsFile(["app.test"])).toBe(false);
    expect(writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("treats a readable empty file as an already synchronized empty set", () => {
    vi.mocked(readFileSync).mockReturnValue("");

    expect(syncHostsFile([])).toBe(true);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("does not rewrite an exact matching block", () => {
    vi.mocked(readFileSync).mockReturnValue(
      "# portless-start\n127.0.0.1 app.test\n# portless-end\n"
    );

    expect(syncHostsFile(["app.test"])).toBe(true);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("removes stale entries while preserving entries before and after the block", () => {
    const hosts = useInMemoryHosts(staleBlock);

    expect(syncHostsFile([])).toBe(true);
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    expect(hosts()).toContain("127.0.0.1 localhost");
    expect(hosts()).toContain("192.0.2.10 custom.test");
    expect(hosts()).not.toContain("portless-start");
    expect(hosts()).not.toContain("stale.test");
  });

  it("writes and verifies a replacement block without changing unrelated entries", () => {
    const hosts = useInMemoryHosts(staleBlock);

    expect(syncHostsFile(["app.test"])).toBe(true);
    expect(hosts()).toContain("127.0.0.1 localhost");
    expect(hosts()).toContain("192.0.2.10 custom.test");
    expect(hosts()).toContain("127.0.0.1 app.test");
    expect(hosts()).not.toContain("stale.test");
  });

  it("keeps getManagedHostnames best-effort on read failure", () => {
    vi.mocked(readFileSync).mockImplementation(throwReadError as typeof readFileSync);

    expect(getManagedHostnames()).toEqual([]);
  });
});
