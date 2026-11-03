/**
 * Stdio MCP server for portless: a thin translator that runs the portless CLI
 * for each tool call.
 *
 * Intentionally omitted: run, <name> <cmd>, --name, and zero-arg mode
 * (foreground dev servers with no detached form), proxy start --foreground
 * (blocks), trust, clean, hosts sync, hosts clean, and service (may prompt for
 * sudo or need a TTY), plus mcp and --help (the server itself and human help).
 */

declare const __VERSION__: string;

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import colors from "./colors.js";
import { isWindows, killTree } from "./cli-utils.js";

const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_TIMEOUT_MS = 120000;
const PAGE_SIZE = 64;

const SHARED_PROPERTIES: Record<string, unknown> = {
  cwd: {
    type: "string",
    description:
      "Working directory for the command (decides the app name and worktree prefix). Defaults to the server's working directory.",
  },
  extraArgs: {
    type: "array",
    items: { type: "string" },
    description: "Arguments appended verbatim after the typed arguments.",
  },
  timeoutMs: {
    type: "integer",
    minimum: 1,
    maximum: 2147483647,
    default: DEFAULT_TIMEOUT_MS,
    description: "Timeout in milliseconds.",
  },
};

const SHARED_FIELDS = Object.keys(SHARED_PROPERTIES);

export class McpError extends Error {
  constructor(
    public code: number,
    message: string
  ) {
    super(message);
    this.name = "McpError";
  }
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

function tool(
  name: string,
  title: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  annotations: ToolDef["annotations"],
  inProcess = false
): ToolDef {
  const inputSchema: ToolDef["inputSchema"] = {
    type: "object",
    properties: inProcess ? { ...properties } : { ...properties, ...SHARED_PROPERTIES },
    additionalProperties: false,
  };
  if (required.length > 0) inputSchema.required = required;
  return {
    name,
    title,
    description,
    inputSchema,
    annotations,
  };
}

const NAME_PROPERTY = { type: "string", description: "App or alias name." };
const PORT_PROPERTY = {
  type: "integer",
  minimum: 1,
  maximum: 65535,
  description: "Port number.",
};

/** Every tool, in tools/list order. */
export const TOOLS: ToolDef[] = [
  tool(
    "list",
    "List routes",
    "List active routes with their URLs, ports, PIDs, and uptime.",
    {},
    [],
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }
  ),
  tool(
    "get",
    "Get app URL",
    "Print the URL for an app name, using the same hostname and worktree logic as portless run. The app does not need to be running.",
    {
      name: NAME_PROPERTY,
      noWorktree: {
        type: "boolean",
        description: "Skip worktree prefix detection.",
      },
    },
    ["name"],
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }
  ),
  tool(
    "alias_add",
    "Add alias",
    "Register a static route for a service portless does not run, such as a database.",
    {
      name: NAME_PROPERTY,
      port: PORT_PROPERTY,
      force: {
        type: "boolean",
        description:
          "Replace an existing route with the same name. If a running app owns it, that app is stopped.",
      },
    },
    ["name", "port"],
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    }
  ),
  tool(
    "alias_remove",
    "Remove alias",
    "Remove a static route registered with alias add.",
    { name: NAME_PROPERTY },
    ["name"],
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    }
  ),
  tool(
    "tools_profiles",
    "Show tool profiles",
    "Show the active tool profiles and other profiles you can enable.",
    {},
    [],
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    true
  ),
  tool(
    "proxy_start",
    "Start proxy",
    'Start the shared portless proxy as a background daemon. Without port, HTTPS uses 443 which may need sudo; MCP cannot answer a sudo prompt, so pass unprivileged for a port below 1024 without sudo, or port (for example 1355). HTTPS may show an OS dialog to trust the local CA; pass extraArgs ["--skip-trust"] to skip it.',
    {
      port: PORT_PROPERTY,
      noTls: { type: "boolean", description: "Serve plain HTTP instead of HTTPS." },
      lan: { type: "boolean", description: "Expose the proxy on the local network." },
      tld: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description: "One or more TLDs to serve.",
      },
      wildcard: {
        type: "boolean",
        description: "Allow unregistered subdomains to fall back to their parent route.",
      },
      unprivileged: {
        type: "boolean",
        description:
          "Take a port below 1024 without sudo: bind the wildcard address and accept loopback peers only. Serves plain HTTP on port 80 unless HTTPS is requested, and turns off hosts sync.",
      },
      bindAll: {
        type: "boolean",
        description:
          "Listen on every network interface and accept peers other than this machine, such as Docker containers, keeping the TLD and skipping mDNS. Every route becomes reachable by any machine that can reach this host.",
      },
    },
    [],
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    }
  ),
  tool(
    "proxy_stop",
    "Stop proxy",
    "Stop the shared portless proxy. Pass port when the proxy runs on a non-default port.",
    { port: PORT_PROPERTY },
    [],
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    }
  ),
  tool(
    "doctor",
    "Run doctor",
    "Check local portless health, including the proxy, certificates, and routes.",
    {},
    [],
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }
  ),
  tool(
    "prune",
    "Prune servers",
    "Kill orphaned dev servers left by crashed sessions.",
    {
      force: {
        type: "boolean",
        description: "Send SIGKILL instead of SIGTERM.",
      },
    },
    [],
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    }
  ),
  tool("version", "Print version", "Print the portless version.", {}, [], {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }),
];

/** Profile name -> description and tool names. `all` has tools: "all". Aliases are not keys here. */
export const PROFILES: Record<string, { description: string; tools: string[] | "all" }> = {
  core: {
    description: "Everyday route lookup and static aliases.",
    tools: ["list", "get", "alias_add", "alias_remove", "tools_profiles"],
  },
  proxy: {
    description: "Start and stop the shared portless proxy.",
    tools: ["proxy_start", "proxy_stop"],
  },
  diagnostics: {
    description: "Health checks, cleanup, and version information.",
    tools: ["doctor", "prune", "version"],
  },
  all: {
    description: "Every available tool.",
    tools: "all",
  },
};

const PROFILE_ALIASES: Record<string, string> = { default: "core", full: "all" };

const VALID_PROFILES = "core, proxy, diagnostics, all (aliases: default = core, full = all)";

/** Parse a --tools value into canonical profile names (aliases resolved). */
export function parseToolsFlag(value: string): string[] {
  const requested = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (requested.length === 0) {
    throw new Error(`No tools profiles given. Valid profiles: ${VALID_PROFILES}.`);
  }
  const resolved: string[] = [];
  const unknown: string[] = [];
  for (const name of requested) {
    const canonical = PROFILE_ALIASES[name] ?? name;
    if (!(canonical in PROFILES)) {
      unknown.push(name);
      continue;
    }
    if (!resolved.includes(canonical)) resolved.push(canonical);
  }
  if (unknown.length > 0) {
    throw new Error(
      `Unknown tools profile: ${unknown.join(", ")}. Valid profiles: ${VALID_PROFILES}.`
    );
  }
  return resolved;
}

function fail(message: string): never {
  throw new McpError(-32602, message);
}

function readString(
  args: Record<string, unknown>,
  key: string,
  required: boolean
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (required) fail(`${key} is required`);
    return undefined;
  }
  if (typeof value !== "string") fail(`${key} must be a string`);
  return value;
}

function readRequiredName(args: Record<string, unknown>, key: string): string {
  const value = readString(args, key, true);
  if (value === undefined || value.length === 0) fail(`${key} must not be empty`);
  if (value.startsWith("-")) fail(`${key} must not start with "-"`);
  return value;
}

function readBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") fail(`${key} must be a boolean`);
  return value;
}

function readPort(
  args: Record<string, unknown>,
  key: string,
  required: boolean
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (required) fail(`${key} is required`);
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    fail(`${key} must be an integer between 1 and 65535`);
  }
  return value;
}

function readStringArray(args: Record<string, unknown>, key: "extraArgs" | "tld"): string[] {
  const value = args[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || (key === "tld" && value.length === 0)) {
    fail(key === "tld" ? "tld must not be empty" : "extraArgs must be an array");
  }
  return value.map((item, index) => {
    if (typeof item !== "string") fail(`${key}[${index}] must be a string`);
    return item;
  });
}

function validateShared(args: Record<string, unknown>): string[] {
  const cwd = readString(args, "cwd", false);
  if (cwd !== undefined && cwd.length === 0) fail("cwd must not be empty");
  const extraArgs = readStringArray(args, "extraArgs");
  const timeout = args.timeoutMs;
  if (timeout !== undefined && timeout !== null) {
    if (
      typeof timeout !== "number" ||
      !Number.isInteger(timeout) ||
      timeout < 1 ||
      timeout > 2147483647
    ) {
      fail("timeoutMs must be a positive integer up to 2147483647");
    }
  }
  return extraArgs;
}

/** Build the CLI argv (without node/script path, without cwd/timeoutMs) for a child-run tool. */
export function buildArgv(toolName: string, args: Record<string, unknown>): string[] {
  const extraArgs = validateShared(args);
  const argv: string[] = [];

  switch (toolName) {
    case "list":
      argv.push("list");
      break;
    case "get": {
      const name = readRequiredName(args, "name");
      argv.push("get", name);
      if (readBoolean(args, "noWorktree") === true) argv.push("--no-worktree");
      break;
    }
    case "alias_add": {
      const name = readRequiredName(args, "name");
      const port = readPort(args, "port", true);
      argv.push("alias", name, String(port));
      if (readBoolean(args, "force") === true) argv.push("--force");
      break;
    }
    case "alias_remove": {
      const name = readRequiredName(args, "name");
      argv.push("alias", "--remove", name);
      break;
    }
    case "tools_profiles":
      break;
    case "proxy_start": {
      const port = readPort(args, "port", false);
      if (extraArgs.includes("--foreground")) {
        fail(
          "extraArgs must not include --foreground because the foreground proxy would block the call"
        );
      }
      argv.push("proxy", "start");
      if (port !== undefined) argv.push("-p", String(port));
      if (readBoolean(args, "noTls") === true) argv.push("--no-tls");
      if (readBoolean(args, "lan") === true) argv.push("--lan");
      for (const tld of readStringArray(args, "tld")) argv.push("--tld", tld);
      if (readBoolean(args, "wildcard") === true) argv.push("--wildcard");
      if (readBoolean(args, "unprivileged") === true) argv.push("--unprivileged");
      if (readBoolean(args, "bindAll") === true) argv.push("--bind-all");
      break;
    }
    case "proxy_stop": {
      const port = readPort(args, "port", false);
      argv.push("proxy", "stop");
      if (port !== undefined) argv.push("-p", String(port));
      break;
    }
    case "doctor":
      argv.push("doctor");
      break;
    case "prune":
      argv.push("prune");
      if (readBoolean(args, "force") === true) argv.push("--force");
      break;
    case "version":
      argv.push("--version");
      break;
    default:
      fail(`Unknown tool: ${toolName}`);
  }

  argv.push(...extraArgs);
  return argv;
}

export function toToolResult(run: { exitCode: number | null; stdout: string; stderr: string }): {
  content: { type: "text"; text: string }[];
  structuredContent: { exitCode: number | null; stdout: string; stderr: string };
  isError: boolean;
} {
  const stdout = run.stdout.trim();
  const stderr = run.stderr.trim();
  let text = stdout;
  if (stderr.length > 0)
    text = text.length > 0 ? `${text}\n\nstderr:\n${stderr}` : `stderr:\n${stderr}`;
  if (text.length === 0) text = "(no output)";
  return {
    content: [{ type: "text", text }],
    structuredContent: { exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr },
    isError: run.exitCode !== 0,
  };
}

function runChild(
  argv: string[],
  cwd: string,
  timeoutMs: number
): Promise<{ exitCode: number | null; stdout: string; stderr: string } | { spawnError: string }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
    delete env.FORCE_COLOR;
    delete env.PORTLESS;

    const child = spawn(process.execPath, [process.argv[1], ...argv], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: !isWindows,
      windowsHide: true,
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGKILL");
      finish(null);
    }, timeoutMs);

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = stripVTControlCharacters(Buffer.concat(out).toString("utf8"));
      let stderr = stripVTControlCharacters(Buffer.concat(err).toString("utf8"));
      if (timedOut) {
        const note = `portless command timed out after ${timeoutMs}ms`;
        stderr = stderr.trim().length > 0 ? `${stderr.trimEnd()}\n${note}` : note;
      }
      resolve({ exitCode: timedOut ? null : code, stdout, stderr });
    };

    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ spawnError: error.message });
    });
    child.on("close", finish);
  });
}

function toolErrorResult(message: string): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  return { content: [{ type: "text", text: message }], isError: true };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorResponse(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function resultResponse(id: unknown, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

/** A server for the given canonical profile names. */
export function createServer(profiles: string[]): {
  handleLine(line: string): Promise<Record<string, unknown> | null>;
  readonly shutdown: boolean;
} {
  let shutdown = false;
  const enabled = new Set<string>();
  for (const profileName of profiles) {
    const profile = PROFILES[profileName];
    if (!profile) continue;
    if (profile.tools === "all") {
      for (const def of TOOLS) enabled.add(def.name);
    } else {
      for (const name of profile.tools) enabled.add(name);
    }
  }

  async function handleRequest(
    message: Record<string, unknown>
  ): Promise<Record<string, unknown> | null> {
    const id = message.id;
    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    const method = message.method;
    if (typeof method !== "string") {
      return hasId ? errorResponse(id, -32600, "Invalid request: missing method") : null;
    }
    if (!hasId) return null;

    const params = message.params;

    switch (method) {
      case "initialize": {
        if (params !== undefined && !isObject(params)) {
          return errorResponse(id, -32602, "params must be an object");
        }
        const requested = params?.protocolVersion;
        if (requested !== undefined && typeof requested !== "string") {
          return errorResponse(id, -32602, "protocolVersion must be a string");
        }
        const version =
          typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : PROTOCOL_VERSIONS[0];
        const lookup: string[] = [];
        if (enabled.has("get")) lookup.push("the get tool to find an app's URL");
        if (enabled.has("list")) lookup.push("the list tool to see active routes");
        const instructions = [
          `Portless MCP server. Active profiles: ${profiles.join(", ")}.`,
          lookup.length > 0 ? `Use ${lookup.join(", ")}.` : "",
          "Start dev servers with `portless run <cmd>` in a shell; MCP does not run them.",
          enabled.has("tools_profiles")
            ? "Call the tools_profiles tool to see other tool profiles."
            : "",
        ]
          .filter((part) => part.length > 0)
          .join(" ");
        return resultResponse(id, {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: "portless", title: "Portless", version: VERSION },
          instructions,
        });
      }
      case "ping":
        return resultResponse(id, {});
      case "tools/list": {
        if (params !== undefined && !isObject(params)) {
          return errorResponse(id, -32602, "params must be an object");
        }
        const cursor = params?.cursor;
        const page = TOOLS.filter((def) => enabled.has(def.name));
        let start = 0;
        if (cursor !== undefined && cursor !== null) {
          if (typeof cursor !== "string" || !/^\d+$/.test(cursor)) {
            return errorResponse(id, -32602, "Invalid tools/list cursor");
          }
          start = Number(cursor);
          if (start > page.length) {
            return errorResponse(id, -32602, "Invalid tools/list cursor");
          }
        }
        const slice = page.slice(start, start + PAGE_SIZE);
        const result: Record<string, unknown> = { tools: slice };
        if (start + PAGE_SIZE < page.length) result.nextCursor = String(start + PAGE_SIZE);
        return resultResponse(id, result);
      }
      case "tools/call": {
        if (!isObject(params)) {
          return errorResponse(id, -32602, "params must be an object");
        }
        if (typeof params.name !== "string") {
          return errorResponse(id, -32602, "params.name must be a string");
        }
        const toolName = params.name;
        const rawArgs = params.arguments;
        if (rawArgs !== undefined && rawArgs !== null && !isObject(rawArgs)) {
          return errorResponse(id, -32602, "tool arguments must be an object");
        }
        const args = rawArgs ?? {};
        const def = TOOLS.find((tool) => tool.name === toolName);
        if (!def) return errorResponse(id, -32602, `Unknown tool: ${toolName}`);
        if (!enabled.has(toolName)) {
          return resultResponse(
            id,
            toolErrorResult(
              `Tool ${toolName} is not enabled. Restart with portless mcp --tools all or add a profile that includes it.`
            )
          );
        }

        const accepted = Object.keys(def.inputSchema.properties);
        const unknown = Object.keys(args)
          .filter((key) => !accepted.includes(key))
          .sort();
        if (unknown.length > 0) {
          const own = accepted.filter((key) => !SHARED_FIELDS.includes(key)).join(", ") || "none";
          return resultResponse(
            id,
            toolErrorResult(
              `Unknown argument(s) for ${toolName}: ${unknown.join(", ")}. Tool arguments: ${own}.`
            )
          );
        }

        try {
          if (toolName === "tools_profiles") {
            const summaries = Object.entries(PROFILES).map(([name, profile]) => ({
              name,
              description: profile.description,
              toolCount: profile.tools === "all" ? TOOLS.length : profile.tools.length,
              usage: `portless mcp --tools ${name}`,
            }));
            const text = [
              `Active profiles: ${profiles.join(", ")}`,
              ...summaries.map(
                (profile) =>
                  `${profile.name}: ${profile.description} (${profile.toolCount} tools), ${profile.usage}`
              ),
            ].join("\n");
            return resultResponse(id, {
              content: [{ type: "text", text }],
              structuredContent: { activeProfiles: profiles, profiles: summaries },
              isError: false,
            });
          }
          const argv = buildArgv(toolName, args);
          const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
          const timeoutMs =
            typeof args.timeoutMs === "number" ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
          const run = await runChild(argv, cwd, timeoutMs);
          if ("spawnError" in run) {
            return resultResponse(
              id,
              toolErrorResult(`Failed to run portless in ${cwd}: ${run.spawnError}`)
            );
          }
          return resultResponse(id, toToolResult(run));
        } catch (error) {
          if (error instanceof McpError && error.code === -32602) {
            return resultResponse(id, toolErrorResult(error.message));
          }
          if (error instanceof McpError) {
            return errorResponse(id, error.code, error.message);
          }
          return errorResponse(id, -32603, `Failed to run portless: ${(error as Error).message}`);
        }
      }
      case "shutdown": {
        shutdown = true;
        return resultResponse(id, {});
      }
      default:
        return errorResponse(id, -32601, `Method not found: ${method}`);
    }
  }

  return {
    async handleLine(line: string): Promise<Record<string, unknown> | null> {
      if (line.trim().length === 0) return null;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch (error) {
        return errorResponse(null, -32700, `Parse error: ${(error as Error).message}`);
      }
      if (!isObject(message)) {
        return null;
      }
      return handleRequest(message);
    },
    get shutdown() {
      return shutdown;
    },
  };
}

export function printMcpHelp(): void {
  process.stdout.write(
    [
      "Usage: portless mcp [--tools <profiles>]",
      "",
      "Start a Model Context Protocol server over stdio. The client launches this",
      "process and exchanges newline-delimited JSON-RPC messages on stdin/stdout;",
      "stdout carries only protocol messages and diagnostics go to stderr.",
      "",
      "Profiles:",
      ...Object.entries(PROFILES).map(
        ([name, profile]) => `  ${name.padEnd(13)}${profile.description}`
      ),
      "",
      "Common tools:",
      "  list            List active routes.",
      "  get             Print an app URL.",
      "  alias_add       Register a static route.",
      "  tools_profiles  Show active and available profiles.",
      "",
      "Pass --tools with a comma separated list of profiles. The default is core.",
      "Aliases: default = core, full = all. Use the extraArgs argument on any tool",
      "to append CLI flags that are not typed into the tool schema.",
      "",
      "Environment:",
      "  PORTLESS_STATE_DIR  Directory for portless state.",
      "  PORTLESS_PORT       Default proxy port.",
      "  PORTLESS_TLD        Default TLD or comma separated TLD list.",
      "",
      "Client config:",
      '  {"mcpServers":{"portless":{"command":"portless","args":["mcp"]}}}',
      '  {"mcpServers":{"portless":{"command":"portless","args":["mcp","--tools","all"]}}}',
      "",
    ].join("\n")
  );
}

export async function runMcp(args: string[]): Promise<void> {
  let toolsValue: string | undefined;

  const usageError = (message: string): void => {
    console.error(colors.red(`Error: ${message}`));
    console.error("Usage: portless mcp [--tools <profiles>]");
    process.exit(1);
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      printMcpHelp();
      return;
    }
    if (arg === "--tools") {
      if (index + 1 >= args.length) usageError("--tools requires a value");
      toolsValue = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--tools=")) {
      toolsValue = arg.slice("--tools=".length);
      continue;
    }
    usageError(`Unknown argument: ${arg}`);
  }

  let profiles: string[];
  try {
    profiles = toolsValue === undefined ? ["core"] : parseToolsFlag(toolsValue);
  } catch (error) {
    usageError((error as Error).message);
    return;
  }

  const server = createServer(profiles);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const onStreamError = (): void => rl.close();
  process.stdout.on("error", onStreamError);

  for await (const line of rl) {
    const response = await server.handleLine(line);
    if (response !== null) {
      try {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      } catch {
        break;
      }
    }
    if (server.shutdown) break;
  }
  rl.close();
  process.stdout.off("error", onStreamError);
}
