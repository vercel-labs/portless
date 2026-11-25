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
  valueFlags?: readonly string[];
  stopsAtPositional?: boolean;
  subcommands?: readonly string[];
  subcommandFlags?: Readonly<Record<string, readonly string[]>>;
}

/** Full CLI completion model generated from `COMMAND_NAMES` and flag specs. */
export interface CompletionSpec {
  commands: readonly CommandName[];
  globalFlags: readonly string[];
  globalValueFlags: readonly string[];
  byCommand: Readonly<Record<CommandName, CommandCompletionSpec>>;
}

function uniqueWords(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function casePattern(values: readonly string[]): string {
  return uniqueWords(values).join("|");
}

function generateBash(spec: CompletionSpec): string {
  const topWords = uniqueWords([...spec.commands, ...spec.globalFlags]).join(" ");
  const globalValPattern = casePattern(spec.globalValueFlags);
  const cases: string[] = [];

  for (const command of spec.commands) {
    const entry = spec.byCommand[command];
    const flags = uniqueWords([...(entry.flags ?? []), "--help", "-h"]);
    const subs = entry.subcommands ?? [];
    const subFlags = entry.subcommandFlags ?? {};

    cases.push(`    ${command})`);
    if (entry.stopsAtPositional) {
      const cmdValPattern = casePattern(entry.valueFlags ?? []);
      cases.push(`      local j=$((cmd_idx + 1))`);
      cases.push(`      while (( j < COMP_CWORD )); do`);
      cases.push(`        case "\${COMP_WORDS[j]}" in`);
      cases.push(`          --) return 0 ;;`);
      if (cmdValPattern) {
        cases.push(`          ${cmdValPattern}) j=$((j + 2)); continue ;;`);
      }
      cases.push(`          -*) j=$((j + 1)); continue ;;`);
      cases.push(`          *) return 0 ;;`);
      cases.push(`        esac`);
      cases.push(`      done`);
      cases.push(`      COMPREPLY=( $(compgen -W "${flags.join(" ")}" -- "$cur") )`);
    } else if (subs.length > 0) {
      const firstLevel = uniqueWords([...subs, ...flags]).join(" ");
      cases.push(`      if (( COMP_CWORD == cmd_idx + 1 )); then`);
      cases.push(`        COMPREPLY=( $(compgen -W "${firstLevel}" -- "$cur") )`);
      cases.push(`      else`);
      const subFlagEntries = Object.entries(subFlags);
      if (subFlagEntries.length > 0) {
        cases.push(`        case "\${COMP_WORDS[cmd_idx + 1]}" in`);
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
    "  local cur i=1 cmd='' cmd_idx=0",
    "  COMPREPLY=()",
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    "",
    "  while (( i < COMP_CWORD )); do",
    '    case "${COMP_WORDS[i]}" in',
    "      --) return 0 ;;",
    ...(globalValPattern ? [`      ${globalValPattern}) i=$((i + 2)); continue ;;`] : []),
    "      -*) i=$((i + 1)); continue ;;",
    '      *) cmd="${COMP_WORDS[i]}"; cmd_idx=$i; break ;;',
    "    esac",
    "  done",
    "",
    '  if [[ -z "$cmd" ]]; then',
    `    COMPREPLY=( $(compgen -W "${topWords}" -- "$cur") )`,
    "    return 0",
    "  fi",
    "",
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
  const globalValPattern = casePattern(spec.globalValueFlags);
  const cases: string[] = [];

  for (const command of spec.commands) {
    const entry = spec.byCommand[command];
    const flags = uniqueWords([...(entry.flags ?? []), "--help", "-h"]);
    const subs = entry.subcommands ?? [];
    const subFlags = entry.subcommandFlags ?? {};

    cases.push(`    ${command})`);
    if (entry.stopsAtPositional) {
      const cmdValPattern = casePattern(entry.valueFlags ?? []);
      cases.push(`      local j=$((cmd_idx + 1))`);
      cases.push(`      while (( j < CURRENT )); do`);
      cases.push(`        case "$words[j]" in`);
      cases.push(`          --) return 0 ;;`);
      if (cmdValPattern) {
        cases.push(`          ${cmdValPattern}) (( j += 2 )); continue ;;`);
      }
      cases.push(`          -*) (( j += 1 )); continue ;;`);
      cases.push(`          *) return 0 ;;`);
      cases.push(`        esac`);
      cases.push(`      done`);
      cases.push(`      compadd -- ${flags.join(" ")}`);
    } else if (subs.length > 0) {
      const firstLevel = uniqueWords([...subs, ...flags]).join(" ");
      cases.push(`      if (( CURRENT == cmd_idx + 1 )); then`);
      cases.push(`        compadd -- ${firstLevel}`);
      cases.push(`      else`);
      const subFlagEntries = Object.entries(subFlags);
      if (subFlagEntries.length > 0) {
        cases.push(`        case "$words[cmd_idx + 1]" in`);
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
    "  local i=2 cmd='' cmd_idx=0",
    "  while (( i < CURRENT )); do",
    '    case "$words[i]" in',
    "      --) return 0 ;;",
    ...(globalValPattern ? [`      ${globalValPattern}) (( i += 2 )); continue ;;`] : []),
    "      -*) (( i += 1 )); continue ;;",
    '      *) cmd="$words[i]"; cmd_idx=$i; break ;;',
    "    esac",
    "  done",
    "",
    '  if [[ -z "$cmd" ]]; then',
    `    compadd -- ${topWords}`,
    "    return 0",
    "  fi",
    "",
    '  case "$cmd" in',
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
