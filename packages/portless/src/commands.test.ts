import { describe, it, expect } from "vitest";
import { hasHelpFlag, suggestCommand } from "./commands.js";

describe("suggestCommand", () => {
  it("suggests a unique command one edit away, including adjacent swaps", () => {
    expect(suggestCommand("lsit")).toBe("list");
  });

  it("does not suggest commands for distant or exact matches", () => {
    expect(suggestCommand("web")).toBeUndefined();
    expect(suggestCommand("list")).toBeUndefined();
  });
});

describe("hasHelpFlag", () => {
  it("recognizes help after the command and before a separator", () => {
    expect(hasHelpFlag(["get", "x", "--help"])).toBe(true);
    expect(hasHelpFlag(["get", "--", "--help"])).toBe(false);
    expect(hasHelpFlag(["--help"])).toBe(false);
  });
});
