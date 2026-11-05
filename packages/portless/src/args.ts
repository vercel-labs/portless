import { closestMatch } from "./commands.js";

/** A mistake in how a command was invoked. The CLI prints it and exits with code 2. */
export class UsageError extends Error {
  constructor(
    message: string,
    readonly hints: string[] = []
  ) {
    super(message);
    this.name = "UsageError";
  }
}

export type FlagKind = "boolean" | "value";

export interface ParsedArgs {
  positionals: string[];
  has(flag: string): boolean;
  /** Every value given for a repeatable value flag, in order. */
  values(flag: string): string[];
  /** The first value given for a value flag. */
  value(flag: string): string | undefined;
}

/**
 * Parse the arguments after a command word against the flags it accepts.
 * Accepts `--flag value`, `--flag=value`, repeated flags, and `--`. Throws
 * UsageError for unknown flags, missing values, and extra positionals.
 */
export function parseCommandArgs(
  command: string,
  args: readonly string[],
  spec: Readonly<Record<string, FlagKind>>,
  maxPositionals = Infinity
): ParsedArgs {
  const seen = new Map<string, string[]>();
  const positionals: string[] = [];
  const known = Object.keys(spec);
  const helpHint = `See: portless ${command} --help`;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const kind = spec[flag];
    if (!kind) {
      const suggestion = closestMatch(flag, known);
      throw new UsageError(`Unknown flag "${flag}" for portless ${command}.`, [
        ...(suggestion ? [`Did you mean ${suggestion}?`] : []),
        known.length > 0 ? `Known flags: ${known.join(", ")}` : "This command takes no flags.",
        helpHint,
      ]);
    }
    let value: string | undefined;
    if (kind === "value") {
      value = eq === -1 ? args[++i] : arg.slice(eq + 1);
      if (value === undefined || value === "" || (eq === -1 && value.startsWith("-"))) {
        throw new UsageError(`${flag} requires a value.`, [helpHint]);
      }
    } else if (eq !== -1) {
      throw new UsageError(`${flag} does not take a value.`, [helpHint]);
    }
    seen.set(flag, [...(seen.get(flag) ?? []), ...(value === undefined ? [] : [value])]);
  }

  if (positionals.length > maxPositionals) {
    throw new UsageError(
      `Unexpected argument "${positionals[maxPositionals]}" for portless ${command}.`,
      [helpHint]
    );
  }

  return {
    positionals,
    has: (flag) => seen.has(flag),
    values: (flag) => seen.get(flag) ?? [],
    value: (flag) => seen.get(flag)?.[0],
  };
}
