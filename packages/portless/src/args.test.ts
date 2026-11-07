import { describe, it, expect } from "vitest";
import { parseCommandArgs, visitLeadingFlags, UsageError } from "./args.js";

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

describe("visitLeadingFlags", () => {
  it("reports flags in argument order and returns the child command untouched", () => {
    const visits: [string, string | undefined][] = [];
    const rest = visitLeadingFlags(
      "run",
      ["--name=api", "--force", "next", "dev", "--port", "3000"],
      childSpec,
      (flag, value) => {
        visits.push([flag, value]);
      }
    );
    expect(visits).toEqual([
      ["--name", "api"],
      ["--force", undefined],
    ]);
    expect(rest).toEqual(["next", "dev", "--port", "3000"]);
  });

  it("reports every value in order so a caller can keep the last one", () => {
    const values: string[] = [];
    visitLeadingFlags("run", ["--name=one", "--name", "two"], childSpec, (_flag, value) => {
      if (value !== undefined) values.push(value);
    });
    expect(values).toEqual(["one", "two"]);
  });

  it("keeps a value that itself contains =", () => {
    const values: string[] = [];
    visitLeadingFlags("run", ["--name=a=b", "next"], childSpec, (_flag, value) => {
      if (value !== undefined) values.push(value);
    });
    expect(values).toEqual(["a=b"]);
  });

  it("rejects a value given to a boolean flag", () => {
    expect(() => visitLeadingFlags("run", ["--force=false", "next"], childSpec, () => {})).toThrow(
      "--force does not take a value."
    );
  });

  it("accepts an empty text value but not an empty value flag", () => {
    const visits: [string, string | undefined][] = [];
    visitLeadingFlags("run", ["--prefix=", "--name=x", "next"], childSpec, (flag, value) => {
      visits.push([flag, value]);
    });
    expect(visits).toEqual([
      ["--prefix", ""],
      ["--name", "x"],
    ]);
    expect(() => visitLeadingFlags("run", ["--name=", "next"], childSpec, () => {})).toThrow(
      "--name requires a value."
    );
  });

  it("stops at the first positional so child flags are left alone", () => {
    const visits: string[] = [];
    const rest = visitLeadingFlags("run", ["next", "--force=false"], childSpec, (flag) => {
      visits.push(flag);
    });
    expect(visits).toEqual([]);
    expect(rest).toEqual(["next", "--force=false"]);
  });

  it("stops when the visitor asks it to", () => {
    const visits: string[] = [];
    const rest = visitLeadingFlags("run", ["--name=a", "--bogus"], childSpec, (flag) => {
      visits.push(flag);
      return false;
    });
    expect(visits).toEqual(["--name"]);
    expect(rest).toEqual([]);
  });

  it("drops a leading -- and keeps everything after it", () => {
    const visits: string[] = [];
    const rest = visitLeadingFlags("run", ["--", "--force", "next"], childSpec, (flag) => {
      visits.push(flag);
    });
    expect(visits).toEqual([]);
    expect(rest).toEqual(["--force", "next"]);
  });
});
