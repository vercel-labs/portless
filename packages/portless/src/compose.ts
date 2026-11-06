/**
 * Docker Compose support. Pure planning lives here, process wiring in cli.ts.
 *
 * The approach: resolve the project with `docker compose config --format json`
 * (compose does interpolation, `extends`, `include`, and multi-file merges),
 * move each published HTTP port to a fixed loopback port kept per project,
 * run compose against the resolved model, then read the published ports back
 * from `docker compose ps` and register them as portless routes.
 */
import * as path from "node:path";
import { truncateLabel } from "./auto.js";

/** Compose global flags that take a value. */
const VALUE_FLAGS = new Set([
  "-f",
  "--file",
  "-p",
  "--project-name",
  "--profile",
  "--env-file",
  "--project-directory",
  "--ansi",
  "--progress",
  "--parallel",
]);

const BOOLEAN_FLAGS = new Set([
  "--help",
  "-h",
  "--version",
  "-v",
  "--dry-run",
  "--verbose",
  "--no-ansi",
  "--compatibility",
  "--all-resources",
]);

/** Global flags portless replaces when it runs compose on the resolved model. */
const REPLACED_FLAGS = new Set(["-f", "--file", "-p", "--project-name", "--project-directory"]);

/**
 * Container ports of common non-HTTP services. They keep their published port
 * so existing connection strings (DATABASE_URL=...:5432) keep working.
 */
const NON_HTTP_PORTS = new Set([
  1433, // SQL Server
  1521, // Oracle
  2181, // ZooKeeper
  3306, // MySQL, MariaDB
  4222, // NATS
  5432, // PostgreSQL
  5672, // RabbitMQ
  6379, // Redis, Valkey
  9042, // Cassandra
  9092, // Kafka
  11211, // Memcached
  26257, // CockroachDB
  27017, // MongoDB
]);

const LABEL_ENABLE = "portless.enable";
const LABEL_NAME = "portless.name";
const LABEL_PORTS = "portless.ports";

export interface ComposeArgs {
  /** Global compose flags, in order, e.g. ["-f", "compose.dev.yml"]. */
  globals: string[];
  subcommand: string | undefined;
  /** Arguments after the subcommand. */
  rest: string[];
}

/** Split `portless compose` arguments into global flags, subcommand, and the rest. */
export function splitComposeArgs(args: readonly string[]): ComposeArgs {
  const globals: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) break;
    globals.push(arg);
    if (VALUE_FLAGS.has(arg) && i + 1 < args.length) {
      globals.push(args[i + 1]!);
      i += 2;
    } else {
      i += 1;
    }
  }
  return { globals, subcommand: args[i], rest: args.slice(i + 1) };
}

/**
 * Report the first problem with a compose invocation's own global flags, or
 * null when they all parse. Used when there is no subcommand to hand to docker
 * compose, so a typo is a usage error instead of a printed help page.
 */
export function composeGlobalError(globals: readonly string[]): string | null {
  for (let i = 0; i < globals.length; i++) {
    const arg = globals[i]!;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (VALUE_FLAGS.has(flag)) {
      if (eq !== -1) {
        if (eq === arg.length - 1) return `${flag} requires a value.`;
        continue;
      }
      if (i + 1 >= globals.length) return `${flag} requires a value.`;
      i += 1;
      continue;
    }
    if (!BOOLEAN_FLAGS.has(flag)) return `Unknown flag "${flag}" for portless compose.`;
    if (eq !== -1) return `${flag} does not take a value.`;
  }
  return null;
}

/** Values of a global flag, in order. Handles `--flag=value`. */
function readGlobal(globals: readonly string[], names: readonly string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < globals.length; i++) {
    const arg = globals[i]!;
    const eq = arg.indexOf("=");
    if (eq > 0 && names.includes(arg.slice(0, eq))) {
      values.push(arg.slice(eq + 1));
    } else if (names.includes(arg) && i + 1 < globals.length) {
      values.push(globals[i + 1]!);
      i++;
    }
  }
  return values;
}

/** Whether the compose file is read from stdin (`-f -`). */
export function readsComposeFromStdin(globals: readonly string[]): boolean {
  return readGlobal(globals, ["-f", "--file"]).includes("-");
}

/** Project name passed with -p or --project-name, if any. */
export function explicitProject(globals: readonly string[]): string | undefined {
  return readGlobal(globals, ["-p", "--project-name"]).pop();
}

/**
 * Arguments that run `docker compose up` on the resolved model. The project
 * directory stays where compose would put it (the explicit flag, else the
 * first compose file's directory from -f or COMPOSE_FILE, else cwd), so
 * `.env` settings such as COMPOSE_PROFILES still apply.
 */
export function buildUpArgs(opts: {
  globals: readonly string[];
  rest: readonly string[];
  project: string;
  modelPath: string;
  cwd: string;
  /** COMPOSE_FILE from the environment, used when no -f is given. */
  composeFileEnv?: string;
  /** COMPOSE_PATH_SEPARATOR, or the platform default. */
  pathSeparator?: string;
}): string[] {
  const { globals } = opts;
  const firstFile =
    readGlobal(globals, ["-f", "--file"])[0] ??
    opts.composeFileEnv?.split(opts.pathSeparator ?? path.delimiter)[0] ??
    undefined;
  const projectDir =
    readGlobal(globals, ["--project-directory"]).pop() ??
    (firstFile && firstFile !== "-" ? path.dirname(path.resolve(opts.cwd, firstFile)) : opts.cwd);
  const kept: string[] = [];
  for (let i = 0; i < globals.length; i++) {
    const arg = globals[i]!;
    const eq = arg.indexOf("=");
    if (eq > 0 && REPLACED_FLAGS.has(arg.slice(0, eq))) continue;
    if (REPLACED_FLAGS.has(arg)) {
      i++;
      continue;
    }
    kept.push(arg);
  }
  return [
    "-p",
    opts.project,
    "--project-directory",
    projectDir,
    "-f",
    opts.modelPath,
    ...kept,
    "up",
    ...opts.rest,
  ];
}

/** Whether `up` arguments leave compose running in the foreground. */
export function isDetachedUp(rest: readonly string[]): boolean {
  return rest.some((a) => a === "-d" || a === "--detach" || a === "--wait" || a === "--wait=true");
}

export interface ComposePort {
  target: number;
  published?: string;
  host_ip?: string;
  protocol?: string;
  [key: string]: unknown;
}

export interface ComposeService {
  ports?: ComposePort[];
  network_mode?: string;
  labels?: Record<string, string>;
  environment?: Record<string, string | null>;
  [key: string]: unknown;
}

export interface ComposeModel {
  name: string;
  services: Record<string, ComposeService>;
  [key: string]: unknown;
}

export interface ComposeRoute {
  service: string;
  target: number;
  /** Every hostname of the route, one per configured TLD. The first is primary. */
  hostnames: string[];
  url: string;
}

export interface KeptPort {
  service: string;
  target: number;
  published: string | undefined;
  reason: string;
  /** The binding was removed from the model instead of kept. */
  dropped?: boolean;
}

export interface ComposePlan {
  /** Compose project name, as compose resolved it. */
  project: string;
  /** Resolved model to run, with routed ports moved to loopback ports from `portFor`. */
  model: ComposeModel;
  routes: ComposeRoute[];
  kept: KeptPort[];
}

export interface PlanOptions {
  /** Expand a route name like "api.shop" into its hostnames. Throws on invalid names. */
  hostnamesFor: (name: string) => string[];
  urlFor: (hostname: string) => string;
  /** Value for __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS, e.g. ".localhost". */
  viteAllowedHosts: string;
  /**
   * Fixed host port for a routed container port. A fixed port survives
   * container restarts, so routes never drift. Without one, compose assigns an
   * ephemeral port.
   */
  portFor?: (service: string, target: number) => number | undefined;
}

/** Turn a compose project or service name into a DNS label. */
function toLabel(name: string): string {
  return truncateLabel(
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
  );
}

/** Suffix shared by every route of a project, e.g. "shop" for "api.shop". */
export function projectLabel(project: string): string {
  return toLabel(project);
}

interface ServiceSettings {
  enabled: boolean;
  name?: string;
  ports?: number[];
}

/** Per-service settings from labels. Labels survive `config --format json`; `x-` keys in a service do not. */
function readServiceSettings(service: string, svc: ComposeService): ServiceSettings {
  const labels = svc.labels ?? {};
  const enable = labels[LABEL_ENABLE]?.trim().toLowerCase();
  const settings: ServiceSettings = { enabled: enable !== "false" && enable !== "0" };

  const name = labels[LABEL_NAME]?.trim();
  if (name) {
    const label = toLabel(name);
    if (!label) {
      throw new Error(`${service}: ${LABEL_NAME} "${name}" is not a valid hostname label.`);
    }
    settings.name = label;
  }

  const ports = labels[LABEL_PORTS]?.trim();
  if (ports) {
    settings.ports = ports.split(",").map((raw) => {
      const port = Number(raw.trim());
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${service}: ${LABEL_PORTS} has an invalid port "${raw.trim()}".`);
      }
      return port;
    });
  }
  return settings;
}

/**
 * Plan a resolved compose model. Every published TCP port moves to 127.0.0.1,
 * on the port from `portFor` (ephemeral without one), and gets a route `<service>.<project>`. A service
 * with several routed ports gets `<service>.<project>` for the first and
 * `<port>.<service>.<project>` for each of them. Routed services get the Vite
 * allowed-hosts variable so a dev server in a container accepts its hostname.
 */
export function planCompose(model: ComposeModel, opts: PlanOptions): ComposePlan {
  const project = projectLabel(model.name);
  const routes: ComposeRoute[] = [];
  const kept: KeptPort[] = [];
  const services: Record<string, ComposeService> = {};
  const seen = new Map<string, string>();

  for (const [service, svc] of Object.entries(model.services ?? {})) {
    const ports = svc.ports ?? [];
    const keepAll = (reason: string): void => {
      for (const p of ports)
        kept.push({ service, target: p.target, published: p.published, reason });
      services[service] = svc;
    };
    if (ports.length === 0) {
      services[service] = svc;
      continue;
    }
    if (svc.network_mode === "host") {
      keepAll("host network");
      continue;
    }
    const settings = readServiceSettings(service, svc);
    if (!settings.enabled) {
      keepAll(`${LABEL_ENABLE}=false`);
      continue;
    }
    if (settings.ports) {
      const missing = settings.ports.filter((p) => !ports.some((q) => q.target === p));
      if (missing.length > 0) {
        throw new Error(
          `${service}: ${LABEL_PORTS} lists ${missing.join(", ")}, but the service does not publish ${missing.length > 1 ? "them" : "it"}.`
        );
      }
    }

    const routedTargets: number[] = [];
    const nextPorts: ComposePort[] = [];
    for (const p of ports) {
      const keep = (reason: string): void => {
        kept.push({ service, target: p.target, published: p.published, reason });
        nextPorts.push(p);
      };
      if ((p.protocol ?? "tcp") !== "tcp") keep(p.protocol ?? "udp");
      else if (settings.ports && !settings.ports.includes(p.target)) keep(`not in ${LABEL_PORTS}`);
      else if (!settings.ports && NON_HTTP_PORTS.has(p.target)) keep("not HTTP");
      else if (routedTargets.includes(p.target)) {
        // One loopback binding serves the route. Extra bindings of the same
        // target (0.0.0.0 and :: on one port, or a second host port) are dropped
        // so their fixed host port cannot collide with another project.
        kept.push({
          service,
          target: p.target,
          published: p.published,
          reason: "the container port is already routed",
          dropped: true,
        });
      } else {
        routedTargets.push(p.target);
        const { published: _published, ...rest } = p;
        const port = opts.portFor?.(service, p.target);
        nextPorts.push({
          ...rest,
          host_ip: "127.0.0.1",
          ...(port === undefined ? {} : { published: String(port) }),
        });
      }
    }

    const label = settings.name ?? toLabel(service);
    routedTargets.forEach((target, index) => {
      const subs = routedTargets.length > 1 ? [`${target}.${label}`] : [];
      if (index === 0) subs.unshift(label);
      for (const sub of subs) {
        const name = `${sub}.${project}`;
        const owner = seen.get(name);
        if (owner && owner !== service) {
          throw new Error(
            `Services "${owner}" and "${service}" both map to ${name}. Rename one of them.`
          );
        }
        seen.set(name, service);
        const hostnames = opts.hostnamesFor(name);
        routes.push({
          service,
          target,
          hostnames,
          url: opts.urlFor(hostnames[0]!),
        });
      }
    });

    const environment = { ...(svc.environment ?? {}) };
    if (routedTargets.length > 0 && !("__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS" in environment)) {
      environment.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = opts.viteAllowedHosts;
    }
    services[service] = { ...svc, ports: nextPorts, environment };
  }

  return { project: model.name, model: { ...model, services }, routes, kept };
}

export interface ComposeContainers {
  /** Compose project names seen, in order. */
  projects: string[];
  /** Host ports published by running containers, keyed by "service:target". */
  ports: Map<string, number>;
}

/**
 * Parse `docker compose ps --format json`. Compose v2.21+ prints one JSON
 * object per line; older versions print a single array.
 */
export function parseContainers(output: string): ComposeContainers {
  const result: ComposeContainers = { projects: [], ports: new Map() };
  const trimmed = output.trim();
  if (!trimmed) return result;
  const rows = (
    trimmed.startsWith("[")
      ? JSON.parse(trimmed)
      : trimmed
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line))
  ) as Array<{
    Project?: string;
    Service?: string;
    State?: string;
    Publishers?: Array<{ TargetPort?: number; PublishedPort?: number; Protocol?: string }>;
  }>;
  for (const r of rows) {
    if (r.Project && !result.projects.includes(r.Project)) result.projects.push(r.Project);
    if (!r.Service || (r.State && r.State !== "running")) continue;
    for (const p of r.Publishers ?? []) {
      if (!p.PublishedPort || !p.TargetPort || (p.Protocol ?? "tcp") !== "tcp") continue;
      const key = `${r.Service}:${p.TargetPort}`;
      if (!result.ports.has(key)) result.ports.set(key, p.PublishedPort);
    }
  }
  return result;
}

/** Host port of a route, or undefined while its container is not running. */
export function routePort(route: ComposeRoute, containers: ComposeContainers): number | undefined {
  return containers.ports.get(`${route.service}:${route.target}`);
}

/**
 * Aliases to remove after `docker compose down`: the project's aliases whose
 * port no longer belongs to a running container. Routes of services that stay
 * up (unselected services, profiles that were not enabled) are kept.
 */
export function staleAliases(
  aliases: ReadonlyArray<{ hostname: string; port: number }>,
  project: string,
  tlds: readonly string[],
  containers: ComposeContainers
): string[] {
  const suffixes = tlds.map((tld) => `.${projectLabel(project)}.${tld}`);
  const live = new Set(containers.ports.values());
  return aliases
    .filter((a) => suffixes.some((s) => a.hostname.endsWith(s)) && !live.has(a.port))
    .map((a) => a.hostname);
}

export interface PortAllocation {
  /** Lowest and highest port to hand out. */
  min: number;
  max: number;
  /** Ports this project's running containers publish. A stored port among them is still ours. */
  ours: ReadonlySet<number>;
  /** Ports saved by other projects. A stopped project's port is free on the host but not ours to take. */
  reserved: ReadonlySet<number>;
  isFree: (port: number) => Promise<boolean>;
  /** Start offset into the range, in [0, 1). Random by default. */
  random?: () => number;
}

/**
 * Fixed host ports for routed container ports, keyed like "service:target".
 * A stored port is reused while it is ours or free; new ports skip ports that
 * other projects saved.
 */
export async function allocatePorts(
  keys: readonly string[],
  stored: Readonly<Record<string, number>>,
  opts: PortAllocation
): Promise<Map<string, number>> {
  const ports = new Map<string, number>();
  const taken = new Set<number>();
  const size = opts.max - opts.min + 1;
  for (const key of keys) {
    const previous = stored[key];
    if (
      previous !== undefined &&
      !taken.has(previous) &&
      !opts.reserved.has(previous) &&
      (opts.ours.has(previous) || (await opts.isFree(previous)))
    ) {
      ports.set(key, previous);
      taken.add(previous);
      continue;
    }
    const start = Math.floor((opts.random ?? Math.random)() * size);
    let port: number | undefined;
    for (let i = 0; i < size && port === undefined; i++) {
      const candidate = opts.min + ((start + i) % size);
      if (taken.has(candidate) || opts.reserved.has(candidate)) continue;
      if (await opts.isFree(candidate)) port = candidate;
    }
    if (port === undefined) throw new Error(`No free port found in range ${opts.min}-${opts.max}.`);
    ports.set(key, port);
    taken.add(port);
  }
  return ports;
}
