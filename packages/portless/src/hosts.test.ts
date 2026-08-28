import { describe, it, expect } from "vitest";
import {
  checkHostResolution,
  blockMatchesHostnames,
  extractManagedBlock,
  removeBlock,
  buildBlock,
  shouldAutoSyncHosts,
} from "./hosts.js";

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

// syncHostsFile answers "does the hosts file resolve these hostnames", not "did
// the write throw". The two differ in the case that matters: a write can fail
// with the block already correct from an earlier run, and the hostnames resolve
// regardless, so reporting the write would warn about a failure the user does
// not have. The predicate is pure because the hosts path is a module constant.
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
