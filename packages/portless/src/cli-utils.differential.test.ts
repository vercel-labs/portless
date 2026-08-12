import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  injectPackageScriptFrameworkFlags,
  isWindows,
  resolveFrameworkBasename,
} from "./cli-utils.js";

/**
 * Differential test for package-script flag forwarding.
 *
 * The guard in injectPackageScriptFrameworkFlags decides whether appending
 * flags to a package script is safe. Every previous round of this feature
 * hardened that guard against one more shell construct and the next reviewer
 * found another, because the cells were always derived from the last bug
 * report. Enumeration by imagination does not converge.
 *
 * The shell is the oracle. For each script shape below, run what portless
 * would actually run and read the child's argv:
 *
 *   VIOLATION  portless appended flags and the child never received them.
 *              This is the 502 class: exit 0, framework on its own port, and
 *              no test that asserts on the constructed array can see it.
 *   skip       portless declined. Conservative, documented, not a violation.
 *
 * Add a shape here rather than a bespoke test whenever a new script form comes
 * up; the assertion is the property, so a new row needs no new expectations.
 * Set PORTLESS_DIFFERENTIAL_RUNNERS=bun,npm,pnpm to widen the sweep past bun.
 */

const FRAMEWORK = "vite dev";

const SCRIPTS: Record<string, string> = {
  // Plain and benign decorations.
  plain: FRAMEWORK,
  withFlags: `${FRAMEWORK} --open --strictPort=false`,
  quotedSingle: `${FRAMEWORK} --open '/foo&bar'`,
  quotedDouble: `${FRAMEWORK} --open "/foo;bar"`,
  escapedSpace: `${FRAMEWORK} --open /foo\\ bar`,
  glob: `${FRAMEWORK} --config ./cfg/*.ts`,
  varExpand: `${FRAMEWORK} --mode $NODE_ENV`,
  varBraced: `${FRAMEWORK} --mode \${NODE_ENV}`,
  equalsFlag: `${FRAMEWORK} --mode=production`,
  tabs: `${FRAMEWORK}\t--open`,
  trailingSpace: `${FRAMEWORK}   `,
  leadingSpace: `   ${FRAMEWORK}`,
  nestedQuotes: `${FRAMEWORK} --open "it's"`,

  // Comments: the class that silently discards the tail.
  comment: `${FRAMEWORK} # note`,
  commentNoSpaceBefore: `${FRAMEWORK}# note`,
  commentTight: `${FRAMEWORK} #note`,
  commentOnly: `${FRAMEWORK} #`,
  multiSpaceComment: `${FRAMEWORK}    #    note`,
  hashInWord: `${FRAMEWORK} --tag v1#2`,
  hashAfterEscapedSpace: `${FRAMEWORK} --open /foo\\ #bar`,
  hashInSingle: `${FRAMEWORK} --open '#literal'`,
  hashInDouble: `${FRAMEWORK} --open "#literal"`,
  hashAfterQuotedEnd: `${FRAMEWORK} "x" # note`,
  hashAfterRedirect: `${FRAMEWORK} > out.log # note`,
  hashAfterTab: `${FRAMEWORK}\t# note`,
  escapedHash: `${FRAMEWORK} --tag \\#notacomment`,
  hashInSubst: `${FRAMEWORK} --define X=$(printf '#hash')`,
  quoteThenHashTight: `${FRAMEWORK} --open "x"#y`,
  lineContinuationComment: `${FRAMEWORK} \\\n# note`,
  twoContinuations: `${FRAMEWORK} \\\n --open \\\n# note`,
  commentAfterNewline: `${FRAMEWORK}\n# note`,
  semiThenComment: `${FRAMEWORK} ;# note`,

  // Separators.
  andand: `${FRAMEWORK} && echo done`,
  andandGlued: `${FRAMEWORK}&&echo done`,
  oror: `${FRAMEWORK} || echo fail`,
  semi: `${FRAMEWORK}; echo done`,
  semiGlued: `${FRAMEWORK};echo done`,
  pipe: `${FRAMEWORK} | tee out.log`,
  background: `${FRAMEWORK} &`,
  newline: `${FRAMEWORK}\necho done`,
  lineContinuationCmd: `${FRAMEWORK} \\\n  --open`,

  // Redirections are single commands and must still be injected into.
  redirect: `${FRAMEWORK} > out.log`,
  redirectAppend: `${FRAMEWORK} >> out.log`,
  redirectErr: `${FRAMEWORK} 2>&1`,
  // A bash extension; dash reads the `&` as backgrounding.
  redirectBoth: `${FRAMEWORK} &> out.log`,
  redirectDupToFd: `${FRAMEWORK} 2>&1 >out.log`,
  redirectCloseFd: `${FRAMEWORK} 2>&-`,
  redirectIn: `${FRAMEWORK} < /dev/null`,

  // Substitution and grouping.
  substWordStart: "$(printf vite) dev",
  substMidWord: `${FRAMEWORK} --define SHA=$(printf abc)`,
  backtickStart: "`printf vite` dev",
  subshell: `(${FRAMEWORK})`,
  braceGroup: `{ ${FRAMEWORK}; }`,

  // Prefixes and runner wrappers.
  envPrefix: `NODE_ENV=production ${FRAMEWORK}`,
  envPrefixTwo: `A=1 B=2 ${FRAMEWORK}`,
  execPrefix: `exec ${FRAMEWORK}`,
  bunx: "bunx vite dev",
  bunxBun: "bunx --bun vite dev",
  npx: "npx vite dev",
  pnpmExec: "pnpm exec vite dev",
  nestedRun: "npm run plain",

  // Non-server subcommands and pre-existing flags.
  build: "vite build",
  buildWrapped: "bunx vite build",
  modeBuild: "vite --mode build",
  hasPort: `${FRAMEWORK} --port 5555`,
  hasHost: `${FRAMEWORK} --host 0.0.0.0`,
  hasBoth: `${FRAMEWORK} --port 5555 --host 0.0.0.0`,
  hasPortEquals: `${FRAMEWORK} --port=5555`,

  // Other frameworks. The expo shapes carry a second obligation beyond flag
  // forwarding: see the framework-identity test below.
  expoPlain: "expo start",
  expoComment: "expo start --port 4567 # note",
  expoAndAnd: "expo start && echo done",
  expoRedirect: "expo start > out.log",
  expoBuild: "expo build",
  expoWrapped: "bunx expo start",
  expoExport: "expo export",
  expoServe: "expo serve",

  // Non-server subcommands: the framework CLI rejects the flags, not the shell.
  optimize: "vite optimize",
  optimizeWrapped: "bunx vite optimize",
  preview: "vite preview",
  bare: "vite",
  configValueFirst: "vite --config ./cfg.ts",
  modeValueIsServerName: "vite --mode dev build",
  modeValueShortFlag: "vite -m dev optimize",
  modeValueEquals: "vite --mode=dev build",

  dashDash: `${FRAMEWORK} -- --extra`,
};

const SHIMMED_BINARIES = ["vite", "expo", "next"];

/**
 * Every shape above that portless declines to inject into. Skipping is a
 * deliberate, documented outcome, so it cannot be asserted as a violation, and
 * an accidental skip has the same user-visible result as a lost flag: the
 * framework keeps its own port and the route 502s. Pinning the set makes the
 * difference reviewable. A fix that widens this list is over-reaching, which is
 * how an escaped space before a hash briefly stopped injection for
 * `--open /foo\ #bar`; a fix that narrows it is claiming new coverage and owes
 * a docs update.
 */
const EXPECTED_SKIPS = [
  "andand",
  "andandGlued",
  "background",
  "backtickStart",
  "braceGroup",
  "build",
  "buildWrapped",
  "comment",
  "commentAfterNewline",
  "commentOnly",
  "commentTight",
  "dashDash",
  "envPrefix",
  "envPrefixTwo",
  "execPrefix",
  "expoAndAnd",
  "expoBuild",
  "expoComment",
  "expoExport",
  "hasBoth",
  "hashAfterQuotedEnd",
  "hashAfterRedirect",
  "hashAfterTab",
  "lineContinuationComment",
  "multiSpaceComment",
  "modeValueEquals",
  "modeValueIsServerName",
  "modeValueShortFlag",
  "nestedRun",
  "newline",
  "optimize",
  "optimizeWrapped",
  "oror",
  "pipe",
  "redirectBoth",
  "semi",
  "semiGlued",
  "semiThenComment",
  "subshell",
  "substWordStart",
  "twoContinuations",
];

/**
 * Some shapes invoke a package runner by name. On a machine without that
 * runner the shim can never be reached, which is an environment limit and not
 * a verdict about the guard, so those cells are excluded rather than counted
 * either way. Excluding by requirement keeps the "shim never ran" assertion
 * meaningful for every cell that remains.
 */
function requiredBinary(script: string): string | null {
  const first = script.trim().split(/\s+/)[0];
  return ["bunx", "npx", "pnpx", "bun", "npm", "pnpm", "yarn"].includes(first) ? first : null;
}

function hasBinary(name: string): boolean {
  return spawnSync(name, ["--version"], { encoding: "utf-8" }).status === 0;
}

/**
 * The shell sweep needs a package manager and a POSIX shim. CI installs no bun,
 * so defaulting to bun alone would make this file skip entirely there: pick the
 * first runner actually present instead. Windows is a named coverage gap, not a
 * silent one; the shims are `#!/bin/sh` and `bun run` hands scripts to cmd.
 */
const requestedRunners = process.env.PORTLESS_DIFFERENTIAL_RUNNERS?.split(",")
  .map((r) => r.trim())
  .filter(Boolean);
const runners = isWindows
  ? []
  : (requestedRunners ?? ["bun", "pnpm", "npm"].filter(hasBinary).slice(0, 1)).filter(hasBinary);

describe("package script forwarding, against the shell", () => {
  let dir: string;
  let capturePath: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-differential-"));
    capturePath = path.join(dir, "capture.txt");
    // npx resolves node_modules/.bin before PATH, so the shim lives in both.
    for (const binDir of [path.join(dir, "bin"), path.join(dir, "node_modules", ".bin")]) {
      fs.mkdirSync(binDir, { recursive: true });
      for (const name of SHIMMED_BINARIES) {
        const shim = path.join(binDir, name);
        fs.writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" > "$PORTLESS_CAPTURE"\n`);
        fs.chmodSync(shim, 0o755);
      }
    }
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "portless-differential-fixture", scripts: SCRIPTS })
    );
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function runScript(runner: string, name: string, extra: string[]) {
    fs.rmSync(capturePath, { force: true });
    // Mirror portless's own convention: npm needs `--` before script arguments.
    const forwarded = runner === "npm" && extra.length > 0 ? ["--", ...extra] : extra;
    const result = spawnSync(runner, ["run", name, ...forwarded], {
      cwd: dir,
      encoding: "utf-8",
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
        PORTLESS_CAPTURE: capturePath,
      },
    });
    const delivered = fs.existsSync(capturePath)
      ? fs.readFileSync(capturePath, "utf-8").trim()
      : null;
    return { status: result.status, delivered };
  }

  /**
   * Which framework runs and whether portless may append to the script are
   * different questions, and the Expo LAN carve-out only needs the first: it
   * suppresses HOST, which breaks Metro's HMR websocket, and it must do so for
   * a script that supplies its own port and gets no injection at all. Answering
   * both questions with one nullable return is what broke this twice.
   *
   * Only the identity half is checkable here; that HOST is then actually
   * omitted is an end-to-end assertion and lives in cli.test.ts.
   */
  it("identifies the framework even in shapes it declines to touch", () => {
    const expoShapes = Object.keys(SCRIPTS).filter((n) => n.startsWith("expo"));
    // Every expo shape whose first token is literally `expo`, or a runner
    // wrapper portless understands, must resolve regardless of skip status.
    const resolved = Object.fromEntries(
      expoShapes.map((n) => [n, resolveFrameworkBasename(["bun", "run", n], dir)])
    );
    expect(resolved).toEqual({
      expoPlain: "expo",
      expoComment: "expo",
      expoAndAnd: "expo",
      expoRedirect: "expo",
      expoBuild: "expo",
      expoExport: "expo",
      expoServe: "expo",
      expoWrapped: "expo",
    });
  });

  it("declines exactly the documented set of script shapes", () => {
    const skipped = Object.keys(SCRIPTS).filter((name) => {
      const args = ["bun", "run", name];
      injectPackageScriptFrameworkFlags(args, 4567, dir);
      return args.length === 3;
    });
    expect(skipped.sort()).toEqual([...EXPECTED_SKIPS].sort());
  });

  it.skipIf(runners.length > 0)("names the platforms where the shell sweep did not run", () => {
    // A skipped sweep is reported, never mistaken for a pass.
    expect(isWindows || !hasBinary("bun")).toBe(true);
  });

  for (const runner of runners) {
    it(`never appends flags the ${runner} child does not receive`, () => {
      const violations: string[] = [];
      const unmeasured: string[] = [];

      for (const [name, script] of Object.entries(SCRIPTS)) {
        const needs = requiredBinary(script);
        if (needs && !hasBinary(needs)) continue;
        const args = [runner, "run", name];
        injectPackageScriptFrameworkFlags(args, 4567, dir);
        const injected = args.slice(3).filter((arg) => arg !== "--");
        if (injected.length === 0) continue;

        const { status, delivered } = runScript(runner, name, injected);
        if (delivered === null) {
          // The shim never ran: a resolution problem in the fixture, not a
          // verdict about the guard. Named rather than counted as a pass.
          unmeasured.push(`${name}: ${JSON.stringify(script)} (exit ${status})`);
          continue;
        }
        const missing = injected.filter((flag) => !delivered.includes(flag));
        if (missing.length > 0) {
          violations.push(
            `${name}: ${JSON.stringify(script)}\n    appended ${JSON.stringify(injected)}\n    child got ${JSON.stringify(delivered)}`
          );
        }
      }

      expect(unmeasured, `shim never ran for:\n  ${unmeasured.join("\n  ")}`).toEqual([]);
      expect(
        violations,
        `portless appended flags the shell discarded:\n  ${violations.join("\n  ")}`
      ).toEqual([]);
      // One child process per script shape; pnpm in particular is far slower
      // than vitest's default per-test budget.
    }, 180_000);
  }
});
