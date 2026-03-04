import { describe, it, expect } from "vitest";
import { checkLocalhostResolution } from "./hosts.js";

describe("checkLocalhostResolution", () => {
  it("resolves localhost to 127.0.0.1", async () => {
    const result = await checkLocalhostResolution("localhost");
    expect(result).toBe(true);
  });

  it("returns false for a nonexistent domain", async () => {
    const result = await checkLocalhostResolution("this-should-never-exist.invalid");
    expect(result).toBe(false);
  });
});
