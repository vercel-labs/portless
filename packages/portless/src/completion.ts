import type { CommandName } from "./commands.js";

export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;

export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

const COMPLETION_SHELL_SET: ReadonlySet<string> = new Set(COMPLETION_SHELLS);

/** True when `value` is a supported shell name for `portless completion`. */
export function isCompletionShell(value: string): value is CompletionShell {
  return COMPLETION_SHELL_SET.has(value);
}

/** Completion metadata for one top-level command, derived from CLI flag specs. */
export interface CommandCompletionSpec {
  flags?: readonly string[];
  subcommands?: readonly string[];
  subcommandFlags?: Readonly<Record<string, readonly string[]>>;
}

/** Full CLI completion model generated from `COMMAND_NAMES` and flag specs. */
export interface CompletionSpec {
  commands: readonly CommandName[];
  globalFlags: readonly string[];
  byCommand: Readonly<Record<CommandName, CommandCompletionSpec>>;
}

function uniqueWords(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function generateBash(spec: CompletionSpec): string {
  const topWords = uniqueWords([...spec.commands, ...spec.globalFlags]).join(" ");
  const cases: string[] = [];

  for (const command of spec.commands) {
    const entry = spec.byCommand[command];
    const flags = uniqueWords([...(entry.flags ?? []), "--help", "-h"]);
    const subs = entry.subcommands ?? [];
    const subFlags = entry.subcommandFlags ?? {};

    cases.push(`    ${command})`);
    if (subs.length > 0) {
      const firstLevel = uniqueWords([...subs, ...flags]).join(" ");
      cases.push(`      if [[ $COMP_CWORD -eq 2 ]]; then`);
      cases.push(`        COMPREPLY=( $(compgen -W "${firstLevel}" -- "$cur") )`);
      cases.push(`      else`);
      const subFlagEntries = Object.entries(subFlags);
      if (subFlagEntries.length > 0) {
        cases.push(`        case "\${COMP_WORDS[2]}" in`);
        for (const [sub, words] of subFlagEntries) {
          const allSubFlags = uniqueWords([...words, "--help", "-h"]).join(" ");
          cases.push(`          ${sub})`);
          cases.push(`            COMPREPLY=( $(compgen -W "${allSubFlags}" -- "$cur") )`);
          cases.push(`            ;;`);
        }
        cases.push(`          *)`);
        cases.push(`            COMPREPLY=( $(compgen -W "${flags.join(" ")}" -- "$cur") )`);
        cases.push(`            ;;`);
        cases.push(`        esac`);
      } else {
        cases.push(`        COMPREPLY=( $(compgen -W "${flags.join(" ")}" -- "$cur") )`);
      }
      cases.push(`      fi`);
    } else {
      cases.push(`      COMPREPLY=( $(compgen -W "${flags.join(" ")}" -- "$cur") )`);
    }
    cases.push(`      ;;`);
  }

  return [
    "# bash completion for portless",
    "_portless_completions() {",
    "  local cur cmd",
    "  COMPREPLY=()",
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    "",
    "  if [[ $COMP_CWORD -eq 1 ]]; then",
    `    COMPREPLY=( $(compgen -W "${topWords}" -- "$cur") )`,
    "    return 0",
    "  fi",
    "",
    '  cmd="${COMP_WORDS[1]}"',
    '  case "$cmd" in',
    ...cases,
    "  esac",
    "}",
    "complete -F _portless_completions portless",
    "",
  ].join("\n");
}

function generateZsh(spec: CompletionSpec): string {
  const topWords = uniqueWords([...spec.commands, ...spec.globalFlags]).join(" ");
  const cases: string[] = [];

  for (const command of spec.commands) {
    const entry = spec.byCommand[command];
    const flags = uniqueWords([...(entry.flags ?? []), "--help", "-h"]);
    const subs = entry.subcommands ?? [];
    const subFlags = entry.subcommandFlags ?? {};

    cases.push(`    ${command})`);
    if (subs.length > 0) {
      const firstLevel = uniqueWords([...subs, ...flags]).join(" ");
      cases.push(`      if (( CURRENT == 3 )); then`);
      cases.push(`        compadd -- ${firstLevel}`);
      cases.push(`      else`);
      const subFlagEntries = Object.entries(subFlags);
      if (subFlagEntries.length > 0) {
        cases.push(`        case "$words[3]" in`);
        for (const [sub, words] of subFlagEntries) {
          const allSubFlags = uniqueWords([...words, "--help", "-h"]).join(" ");
          cases.push(`          ${sub}) compadd -- ${allSubFlags} ;;`);
        }
        cases.push(`          *) compadd -- ${flags.join(" ")} ;;`);
        cases.push(`        esac`);
      } else {
        cases.push(`        compadd -- ${flags.join(" ")}`);
      }
      cases.push(`      fi`);
    } else {
      cases.push(`      compadd -- ${flags.join(" ")}`);
    }
    cases.push(`      ;;`);
  }

  return [
    "#compdef portless",
    "_portless() {",
    "  if (( CURRENT == 2 )); then",
    `    compadd -- ${topWords}`,
    "    return 0",
    "  fi",
    "",
    '  case "$words[2]" in',
    ...cases,
    "  esac",
    "}",
    "compdef _portless portless",
    "",
  ].join("\n");
}

function fishFlagArgs(flag: string): string {
  if (flag.startsWith("--")) return `-l ${flag.slice(2)}`;
  if (flag.startsWith("-")) return `-s ${flag.slice(1)}`;
  return `-a "${flag}"`;
}

function generateFish(spec: CompletionSpec): string {
  const lines: string[] = [
    "# fish completion for portless",
    "complete -c portless -f",
    `complete -c portless -n "__fish_use_subcommand" -a "${spec.commands.join(" ")}"`,
  ];

  for (const flag of uniqueWords(spec.globalFlags)) {
    lines.push(`complete -c portless -n "__fish_use_subcommand" ${fishFlagArgs(flag)}`);
  }

  for (const command of spec.commands) {
    const entry = spec.byCommand[command];
    const flags = uniqueWords([...(entry.flags ?? []), "--help", "-h"]);
    const subs = entry.subcommands ?? [];
    const subFlags = entry.subcommandFlags ?? {};

    if (subs.length > 0) {
      const noSubCond = `__fish_seen_subcommand_from ${command}; and not __fish_seen_subcommand_from ${subs.join(" ")}`;
      lines.push(`complete -c portless -n "${noSubCond}" -a "${subs.join(" ")}"`);
      for (const flag of flags) {
        lines.push(`complete -c portless -n "${noSubCond}" ${fishFlagArgs(flag)}`);
      }
      for (const [sub, words] of Object.entries(subFlags)) {
        const subCond = `__fish_seen_subcommand_from ${command}; and __fish_seen_subcommand_from ${sub}`;
        for (const flag of uniqueWords([...words, "--help", "-h"])) {
          lines.push(`complete -c portless -n "${subCond}" ${fishFlagArgs(flag)}`);
        }
      }
    } else {
      const cmdCond = `__fish_seen_subcommand_from ${command}`;
      for (const flag of flags) {
        lines.push(`complete -c portless -n "${cmdCond}" ${fishFlagArgs(flag)}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Generate a shell completion script from the CLI command and flag specs. */
export function generateCompletionScript(shell: CompletionShell, spec: CompletionSpec): string {
  switch (shell) {
    case "bash":
      return generateBash(spec);
    case "zsh":
      return generateZsh(spec);
    case "fish":
      return generateFish(spec);
  }
}
