import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOOLS,
  PROFILES,
  buildArgv,
  parseToolsFlag,
  toToolResult,
  createServer,
  type ToolDef,
} from "./mcp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../dist/cli.js");

async function call(profiles: string[], method: string, params?: unknown) {
  const server = createServer(profiles);
  const res = await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  return res as {
    result: {
      tools: typeof TOOLS;
      content: { text: string }[];
      isError: boolean;
      structuredContent?: unknown;
      protocolVersion: string;
      serverInfo: { name: string };
      capabilities: unknown;
    };
    error?: { code: number; message: string };
  };
}

/** Valid arguments built from a tool's schema: true, 1, ["sample"], or "Sample". */
function sampleArgs(tool: ToolDef, requiredOnly: boolean): Record<string, unknown> {
  const required = tool.inputSchema.required ?? [];
  const args: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(tool.inputSchema.properties)) {
    if (["cwd", "extraArgs", "timeoutMs"].includes(key)) continue;
    if (requiredOnly && !required.includes(key)) continue;
    const { type } = schema as { type: string };
    args[key] =
      type === "boolean" ? true : type === "integer" ? 1 : type === "array" ? ["sample"] : "Sample";
  }
  return args;
}

const CHILD_TOOLS = TOOLS.filter((t) => t.name !== "tools_profiles");

describe("tool registry", () => {
  it("has unique names, each in a non-all profile, and buildArgv covers them", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    const inProfile = new Set<string>();
    for (const [name, p] of Object.entries(PROFILES)) {
      if (name !== "all" && p.tools !== "all") p.tools.forEach((t) => inProfile.add(t));
    }
    for (const name of names) {
      expect(inProfile.has(name)).toBe(true);
      if (name !== "tools_profiles") {
        expect(() =>
          buildArgv(name, sampleArgs(TOOLS.find((t) => t.name === name)!, true))
        ).not.toThrow();
      }
    }
  });
});

describe("buildArgv", () => {
  it.each([
    ["get", { name: "backend", noWorktree: true }, ["get", "backend", "--no-worktree"]],
    ["get", { name: "backend", noWorktree: false }, ["get", "backend"]],
    ["alias_add", { name: "db", port: 5432, force: true }, ["alias", "db", "5432", "--force"]],
    ["alias_remove", { name: "db" }, ["alias", "--remove", "db"]],
    [
      "proxy_start",
      { port: 1355, noTls: true, tld: ["test", "localhost"] },
      ["proxy", "start", "-p", "1355", "--no-tls", "--tld", "test", "--tld", "localhost"],
    ],
    ["version", {}, ["--version"]],
    ["list", { extraArgs: ["--x"], cwd: "/tmp", timeoutMs: 5 }, ["list", "--x"]],
    ["proxy_stop", { port: 1356 }, ["proxy", "stop", "-p", "1356"]],
    ["proxy_status", {}, ["proxy", "status"]],
    ["proxy_status", { json: true }, ["proxy", "status", "--json"]],
    ["prune", { force: true }, ["prune", "--force"]],
  ] as const)(
    "builds %s argv without cwd or timeoutMs and appends extraArgs last",
    (tool, args, argv) => {
      expect(buildArgv(tool, args)).toEqual(argv);
    }
  );

  it("rejects a flag-shaped name so it cannot become a CLI flag", () => {
    expect(() => buildArgv("alias_add", { name: "--remove", port: 5432 })).toThrow(
      expect.objectContaining({ code: -32602 })
    );
  });

  it("rejects --foreground for proxy start with -32602", () => {
    expect(() => buildArgv("proxy_start", { extraArgs: ["--foreground"] })).toThrow(
      expect.objectContaining({ code: -32602 })
    );
  });
});

describe("profiles", () => {
  it("parses the tools flag", () => {
    expect(parseToolsFlag(" core, ,proxy ")).toEqual(["core", "proxy"]);
    expect(parseToolsFlag("full")).toEqual(["all"]);
    expect(parseToolsFlag("default")).toEqual(["core"]);
    expect(() => parseToolsFlag("nope")).toThrow(/core/);
    expect(() => parseToolsFlag(" , ")).toThrow();
  });

  it("lists only enabled tools: default excludes proxy, core,proxy includes it", async () => {
    const names = async (p: string[]) =>
      (await call(p, "tools/list")).result.tools.map((t: { name: string }) => t.name);
    const core = await names(["core"]);
    expect(core).toContain("get");
    expect(core).not.toContain("proxy_start");
    expect(await names(["core", "proxy"])).toContain("proxy_start");
    expect(await names(["all"])).toHaveLength(TOOLS.length);
  });

  it("returns an error result for a disabled tool", async () => {
    const res = await call(["core"], "tools/call", { name: "proxy_start", arguments: {} });
    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("not enabled");
  });
});

describe("tools/call validation", () => {
  it("names sorted unknown keys and only the tool's own fields", async () => {
    const res = await call(["core"], "tools/call", {
      name: "get",
      arguments: { zeta: 1, alpha: 2, cwd: "/tmp", timeoutMs: 5, name: "x" },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("alpha, zeta");
    expect(res.result.content[0].text).toContain("Tool arguments: name, noWorktree");
    expect(res.result.content[0].text).not.toMatch(/Unknown argument\(s\)[^.]*cwd/);

    const none = await call(["core"], "tools/call", {
      name: "list",
      arguments: { bogus: 1 },
    });
    expect(none.result.isError).toBe(true);
    expect(none.result.content[0].text).toContain("Tool arguments: none");
  });

  it("returns -32602 for an unknown tool and -32700 for a non-JSON line", async () => {
    const unknown = await call(["core"], "tools/call", {
      name: "nope",
      arguments: {},
    });
    expect(unknown.error?.code).toBe(-32602);

    const malformed = await createServer(["core"]).handleLine("not json");
    expect(malformed?.id).toBeNull();
    expect((malformed?.error as { code: number }).code).toBe(-32700);
  });

  it("returns an error result when the child cannot spawn", async () => {
    const cwd = "/definitely/not/a/real/dir-portless-mcp";
    const res = await call(["core"], "tools/call", {
      name: "list",
      arguments: { cwd },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain(cwd);
  });

  it("rejects timeoutMs above the 32-bit maximum", async () => {
    const res = await call(["core"], "tools/call", {
      name: "list",
      arguments: { timeoutMs: 2147483648 },
    });
    expect(res.result.isError).toBe(true);
  });
});

describe("initialize and tools/list", () => {
  it("echoes a supported version and falls back to the latest", async () => {
    expect(
      (await call(["core"], "initialize", { protocolVersion: "2024-11-05" })).result.protocolVersion
    ).toBe("2024-11-05");
    const res = await call(["core"], "initialize", { protocolVersion: "1999-01-01" });
    expect(res.result.protocolVersion).toBe("2025-11-25");
    expect(res.result.serverInfo.name).toBe("portless");
    expect(res.result.capabilities).toEqual({ tools: {} });
  });

  it("rejects a bad cursor with -32602", async () => {
    for (const cursor of ["abc", "-1", "9999", 3]) {
      const res = await call(["core"], "tools/list", { cursor });
      expect(res.error?.code).toBe(-32602);
      expect(res.error?.message).toContain("Invalid tools/list cursor");
    }
  });
});

describe("toToolResult", () => {
  it("appends stderr, flags non-zero exit, and fills empty output", () => {
    const ok = toToolResult({ exitCode: 0, stdout: "hi\n", stderr: "" });
    expect(ok.content[0].text).toBe("hi");
    expect(ok.isError).toBe(false);

    const bad = toToolResult({ exitCode: 1, stdout: "out", stderr: "boom\n" });
    expect(bad.content[0].text).toBe("out\n\nstderr:\nboom");
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.exitCode).toBe(1);

    expect(toToolResult({ exitCode: 0, stdout: "", stderr: "" }).content[0].text).toBe(
      "(no output)"
    );
  });
});

/** Commands in `portless --help` that deliberately have no MCP tool. */
const OMITTED_COMMANDS: Record<string, string> = {
  portless: "zero-arg and named mode run foreground dev servers",
  "portless run": "runs a foreground dev server",
  "portless mcp": "the MCP server itself",
  "portless service install": "may prompt for sudo",
  "portless trust": "may prompt for sudo",
  "portless clean": "may prompt for sudo",
  "portless hosts sync": "may prompt for sudo",
  "portless hosts clean": "may prompt for sudo",
};

/** Leading command words and flags of a help line or argv, e.g. "alias --remove". */
function commandWords(tokens: string[]): string[] {
  const words: string[] = [];
  for (const token of tokens) {
    if (!/^(--)?[a-z][a-z-]*$/.test(token)) break;
    words.push(token);
  }
  return words;
}

function commandOf(tool: ToolDef): string[] {
  return commandWords(buildArgv(tool.name, sampleArgs(tool, true)));
}

function cliHelp(...args: string[]): string[] {
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: "1" };
  delete env.PNPM_SCRIPT_SRC_DIR;
  if (env.npm_command === "exec") delete env.npm_command;
  const res = spawnSync(process.execPath, [CLI_PATH, ...args, "--help"], {
    encoding: "utf-8",
    timeout: 10_000,
    env,
  });
  return res.stdout.split("\n").map((line) => line.trim());
}

describe("CLI coverage", () => {
  it("maps every command in portless --help to a tool or an omission", () => {
    const help = cliHelp();
    const start = help.indexOf("Usage:");
    const tools = new Set(CHILD_TOOLS.map((t) => ["portless", ...commandOf(t)].join(" ")));
    for (const line of help.slice(start + 1, help.indexOf("", start))) {
      const command = ["portless", ...commandWords(line.split(/\s+/).slice(1))].join(" ");
      expect(
        tools.has(command) || command in OMITTED_COMMANDS,
        `"${command}" is in --help but has no MCP tool. Add one in mcp.ts or list it as omitted.`
      ).toBe(true);
    }
  });

  it("types or deliberately rejects every flag a tool's --help lists", () => {
    const pages = new Map<string, ToolDef[]>();
    for (const tool of CHILD_TOOLS) {
      const [page] = commandOf(tool);
      if (!page.startsWith("-")) pages.set(page, [...(pages.get(page) ?? []), tool]);
    }
    for (const [page, tools] of pages) {
      for (const line of cliHelp(page)) {
        const words = line.startsWith("portless ") ? commandWords(line.split(/\s+/).slice(1)) : [];
        const owner = line.startsWith("-")
          ? tools.length === 1
            ? tools[0]
            : undefined
          : tools
              .filter((t) => commandOf(t).every((word, i) => words[i] === word))
              .sort((a, b) => commandOf(b).length - commandOf(a).length)[0];
        if (!owner) continue;
        const emitted = buildArgv(owner.name, sampleArgs(owner, false));
        for (const flag of line.match(/(?<=^|\s)(-p|--[a-z][a-z-]*)\b/g) ?? []) {
          if (flag === "--help" || emitted.includes(flag)) continue;
          expect(
            () => buildArgv(owner.name, { ...sampleArgs(owner, true), extraArgs: [flag] }),
            `"${flag}" is in "portless ${page} --help" but the ${owner.name} tool does not handle it. Type it in mcp.ts or reject it.`
          ).toThrow();
        }
      }
    }
  });
});

describe("portless mcp end to end", () => {
  it("answers over stdio and matches the CLI output", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-mcp-"));
    const env: Record<string, string | undefined> = {
      ...process.env,
      PORTLESS_STATE_DIR: stateDir,
      NO_COLOR: "1",
    };
    delete env.PNPM_SCRIPT_SRC_DIR;
    if (env.npm_command === "exec") delete env.npm_command;

    try {
      const cli = spawnSync(process.execPath, [CLI_PATH, "get", "backend", "--no-worktree"], {
        encoding: "utf-8",
        timeout: 10_000,
        env,
      });
      const expected = cli.stdout.trim();
      expect(expected).not.toBe("");

      const lines = [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "get", arguments: { name: "backend", noWorktree: true } },
        },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "get", arguments: { name: "backend", bogus: 1 } },
        },
        { jsonrpc: "2.0", id: 4, method: "shutdown" },
      ];

      const out = await new Promise<{ stdout: string; code: number | null }>((resolve, reject) => {
        const child = spawn(process.execPath, [CLI_PATH, "mcp"], {
          env: { ...env, PORTLESS: "0" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("mcp server did not exit"));
        }, 20_000);
        child.stdout.on("data", (d) => (stdout += d));
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ stdout, code });
        });
        child.stdin.write(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      });

      const responses = out.stdout
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
      expect(responses.map((r) => r.id)).toEqual([1, 2, 3, 4]);
      expect(responses[1].result.content[0].text).toBe(expected);
      expect(responses[2].error).toBeUndefined();
      expect(responses[2].result.isError).toBe(true);
      expect(responses[2].result.content[0].text).toContain("bogus");
      expect(out.code).toBe(0);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }, 40_000);
});
