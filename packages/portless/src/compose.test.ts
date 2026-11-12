import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  allocatePorts,
  buildUpArgs,
  composeGlobalError,
  explicitProject,
  isDetachedUp,
  parseContainers,
  planCompose,
  readsComposeFromStdin,
  routePort,
  splitComposeArgs,
  staleAliases,
  type ComposeModel,
} from "./compose.js";

const opts = {
  hostnamesFor: (name: string) => [`${name}.localhost`],
  urlFor: (hostname: string) => `https://${hostname}`,
  viteAllowedHosts: ".localhost",
};

function plan(services: ComposeModel["services"], name = "shop") {
  return planCompose({ name, services }, opts);
}

const hostnames = (p: ReturnType<typeof plan>) => p.routes.map((r) => r.hostnames[0]);

describe("splitComposeArgs", () => {
  it("separates global flags, subcommand, and rest", () => {
    expect(splitComposeArgs(["-f", "a.yml", "--profile", "dev", "up", "-d", "web"])).toEqual({
      globals: ["-f", "a.yml", "--profile", "dev"],
      subcommand: "up",
      rest: ["-d", "web"],
      dockerArgs: ["-f", "a.yml", "--profile", "dev", "up", "-d", "web"],
    });
  });

  it("handles --flag=value and boolean globals", () => {
    expect(splitComposeArgs(["--file=a.yml", "--dry-run", "down"])).toEqual({
      globals: ["--file=a.yml", "--dry-run"],
      subcommand: "down",
      rest: [],
      dockerArgs: ["--file=a.yml", "--dry-run", "down"],
    });
  });

  it("keeps attached shorthand values together", () => {
    expect(splitComposeArgs(["-fcompose.yml", "-p=demo", "--profile", "dev", "up"])).toEqual({
      globals: ["-fcompose.yml", "-p=demo", "--profile", "dev"],
      subcommand: "up",
      rest: [],
      dockerArgs: ["-fcompose.yml", "-p=demo", "--profile", "dev", "up"],
    });
  });

  it("ends the wrapper's globals at -- and keeps it from docker", () => {
    expect(splitComposeArgs(["-f", "a.yml", "--", "up", "-d"])).toEqual({
      globals: ["-f", "a.yml"],
      subcommand: "up",
      rest: ["-d"],
      dockerArgs: ["-f", "a.yml", "up", "-d"],
    });
    expect(splitComposeArgs(["--"])).toEqual({
      globals: [],
      subcommand: undefined,
      rest: [],
      dockerArgs: [],
    });
  });

  it("keeps a -- that belongs to the subcommand", () => {
    expect(splitComposeArgs(["up", "--", "--build"])).toEqual({
      globals: [],
      subcommand: "up",
      rest: ["--", "--build"],
      dockerArgs: ["up", "--", "--build"],
    });
  });
});

describe("buildUpArgs", () => {
  const base = { rest: ["-d"], project: "shop", modelPath: "/state/shop.json", cwd: "/app" };

  it("runs the model with the project, keeping other globals", () => {
    expect(buildUpArgs({ ...base, globals: ["-p", "x", "--profile", "dev"] })).toEqual([
      "-p",
      "shop",
      "--project-directory",
      "/app",
      "-f",
      "/state/shop.json",
      "--profile",
      "dev",
      "up",
      "-d",
    ]);
  });

  it("keeps the project directory compose would use, so .env still applies", () => {
    const dir = (globals: string[]) => {
      const args = buildUpArgs({ ...base, globals });
      return args[args.indexOf("--project-directory") + 1];
    };
    expect(dir([])).toBe("/app");
    expect(dir(["-f", "infra/compose.yml"])).toBe(path.resolve("/app", "infra"));
    expect(dir(["-finfra/compose.yml"])).toBe(path.resolve("/app", "infra"));
    expect(dir(["-f=infra/compose.yml"])).toBe(path.resolve("/app", "infra"));
    expect(dir(["--file=infra/compose.yml", "--project-directory", "/other"])).toBe("/other");
    expect(dir(["--workdir", "/work"])).toBe("/work");
    expect(dir(["--workdir=/work", "--project-directory", "/other"])).toBe("/other");
  });

  it("strips attached file, project, and directory flags", () => {
    expect(
      buildUpArgs({
        ...base,
        globals: [
          "-fcompose.yml",
          "-p=demo",
          "--project-directory=/other",
          "--workdir=/old",
          "--profile",
          "dev",
        ],
      })
    ).toEqual([
      "-p",
      "shop",
      "--project-directory",
      "/other",
      "-f",
      "/state/shop.json",
      "--profile",
      "dev",
      "up",
      "-d",
    ]);
  });

  it("strips an attached stdin file and keeps cwd", () => {
    expect(buildUpArgs({ ...base, globals: ["-f-"] })).toEqual([
      "-p",
      "shop",
      "--project-directory",
      "/app",
      "-f",
      "/state/shop.json",
      "up",
      "-d",
    ]);
  });

  it("takes the project directory from COMPOSE_FILE when no -f is given", () => {
    const args = buildUpArgs({
      ...base,
      globals: [],
      composeFileEnv: "infra/compose.yml|infra/override.yml",
      pathSeparator: "|",
    });
    expect(args[args.indexOf("--project-directory") + 1]).toBe(path.resolve("/app", "infra"));
  });
});

describe("isDetachedUp", () => {
  it("detects detached and wait modes", () => {
    expect(isDetachedUp(["-d"])).toBe(true);
    expect(isDetachedUp(["--detach", "web"])).toBe(true);
    expect(isDetachedUp(["--wait"])).toBe(true);
    expect(isDetachedUp(["--build"])).toBe(false);
  });
});

describe("planCompose", () => {
  it("moves published HTTP ports to ephemeral loopback ports", () => {
    const p = plan({ web: { ports: [{ target: 80, published: "8080", protocol: "tcp" }] } });
    expect(p.routes).toEqual([
      {
        service: "web",
        target: 80,
        hostnames: ["web.shop.localhost"],
        url: "https://web.shop.localhost",
      },
    ]);
    expect(p.model.services.web!.ports).toEqual([
      { target: 80, protocol: "tcp", host_ip: "127.0.0.1" },
    ]);
  });

  it("gives routed services the Vite allowed hosts, unless already set", () => {
    const p = plan({
      web: { ports: [{ target: 5173, published: "5173" }] },
      api: { ports: [{ target: 80, published: "80" }], environment: { X: "1" } },
      pinned: {
        ports: [{ target: 81, published: "81" }],
        environment: { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: "mine" },
      },
      worker: { image: "worker" },
    });
    const env = (s: string) => p.model.services[s]!.environment;
    expect(env("web")).toEqual({ __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".localhost" });
    expect(env("api")).toEqual({ X: "1", __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".localhost" });
    expect(env("pinned")).toEqual({ __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: "mine" });
    expect(p.model.services.worker).toEqual({ image: "worker" });
  });

  it("keeps database ports, UDP ports, and host networking", () => {
    const p = plan({
      db: { ports: [{ target: 5432, published: "5432", protocol: "tcp" }] },
      dns: { ports: [{ target: 53, published: "53", protocol: "udp" }] },
      host: { network_mode: "host", ports: [{ target: 3000, published: "3000" }] },
    });
    expect(p.routes).toEqual([]);
    expect(p.kept.map((k) => k.service)).toEqual(["db", "dns", "host"]);
    expect(p.model.services.db!.ports![0]!.published).toBe("5432");
  });

  it("keeps one loopback binding per routed port and reports the dropped ones", () => {
    const p = plan({
      dual: {
        ports: [
          { target: 80, published: "8090", host_ip: "0.0.0.0", protocol: "tcp" },
          { target: 80, published: "8090", host_ip: "::", protocol: "tcp" },
          { target: 80, published: "9090", protocol: "tcp" },
        ],
      },
    });
    expect(p.model.services.dual!.ports).toEqual([
      { target: 80, protocol: "tcp", host_ip: "127.0.0.1" },
    ]);
    expect(p.kept.map((k) => k.published)).toEqual(["8090", "9090"]);
    expect(hostnames(p)).toEqual(["dual.shop.localhost"]);
  });

  it("names every port when a service has several", () => {
    const p = plan({
      app: {
        ports: [
          { target: 3000, published: "3000" },
          { target: 9229, published: "9229" },
        ],
      },
    });
    expect(hostnames(p)).toEqual([
      "app.shop.localhost",
      "3000.app.shop.localhost",
      "9229.app.shop.localhost",
    ]);
  });

  it("normalizes names and keeps the compose project name", () => {
    const p = plan({ my_api: { ports: [{ target: 8000, published: "8000" }] } }, "my_shop");
    expect(hostnames(p)).toEqual(["my-api.my-shop.localhost"]);
    expect(p.project).toBe("my_shop");
  });

  it("rejects two services that map to the same hostname", () => {
    expect(() =>
      plan({
        my_api: { ports: [{ target: 80, published: "80" }] },
        "my-api": { ports: [{ target: 80, published: "81" }] },
      })
    ).toThrow(/both map to my-api.shop/);
  });

  it("does not mutate the input model", () => {
    const services = { web: { ports: [{ target: 80, published: "8080" }] } };
    plan(services);
    expect(services.web.ports[0]!.published).toBe("8080");
  });
});

describe("service labels", () => {
  it("skips a service with portless.enable=false", () => {
    const p = plan({
      web: { labels: { "portless.enable": "false" }, ports: [{ target: 80, published: "8080" }] },
    });
    expect(p.routes).toEqual([]);
    expect(p.model.services.web!.ports![0]!.published).toBe("8080");
  });

  it("renames the hostname with portless.name", () => {
    const p = plan({
      frontend_app: {
        labels: { "portless.name": "Site" },
        ports: [{ target: 3000, published: "3000" }],
      },
    });
    expect(hostnames(p)).toEqual(["site.shop.localhost"]);
  });

  it("routes only the ports in portless.ports, including database ports", () => {
    const p = plan({
      app: {
        labels: { "portless.ports": "5432" },
        ports: [
          { target: 5432, published: "5432" },
          { target: 3000, published: "3000" },
        ],
      },
    });
    expect(p.routes.map((r) => r.target)).toEqual([5432]);
    expect(p.kept.map((k) => k.target)).toEqual([3000]);
  });

  it("rejects invalid or unpublished ports in portless.ports", () => {
    const svc = (ports: string) => ({
      app: { labels: { "portless.ports": ports }, ports: [{ target: 3000, published: "3000" }] },
    });
    expect(() => plan(svc("abc"))).toThrow(/invalid port "abc"/);
    expect(() => plan(svc("3001"))).toThrow(/lists 3001/);
  });
});

const row = (service: string, state: string, publishers: unknown[], project = "shop") =>
  JSON.stringify({ Project: project, Service: service, State: state, Publishers: publishers });

describe("parseContainers", () => {
  it("parses one JSON object per line", () => {
    const out = [
      row("web", "running", [{ TargetPort: 80, PublishedPort: 32768, Protocol: "tcp" }]),
      row("api", "running", [{ TargetPort: 80, PublishedPort: 32769, Protocol: "tcp" }]),
    ].join("\n");
    const c = parseContainers(out);
    expect(c.projects).toEqual(["shop"]);
    expect([...c.ports]).toEqual([
      ["web:80", 32768],
      ["api:80", 32769],
    ]);
  });

  it("parses the older array format", () => {
    const c = parseContainers(
      `[${row("web", "running", [{ TargetPort: 80, PublishedPort: 1, Protocol: "tcp" }])}]`
    );
    expect(c.ports.get("web:80")).toBe(1);
  });

  it("lists stopped containers' projects but not their ports", () => {
    const c = parseContainers(
      row("old", "exited", [{ TargetPort: 80, PublishedPort: 1, Protocol: "tcp" }])
    );
    expect(c.projects).toEqual(["shop"]);
    expect(c.ports.size).toBe(0);
  });

  it("returns nothing for empty output", () => {
    expect(parseContainers("\n")).toEqual({ projects: [], ports: new Map() });
  });
});

describe("routePort", () => {
  it("finds the host port of a planned route", () => {
    const p = plan({ web: { ports: [{ target: 80, published: "8080" }] } });
    const c = parseContainers(
      row("web", "running", [{ TargetPort: 80, PublishedPort: 32768, Protocol: "tcp" }])
    );
    expect(routePort(p.routes[0]!, c)).toBe(32768);
    expect(routePort(p.routes[0]!, parseContainers(""))).toBeUndefined();
  });
});

describe("staleAliases", () => {
  const aliases = [
    { hostname: "web.shop.localhost", port: 32768 },
    { hostname: "debug.shop.localhost", port: 32770 },
    { hostname: "renamed.shop.localhost", port: 32771 },
    { hostname: "web.myshop.localhost", port: 40000 },
    { hostname: "manual.localhost", port: 5432 },
  ];

  it("removes the project's aliases whose container is gone", () => {
    const stillRunning = parseContainers(
      row("debug", "running", [{ TargetPort: 80, PublishedPort: 32770, Protocol: "tcp" }])
    );
    expect(staleAliases(aliases, "shop", ["localhost"], stillRunning)).toEqual([
      "web.shop.localhost",
      "renamed.shop.localhost",
    ]);
  });

  it("matches the project's DNS label and every TLD", () => {
    const list = [
      { hostname: "api.my-shop.localhost", port: 1 },
      { hostname: "api.my-shop.test", port: 1 },
    ];
    expect(staleAliases(list, "my_shop", ["localhost", "test"], parseContainers(""))).toEqual([
      "api.my-shop.localhost",
      "api.my-shop.test",
    ]);
  });
});

describe("readsComposeFromStdin and explicitProject", () => {
  it("detects -f - in any form", () => {
    expect(readsComposeFromStdin(["-f", "-"])).toBe(true);
    expect(readsComposeFromStdin(["-f-"])).toBe(true);
    expect(readsComposeFromStdin(["-f=-"])).toBe(true);
    expect(readsComposeFromStdin(["--file=-"])).toBe(true);
    expect(readsComposeFromStdin(["-f", "compose.yml"])).toBe(false);
  });

  it("reads the last -p in any form", () => {
    expect(explicitProject(["-p", "a", "--project-name=b"])).toBe("b");
    expect(explicitProject(["-pdemo"])).toBe("demo");
    expect(explicitProject(["-p=demo"])).toBe("demo");
    expect(explicitProject(["-f", "x.yml"])).toBeUndefined();
  });
});

describe("fixed ports", () => {
  it("publishes the fixed host port on loopback", () => {
    const p = planCompose(
      { name: "shop", services: { web: { ports: [{ target: 80, published: "8080" }] } } },
      {
        ...opts,
        portFor: (service, target) => (service === "web" && target === 80 ? 14001 : undefined),
      }
    );
    expect(p.model.services.web!.ports).toEqual([
      { target: 80, host_ip: "127.0.0.1", published: "14001" },
    ]);
  });

  it("marks dropped duplicate bindings", () => {
    const p = plan({
      ext: {
        ports: [
          { target: 80, published: "8101", host_ip: "0.0.0.0" },
          { target: 80, published: "8102", host_ip: "::1" },
        ],
      },
    });
    expect(p.kept).toEqual([expect.objectContaining({ published: "8102", dropped: true })]);
  });
});

describe("allocatePorts", () => {
  const base = {
    min: 14000,
    max: 14003,
    ours: new Set<number>(),
    reserved: new Set<number>(),
    isFree: async () => true,
    random: () => 0,
  };

  it("reuses a stored port while it is free", async () => {
    const ports = await allocatePorts(["web:80"], { "web:80": 14002 }, base);
    expect(ports.get("web:80")).toBe(14002);
  });

  it("reuses a stored port held by the project's own containers", async () => {
    const ports = await allocatePorts(
      ["web:80"],
      { "web:80": 14002 },
      { ...base, ours: new Set([14002]), isFree: async () => false }
    );
    expect(ports.get("web:80")).toBe(14002);
  });

  it("replaces a stored port that another process took", async () => {
    const ports = await allocatePorts(
      ["web:80"],
      { "web:80": 14002 },
      { ...base, isFree: async (port) => port !== 14002 }
    );
    expect(ports.get("web:80")).toBe(14000);
  });

  it("skips ports saved by other projects", async () => {
    const ports = await allocatePorts(
      ["web:80", "api:3000"],
      {},
      {
        ...base,
        reserved: new Set([14000, 14001]),
      }
    );
    expect([...ports.values()]).toEqual([14002, 14003]);
  });

  it("gives each key its own port", async () => {
    const ports = await allocatePorts(["a:1", "b:1"], { "a:1": 14001, "b:1": 14001 }, base);
    expect(ports.get("a:1")).toBe(14001);
    expect(ports.get("b:1")).toBe(14000);
  });

  it("fails when the range is exhausted", async () => {
    await expect(
      allocatePorts(["web:80"], {}, { ...base, reserved: new Set([14000, 14001, 14002, 14003]) })
    ).rejects.toThrow(/No free port/);
  });
});

describe("composeGlobalError", () => {
  it.each([
    [["-f", "compose.yml", "--profile", "dev", "--ansi=never", "--dry-run"]],
    [["-fcompose.yml", "-f=compose.yml", "-pdemo", "-p=demo", "-f-", "-f=-"]],
    [["--workdir", "/app", "--workdir=/app"]],
    [["--dry-run=true", "--dry-run=false", "--dry-run=1", "-h", "-h=false"]],
  ])("accepts %j", (globals) => {
    expect(composeGlobalError(globals)).toBeNull();
  });

  it.each([
    [["--bad"], 'Unknown flag "--bad" for portless compose.'],
    [["-x"], 'Unknown flag "-x" for portless compose.'],
    [["-w", "/app"], 'Unknown flag "-w" for portless compose.'],
    [["-f"], "-f requires a value."],
    [["-f="], "-f requires a value."],
    [["-f", ""], "-f requires a value."],
    [["--file", "", "ps"], "--file requires a value."],
    [["--env-file="], "--env-file requires a value."],
    [["--dry-run=yes"], "--dry-run takes true or false."],
    [["-h=yes"], "-h takes true or false."],
  ])("rejects %j", (globals, message) => {
    expect(composeGlobalError(globals)).toBe(message);
  });
});
