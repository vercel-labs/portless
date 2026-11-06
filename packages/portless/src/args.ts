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

export type FlagKind = "boolean" | "value" | "text";

export interface ParsedArgs {
  positionals: string[];
  has(flag: string): boolean;
  /** Every value given for a repeatable value flag, in order. */
  values(flag: string): string[];
  /** The first value given for a value flag. */
  value(flag: string): string | undefined;
}

/** Reports a flag as it is read, with the value of a value flag. Return false to stop reading. */
export type FlagVisitor = (flag: string, value: string | undefined) => boolean | void;

/** One recognized flag token: its name, its value, and the last index it used. */
interface FlagToken {
  flag: string;
  value: string | undefined;
  end: number;
}

function helpHint(command: string): string[] {
  return command ? [`See: portless ${command} --help`] : [];
}

/**
 * Read the flag at `index`, rejecting unknown flags and boolean flags given a
 * value. A `value` flag needs a non-empty value; a `text` flag accepts an empty
 * one, so strings like `--prefix ""` stay meaningful.
 */
function readFlagToken(
  command: string,
  args: readonly string[],
  index: number,
  spec: Readonly<Record<string, FlagKind>>
): FlagToken {
  const arg = args[index];
  const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
  const flag = eq === -1 ? arg : arg.slice(0, eq);
  const kind = spec[flag];
  const known = Object.keys(spec);
  const hint = helpHint(command);

  if (!kind) {
    const suggestion = closestMatch(flag, known);
    throw new UsageError(`Unknown flag "${flag}"${command ? ` for portless ${command}` : ""}.`, [
      ...(suggestion ? [`Did you mean ${suggestion}?`] : []),
      known.length > 0 ? `Known flags: ${known.join(", ")}` : "This command takes no flags.",
      ...hint,
    ]);
  }

  if (kind === "boolean") {
    if (eq !== -1) throw new UsageError(`${flag} does not take a value.`, hint);
    return { flag, value: undefined, end: index };
  }

  const value = eq === -1 ? args[index + 1] : arg.slice(eq + 1);
  const missing =
    value === undefined ||
    (kind === "value" && value === "") ||
    (eq === -1 && value.startsWith("-"));
  if (missing) throw new UsageError(`${flag} requires a value.`, hint);
  return { flag, value, end: eq === -1 ? index + 1 : index };
}

function collect(seen: Map<string, string[]>, token: FlagToken): void {
  seen.set(token.flag, [
    ...(seen.get(token.flag) ?? []),
    ...(token.value === undefined ? [] : [token.value]),
  ]);
}

function parsedArgs(seen: ReadonlyMap<string, string[]>, positionals: string[]): ParsedArgs {
  return {
    positionals,
    has: (flag) => seen.has(flag),
    values: (flag) => seen.get(flag) ?? [],
    value: (flag) => seen.get(flag)?.[0],
  };
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
    const token = readFlagToken(command, args, i, spec);
    collect(seen, token);
    i = token.end;
  }

  if (positionals.length > maxPositionals) {
    throw new UsageError(
      `Unexpected argument "${positionals[maxPositionals]}" for portless ${command}.`,
      helpHint(command)
    );
  }

  return parsedArgs(seen, positionals);
}

/**
 * Visits leading flags in argument order until `--`, a positional, or `visit` returns false.
 * Returns child arguments unchanged; callers decide how repeated flags are handled.
 */
export function visitLeadingFlags(
  command: string,
  args: readonly string[],
  spec: Readonly<Record<string, FlagKind>>,
  visit: FlagVisitor
): string[] {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return args.slice(i + 1);
    if (!arg.startsWith("-") || arg === "-") return args.slice(i);
    const token = readFlagToken(command, args, i, spec);
    if (visit(token.flag, token.value) === false) return [];
    i = token.end;
  }

  return [];
}
