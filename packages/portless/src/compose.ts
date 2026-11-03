/**
 * Docker Compose support. Pure planning lives here, process wiring in cli.ts.
 *
 * The approach: resolve the project with `docker compose config --format json`
 * (compose does interpolation, `extends`, `include`, and multi-file merges),
 * move each published HTTP port to an ephemeral loopback port, run compose
 * against the resolved model, then read the assigned ports back from
 * `docker compose ps` and register them as portless routes.
 */
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

/** Global flags portless replaces when it runs compose on the resolved model. */
const REPLACED_FLAGS = new Set(["-f", "--file", "-p", "--project-name", "--project-directory"]);

/**
 * Container ports of common non-HTTP services. They keep their published port
 * so existing connection strings (DATABASE_URL=...:5432) keep working.
 */
export const NON_HTTP_PORTS = new Set([
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

/** Read a global flag value (last one wins, as in compose). Handles `--flag=value`. */
export function readGlobal(globals: readonly string[], names: readonly string[]): string[] {
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

/** Drop the global flags portless sets itself on the resolved model. */
export function stripReplacedGlobals(globals: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < globals.length; i++) {
    const arg = globals[i]!;
    const eq = arg.indexOf("=");
    if (eq > 0 && REPLACED_FLAGS.has(arg.slice(0, eq))) continue;
    if (REPLACED_FLAGS.has(arg)) {
      i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

export interface ComposePort {
  target: number;
  published?: string;
  host_ip?: string;
  protocol?: string;
  mode?: string;
  [key: string]: unknown;
}

export interface ComposeService {
  ports?: ComposePort[];
  network_mode?: string;
  labels?: Record<string, string>;
  environment?: Record<string, string | null>;
  extra_hosts?: string[];
  volumes?: unknown[];
  [key: string]: unknown;
}

export interface ComposeModel {
  name: string;
  services: Record<string, ComposeService>;
  [key: string]: unknown;
}

export interface PlannedRoute {
  service: string;
  target: number;
  /** Route name without TLD, e.g. "api.shop". */
  name: string;
}

export interface KeptPort {
  service: string;
  target: number;
  published: string | undefined;
  reason: "non-http" | "udp" | "host-network" | "disabled" | "not-listed";
}

/**
 * Per-service settings, read from compose labels. Labels survive
 * `docker compose config --format json`; `x-` extensions inside a service do not.
 */
export interface ServiceSettings {
  enabled: boolean;
  /** Replaces the service name in the hostname. */
  name?: string;
  /** Container ports to route. Replaces the default HTTP port detection. */
  ports?: number[];
}

export const LABEL_ENABLE = "portless.enable";
export const LABEL_NAME = "portless.name";
export const LABEL_PORTS = "portless.ports";

export function readServiceSettings(service: string, svc: ComposeService): ServiceSettings {
  const labels = svc.labels ?? {};
  const enable = labels[LABEL_ENABLE]?.trim().toLowerCase();
  const enabled = enable !== "false" && enable !== "0";
  const settings: ServiceSettings = { enabled };

  const name = labels[LABEL_NAME]?.trim();
  if (name) {
    const label = toLabel(name);
    if (!label)
      throw new Error(`${service}: ${LABEL_NAME} "${name}" is not a valid hostname label.`);
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

export interface ComposePlan {
  project: string;
  /** Resolved model with routed ports moved to ephemeral loopback ports. */
  model: ComposeModel;
  routes: PlannedRoute[];
  kept: KeptPort[];
}

/** Turn a compose project or service name into a DNS label. */
export function toLabel(name: string): string {
  return truncateLabel(
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
  );
}

/**
 * Plan routes for a resolved compose model. Every published TCP port becomes
 * an ephemeral port on 127.0.0.1 and a route `<service>.<project>`. A service
 * with several routed ports gets `<service>.<project>` for the first and
 * `<port>.<service>.<project>` for each of them.
 */
export function planCompose(model: ComposeModel): ComposePlan {
  const project = toLabel(model.name);
  const routes: PlannedRoute[] = [];
  const kept: KeptPort[] = [];
  const services: Record<string, ComposeService> = {};
  const seen = new Map<string, string>();

  for (const [service, svc] of Object.entries(model.services ?? {})) {
    const ports = svc.ports ?? [];
    if (ports.length === 0) {
      services[service] = svc;
      continue;
    }
    if (svc.network_mode === "host") {
      for (const p of ports) {
        kept.push({ service, target: p.target, published: p.published, reason: "host-network" });
      }
      services[service] = svc;
      continue;
    }

    const settings = readServiceSettings(service, svc);
    if (!settings.enabled) {
      for (const p of ports) {
        kept.push({ service, target: p.target, published: p.published, reason: "disabled" });
      }
      services[service] = svc;
      continue;
    }
    if (settings.ports) {
      const published = new Set(ports.map((p) => p.target));
      const missing = settings.ports.filter((p) => !published.has(p));
      if (missing.length > 0) {
        throw new Error(
          `${service}: ${LABEL_PORTS} lists ${missing.join(", ")}, but the service does not publish ${missing.length > 1 ? "them" : "it"}.`
        );
      }
    }

    const label = settings.name ?? toLabel(service);
    const routedTargets: number[] = [];
    const rewritePort = (p: ComposePort): ComposePort | null => {
      if ((p.protocol ?? "tcp") !== "tcp") {
        kept.push({ service, target: p.target, published: p.published, reason: "udp" });
        return p;
      }
      if (settings.ports && !settings.ports.includes(p.target)) {
        kept.push({ service, target: p.target, published: p.published, reason: "not-listed" });
        return p;
      }
      if (!settings.ports && NON_HTTP_PORTS.has(p.target)) {
        kept.push({ service, target: p.target, published: p.published, reason: "non-http" });
        return p;
      }
      // One loopback binding serves every route for this target. Further
      // bindings (for example 0.0.0.0 and :: on the same port) are dropped so
      // their fixed host port cannot collide with another project.
      if (routedTargets.includes(p.target)) return null;
      routedTargets.push(p.target);
      const { published: _published, ...rest } = p;
      return { ...rest, host_ip: "127.0.0.1" };
    };
    const nextPorts: ComposePort[] = [];
    for (const p of ports) {
      const next = rewritePort(p);
      if (next) nextPorts.push(next);
    }

    routedTargets.forEach((target, index) => {
      const names = routedTargets.length > 1 ? [`${target}.${label}`] : [];
      if (index === 0) names.unshift(label);
      for (const sub of names) {
        const name = `${sub}.${project}`;
        const owner = seen.get(name);
        if (owner && owner !== service) {
          throw new Error(
            `Services "${owner}" and "${service}" both map to ${name}. Rename one of them.`
          );
        }
        seen.set(name, service);
        routes.push({ service, target, name });
      }
    });

    services[service] = { ...svc, ports: nextPorts };
  }

  return { project, model: { ...model, services }, routes, kept };
}

/** Where the portless CA is mounted inside containers when HTTPS is on. */
export const CONTAINER_CA_PATH = "/etc/portless/ca.pem";

export interface ContainerAccess {
  /** Every hostname of a route name, one per configured TLD. */
  hostnamesFor: (routeName: string) => string[];
  /** Public URL of a route name. */
  urlFor: (routeName: string) => string;
  /** Value for __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS, e.g. ".localhost". */
  viteAllowedHosts: string;
  /** Host path of the portless CA. Set only when the proxy uses HTTPS. */
  caPath?: string;
}

function hostOf(entry: string): string {
  return entry.split(/[=:]/)[0]!.trim();
}

/**
 * Let containers reach portless URLs. Every service resolves the project's
 * hostnames to the Docker host (where the proxy listens) and, with HTTPS,
 * trusts the portless CA through NODE_EXTRA_CA_CERTS. Routed services also
 * get PORTLESS_URL and the Vite allowed-hosts variable, so a dev server in a
 * container accepts requests for its portless hostname. Values the compose
 * file already sets win.
 */
export function withContainerAccess(plan: ComposePlan, access: ContainerAccess): ComposeModel {
  const hostnames = [...new Set(plan.routes.flatMap((r) => access.hostnamesFor(r.name)))];
  const services: Record<string, ComposeService> = {};

  for (const [service, svc] of Object.entries(plan.model.services)) {
    const next: ComposeService = { ...svc };
    const env: Record<string, string | null> = { ...(svc.environment ?? {}) };
    const setEnv = (key: string, value: string): void => {
      if (!(key in env)) env[key] = value;
    };

    // extra_hosts conflicts with network_mode host, service:, and container:.
    if (!svc.network_mode && hostnames.length > 0) {
      const existing = svc.extra_hosts ?? [];
      const defined = new Set(existing.map(hostOf));
      next.extra_hosts = [
        ...existing,
        ...hostnames.filter((h) => !defined.has(h)).map((h) => `${h}=host-gateway`),
      ];
    }

    const own = plan.routes.find((r) => r.service === service);
    if (own) {
      setEnv("PORTLESS_URL", access.urlFor(own.name));
      setEnv("__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS", access.viteAllowedHosts);
    }

    if (access.caPath && hostnames.length > 0) {
      const volumes = svc.volumes ?? [];
      const mounted = volumes.some(
        (v) => (v as { target?: string } | null)?.target === CONTAINER_CA_PATH
      );
      if (!mounted) {
        next.volumes = [
          ...volumes,
          { type: "bind", source: access.caPath, target: CONTAINER_CA_PATH, read_only: true },
        ];
      }
      setEnv("NODE_EXTRA_CA_CERTS", CONTAINER_CA_PATH);
    }

    if (Object.keys(env).length > 0) next.environment = env;
    services[service] = next;
  }

  return { ...plan.model, services };
}

export interface Publisher {
  service: string;
  target: number;
  port: number;
}

/**
 * Parse `docker compose ps --format json`. Compose v2.21+ prints one JSON
 * object per line; older versions print a single array.
 */
export function parsePublishers(output: string): Publisher[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  let rows: unknown[];
  if (trimmed.startsWith("[")) {
    rows = JSON.parse(trimmed) as unknown[];
  } else {
    rows = trimmed
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as unknown);
  }
  const out: Publisher[] = [];
  for (const row of rows) {
    const r = row as {
      Service?: string;
      State?: string;
      Publishers?: Array<{ TargetPort?: number; PublishedPort?: number; Protocol?: string }>;
    };
    if (!r.Service || (r.State && r.State !== "running")) continue;
    for (const p of r.Publishers ?? []) {
      if (!p.PublishedPort || !p.TargetPort || (p.Protocol ?? "tcp") !== "tcp") continue;
      if (out.some((o) => o.service === r.Service && o.target === p.TargetPort)) continue;
      out.push({ service: r.Service, target: p.TargetPort, port: p.PublishedPort });
    }
  }
  return out;
}

/** Match planned routes to the host ports compose assigned. */
export function resolveRoutePorts(
  routes: readonly PlannedRoute[],
  publishers: readonly Publisher[]
): Array<PlannedRoute & { port: number }> {
  const out: Array<PlannedRoute & { port: number }> = [];
  for (const route of routes) {
    const pub = publishers.find((p) => p.service === route.service && p.target === route.target);
    if (pub) out.push({ ...route, port: pub.port });
  }
  return out;
}

/** Whether subcommand arguments ask compose for help instead of running. */
export function wantsHelp(rest: readonly string[]): boolean {
  return rest.includes("--help") || rest.includes("-h");
}

/** Whether `up` arguments leave compose running in the foreground. */
export function isDetachedUp(rest: readonly string[]): boolean {
  return rest.some((a) => a === "-d" || a === "--detach" || a === "--wait" || a === "--wait=true");
}
