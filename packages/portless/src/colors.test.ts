import { describe, it, expect } from "vitest";
import { stripColor, supportsColor } from "./colors.js";

describe("supportsColor", () => {
  it.each([
    [{}, true, true],
    [{}, false, false],
    [{ NO_COLOR: "1" }, true, false],
    [{ NO_COLOR: "1", FORCE_COLOR: "1" }, true, false],
    [{ NO_COLOR: "" }, true, true],
    [{ NO_COLOR: "" }, false, false],
    [{ FORCE_COLOR: "1" }, false, true],
    [{ FORCE_COLOR: "true" }, false, true],
    [{ FORCE_COLOR: "0" }, true, false],
    [{ FORCE_COLOR: "false" }, true, false],
  ])("with %j and terminal %s returns %s", (env, isTTY, expected) => {
    expect(supportsColor(env, isTTY)).toBe(expected);
  });
});

describe("stripColor", () => {
  it("removes the codes portless adds and keeps other escape sequences", () => {
    expect(stripColor("\x1b[31mError:\x1b[39m \x1b[1mbold\x1b[22m")).toBe("Error: bold");
    expect(stripColor("\x1b[32mfrom the app\x1b[0m")).toBe("\x1b[32mfrom the app\x1b[0m");
  });
});
