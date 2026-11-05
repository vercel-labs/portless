import { describe, it, expect } from "vitest";
import { parseCommandArgs, UsageError } from "./args.js";

const spec = { "--name": "value", "--port": "value", "--force": "boolean" } as const;

describe("parseCommandArgs", () => {
  it("reads a value flag with = and with a separate token", () => {
    expect(parseCommandArgs("deploy", ["--name=api"], spec).value("--name")).toBe("api");
    expect(parseCommandArgs("deploy", ["--name", "api"], spec).value("--name")).toBe("api");
    expect(parseCommandArgs("deploy", ["--port=3000"], spec).value("--port")).toBe("3000");
    expect(parseCommandArgs("deploy", ["--port", "3000"], spec).value("--port")).toBe("3000");
  });

  it("collects repeated value flags in order", () => {
    const parsed = parseCommandArgs(
      "deploy",
      ["--name", "one", "--name", "two", "--name=three"],
      spec
    );
    expect(parsed.values("--name")).toEqual(["one", "two", "three"]);
    expect(parsed.value("--name")).toBe("one");
  });

  it("suggests the known flag for a one edit typo", () => {
    const error = (() => {
      try {
        parseCommandArgs("deploy", ["--prot", "3000"], spec);
      } catch (err) {
        return err as UsageError;
      }
    })();
    expect(error).toBeInstanceOf(UsageError);
    expect(error?.message).toBe('Unknown flag "--prot" for portless deploy.');
    expect(error?.hints).toContain("Did you mean --port?");
  });

  it("rejects a value flag with no value", () => {
    expect(() => parseCommandArgs("deploy", ["--name"], spec)).toThrow(UsageError);
    expect(() => parseCommandArgs("deploy", ["--name"], spec)).toThrow("--name requires a value.");
    expect(() => parseCommandArgs("deploy", ["--name", "--force"], spec)).toThrow(
      "--name requires a value."
    );
  });

  it("rejects a value given to a boolean flag", () => {
    expect(() => parseCommandArgs("deploy", ["--force=1"], spec)).toThrow(
      "--force does not take a value."
    );
  });

  it("rejects positionals beyond the max", () => {
    expect(parseCommandArgs("deploy", ["a", "b"], spec, 2).positionals).toEqual(["a", "b"]);
    expect(() => parseCommandArgs("deploy", ["a", "b"], spec, 1)).toThrow(
      'Unexpected argument "b" for portless deploy.'
    );
  });

  it("turns everything after -- into positionals", () => {
    const parsed = parseCommandArgs("deploy", ["a", "--", "--force", "-x"], spec);
    expect(parsed.positionals).toEqual(["a", "--force", "-x"]);
    expect(parsed.has("--force")).toBe(false);
  });
});
