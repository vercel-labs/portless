import { describe, it, expect } from "vitest";
import { supportsColor } from "./colors.js";

describe("supportsColor", () => {
  it("follows TTY detection when no color variables are set", () => {
    expect(supportsColor({}, true)).toBe(true);
    expect(supportsColor({}, false)).toBe(false);
  });

  it("disables color when NO_COLOR is non-empty, even with FORCE_COLOR set", () => {
    expect(supportsColor({ NO_COLOR: "1", FORCE_COLOR: "1" }, true)).toBe(false);
    expect(supportsColor({ NO_COLOR: "1" }, true)).toBe(false);
  });

  it("ignores an empty NO_COLOR", () => {
    expect(supportsColor({ NO_COLOR: "" }, true)).toBe(true);
    expect(supportsColor({ NO_COLOR: "" }, false)).toBe(false);
  });

  it("forces color on for any FORCE_COLOR value other than 0 or false", () => {
    expect(supportsColor({ FORCE_COLOR: "1" }, false)).toBe(true);
    expect(supportsColor({ FORCE_COLOR: "true" }, false)).toBe(true);
  });

  it("disables color for FORCE_COLOR=0 or false, even on a TTY", () => {
    expect(supportsColor({ FORCE_COLOR: "0" }, true)).toBe(false);
    expect(supportsColor({ FORCE_COLOR: "false" }, true)).toBe(false);
  });
});
