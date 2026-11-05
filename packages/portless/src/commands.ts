/** Subcommand words portless reserves. Any other first argument is an app name. */
export const COMMAND_NAMES = [
  "run",
  "get",
  "list",
  "alias",
  "compose",
  "proxy",
  "service",
  "hosts",
  "doctor",
  "trust",
  "clean",
  "prune",
  "mcp",
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

const COMMAND_SET: ReadonlySet<string> = new Set(COMMAND_NAMES);

export function isCommandName(word: string | undefined): word is CommandName {
  return word !== undefined && COMMAND_SET.has(word);
}

/** True when --help or -h appears after the command word and before any `--` separator. */
export function hasHelpFlag(args: readonly string[]): boolean {
  for (const arg of args.slice(1)) {
    if (arg === "--") return false;
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}

/** Edit distance where swapping two adjacent characters counts as one edit. */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** The command one edit away from `word`, if exactly one is, for "did you mean" hints. */
export function suggestCommand(word: string): CommandName | undefined {
  const matches = COMMAND_NAMES.filter((name) => editDistance(word, name) === 1);
  return matches.length === 1 ? matches[0] : undefined;
}
