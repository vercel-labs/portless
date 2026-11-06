import { describe, it, expect } from "vitest";
import { parseCommandArgs, parseLeadingArgs, UsageError } from "./args.js";

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

const childSpec = { "--name": "value", "--force": "boolean", "--prefix": "text" } as const;

describe("parseLeadingArgs", () => {
  it("reads value flags and returns the child command untouched", () => {
    const { flags, rest } = parseLeadingArgs(
      "run",
      ["--name=api", "--force", "next", "dev", "--port", "3000"],
      childSpec
    );
    expect(flags.value("--name")).toBe("api");
    expect(flags.has("--force")).toBe(true);
    expect(rest).toEqual(["next", "dev", "--port", "3000"]);
  });

  it("keeps a value that itself contains =", () => {
    const { flags } = parseLeadingArgs("run", ["--name=a=b", "next"], childSpec);
    expect(flags.value("--name")).toBe("a=b");
  });

  it("rejects a value given to a boolean flag", () => {
    expect(() => parseLeadingArgs("run", ["--force=false", "next"], childSpec)).toThrow(
      "--force does not take a value."
    );
  });

  it("accepts an empty text value but not an empty value flag", () => {
    const { flags } = parseLeadingArgs("run", ["--prefix=", "--name=x", "next"], childSpec);
    expect(flags.value("--prefix")).toBe("");
    expect(flags.value("--name")).toBe("x");
    expect(() => parseLeadingArgs("run", ["--name=", "next"], childSpec)).toThrow(
      "--name requires a value."
    );
  });

  it("stops at the first positional so child flags are left alone", () => {
    const { flags, rest } = parseLeadingArgs("run", ["next", "--force=false"], childSpec);
    expect(flags.has("--force")).toBe(false);
    expect(rest).toEqual(["next", "--force=false"]);
  });

  it("drops a leading -- and keeps everything after it", () => {
    const { flags, rest } = parseLeadingArgs("run", ["--", "--force", "next"], childSpec);
    expect(flags.has("--force")).toBe(false);
    expect(rest).toEqual(["--force", "next"]);
  });
});
