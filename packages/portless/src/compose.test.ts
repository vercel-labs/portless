import { describe, expect, it } from "vitest";
import {
  isDetachedUp,
  parsePublishers,
  wantsHelp,
  planCompose,
  readGlobal,
  resolveRoutePorts,
  splitComposeArgs,
  stripReplacedGlobals,
  toLabel,
  withContainerAccess,
  CONTAINER_CA_PATH,
  type ComposeModel,
} from "./compose.js";

describe("splitComposeArgs", () => {
  it("separates global flags, subcommand, and rest", () => {
    expect(splitComposeArgs(["-f", "a.yml", "--profile", "dev", "up", "-d", "web"])).toEqual({
      globals: ["-f", "a.yml", "--profile", "dev"],
      subcommand: "up",
      rest: ["-d", "web"],
    });
  });

  it("handles --flag=value and boolean globals", () => {
    expect(splitComposeArgs(["--file=a.yml", "--dry-run", "down"])).toEqual({
      globals: ["--file=a.yml", "--dry-run"],
      subcommand: "down",
      rest: [],
    });
  });

  it("returns no subcommand when only flags are given", () => {
    expect(splitComposeArgs(["-f", "a.yml"]).subcommand).toBeUndefined();
  });
});

describe("readGlobal and stripReplacedGlobals", () => {
  const globals = ["-f", "a.yml", "--file=b.yml", "-p", "shop", "--profile", "dev"];

  it("reads every value of a flag in order", () => {
    expect(readGlobal(globals, ["-f", "--file"])).toEqual(["a.yml", "b.yml"]);
    expect(readGlobal(globals, ["-p", "--project-name"])).toEqual(["shop"]);
  });

  it("drops the flags portless sets itself and keeps the rest", () => {
    expect(stripReplacedGlobals(globals)).toEqual(["--profile", "dev"]);
  });
});

describe("toLabel", () => {
  it("makes compose names valid DNS labels", () => {
    expect(toLabel("my_api")).toBe("my-api");
    expect(toLabel("Shop")).toBe("shop");
    expect(toLabel("_x_")).toBe("x");
  });
});

function model(services: ComposeModel["services"], name = "shop"): ComposeModel {
  return { name, services };
}

describe("planCompose", () => {
  it("moves published HTTP ports to ephemeral loopback ports", () => {
    const plan = planCompose(
      model({
        web: { image: "nginx", ports: [{ target: 80, published: "8080", protocol: "tcp" }] },
      })
    );
    expect(plan.routes).toEqual([{ service: "web", target: 80, name: "web.shop" }]);
    expect(plan.model.services.web!.ports).toEqual([
      { target: 80, protocol: "tcp", host_ip: "127.0.0.1" },
    ]);
  });

  it("keeps database ports, UDP ports, and host networking", () => {
    const plan = planCompose(
      model({
        db: { ports: [{ target: 5432, published: "5432", protocol: "tcp" }] },
        dns: { ports: [{ target: 53, published: "53", protocol: "udp" }] },
        host: { network_mode: "host", ports: [{ target: 3000, published: "3000" }] },
      })
    );
    expect(plan.routes).toEqual([]);
    expect(plan.kept.map((k) => [k.service, k.reason])).toEqual([
      ["db", "non-http"],
      ["dns", "udp"],
      ["host", "host-network"],
    ]);
    expect(plan.model.services.db!.ports![0]!.published).toBe("5432");
  });

  it("leaves services without published ports untouched", () => {
    const svc = { image: "worker" };
    const plan = planCompose(model({ worker: svc }));
    expect(plan.model.services.worker).toBe(svc);
    expect(plan.routes).toEqual([]);
  });

  it("names every port when a service has several", () => {
    const plan = planCompose(
      model({
        app: {
          ports: [
            { target: 3000, published: "3000" },
            { target: 9229, published: "9229" },
          ],
        },
      })
    );
    expect(plan.routes.map((r) => r.name)).toEqual(["app.shop", "3000.app.shop", "9229.app.shop"]);
  });

  it("normalizes service and project names", () => {
    const plan = planCompose(
      model({ my_api: { ports: [{ target: 8000, published: "8000" }] } }, "my_shop")
    );
    expect(plan.routes[0]!.name).toBe("my-api.my-shop");
  });

  it("rejects two services that map to the same hostname", () => {
    expect(() =>
      planCompose(
        model({
          my_api: { ports: [{ target: 80, published: "80" }] },
          "my-api": { ports: [{ target: 80, published: "81" }] },
        })
      )
    ).toThrow(/both map to my-api.shop/);
  });

  it("does not mutate the input model", () => {
    const input = model({ web: { ports: [{ target: 80, published: "8080" }] } });
    planCompose(input);
    expect(input.services.web!.ports![0]!.published).toBe("8080");
  });
});

describe("parsePublishers", () => {
  const row = (service: string, state: string, publishers: unknown[]) =>
    JSON.stringify({ Service: service, State: state, Publishers: publishers });

  it("parses one JSON object per line", () => {
    const out = [
      row("web", "running", [{ TargetPort: 80, PublishedPort: 32768, Protocol: "tcp" }]),
      row("api", "running", [{ TargetPort: 80, PublishedPort: 32769, Protocol: "tcp" }]),
    ].join("\n");
    expect(parsePublishers(out)).toEqual([
      { service: "web", target: 80, port: 32768 },
      { service: "api", target: 80, port: 32769 },
    ]);
  });

  it("parses the older array format", () => {
    const out = `[${row("web", "running", [{ TargetPort: 80, PublishedPort: 1, Protocol: "tcp" }])}]`;
    expect(parsePublishers(out)).toEqual([{ service: "web", target: 80, port: 1 }]);
  });

  it("skips stopped containers, unpublished ports, and duplicates from IPv6", () => {
    const out = [
      row("old", "exited", [{ TargetPort: 80, PublishedPort: 1, Protocol: "tcp" }]),
      row("web", "running", [
        { TargetPort: 80, PublishedPort: 0, Protocol: "tcp" },
        { TargetPort: 81, PublishedPort: 2, Protocol: "tcp" },
        { TargetPort: 81, PublishedPort: 2, Protocol: "tcp" },
      ]),
    ].join("\n");
    expect(parsePublishers(out)).toEqual([{ service: "web", target: 81, port: 2 }]);
  });

  it("returns nothing for empty output", () => {
    expect(parsePublishers("\n")).toEqual([]);
  });
});

describe("resolveRoutePorts", () => {
  it("matches planned routes to assigned ports and drops the rest", () => {
    const routes = [
      { service: "web", target: 80, name: "web.shop" },
      { service: "api", target: 80, name: "api.shop" },
    ];
    expect(resolveRoutePorts(routes, [{ service: "web", target: 80, port: 32768 }])).toEqual([
      { service: "web", target: 80, name: "web.shop", port: 32768 },
    ]);
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

describe("service labels", () => {
  it("skips a service with portless.enable=false", () => {
    const plan = planCompose(
      model({
        web: {
          labels: { "portless.enable": "false" },
          ports: [{ target: 80, published: "8080" }],
        },
      })
    );
    expect(plan.routes).toEqual([]);
    expect(plan.kept).toEqual([
      { service: "web", target: 80, published: "8080", reason: "disabled" },
    ]);
    expect(plan.model.services.web!.ports![0]!.published).toBe("8080");
  });

  it("renames the hostname with portless.name", () => {
    const plan = planCompose(
      model({
        frontend_app: {
          labels: { "portless.name": "Site" },
          ports: [{ target: 3000, published: "3000" }],
        },
      })
    );
    expect(plan.routes[0]!.name).toBe("site.shop");
  });

  it("routes only the ports in portless.ports, including database ports", () => {
    const plan = planCompose(
      model({
        app: {
          labels: { "portless.ports": "5432" },
          ports: [
            { target: 5432, published: "5432" },
            { target: 3000, published: "3000" },
          ],
        },
      })
    );
    expect(plan.routes).toEqual([{ service: "app", target: 5432, name: "app.shop" }]);
    expect(plan.kept.map((k) => [k.target, k.reason])).toEqual([[3000, "not-listed"]]);
  });

  it("rejects invalid or unpublished ports in portless.ports", () => {
    const svc = (ports: string) => ({
      app: { labels: { "portless.ports": ports }, ports: [{ target: 3000, published: "3000" }] },
    });
    expect(() => planCompose(model(svc("abc")))).toThrow(/invalid port "abc"/);
    expect(() => planCompose(model(svc("3001")))).toThrow(/lists 3001/);
  });
});

describe("withContainerAccess", () => {
  const access = {
    hostnamesFor: (name: string) => [`${name}.localhost`],
    urlFor: (name: string) => `https://${name}.localhost`,
    viteAllowedHosts: ".localhost",
  };

  it("maps every route hostname to the Docker host in every service", () => {
    const plan = planCompose(
      model({
        web: { ports: [{ target: 80, published: "8080" }] },
        worker: { image: "worker" },
      })
    );
    const out = withContainerAccess(plan, access);
    expect(out.services.web!.extra_hosts).toEqual(["web.shop.localhost=host-gateway"]);
    expect(out.services.worker!.extra_hosts).toEqual(["web.shop.localhost=host-gateway"]);
  });

  it("gives routed services PORTLESS_URL and the Vite allowed hosts", () => {
    const plan = planCompose(model({ web: { ports: [{ target: 80, published: "8080" }] } }));
    const env = withContainerAccess(plan, access).services.web!.environment;
    expect(env).toEqual({
      PORTLESS_URL: "https://web.shop.localhost",
      __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".localhost",
    });
  });

  it("keeps values the compose file already sets", () => {
    const plan = planCompose(
      model({
        web: {
          ports: [{ target: 80, published: "8080" }],
          environment: { PORTLESS_URL: "mine" },
          extra_hosts: ["web.shop.localhost=10.0.0.1"],
        },
      })
    );
    const web = withContainerAccess(plan, access).services.web!;
    expect(web.environment!.PORTLESS_URL).toBe("mine");
    expect(web.extra_hosts).toEqual(["web.shop.localhost=10.0.0.1"]);
  });

  it("skips extra_hosts when the service sets network_mode", () => {
    const plan = planCompose(
      model({
        web: { ports: [{ target: 80, published: "8080" }] },
        sidecar: { network_mode: "service:web" },
      })
    );
    expect(withContainerAccess(plan, access).services.sidecar!.extra_hosts).toBeUndefined();
  });

  it("mounts the CA and sets NODE_EXTRA_CA_CERTS when HTTPS is on", () => {
    const plan = planCompose(model({ web: { ports: [{ target: 80, published: "8080" }] } }));
    const web = withContainerAccess(plan, { ...access, caPath: "/state/ca.pem" }).services.web!;
    expect(web.volumes).toEqual([
      { type: "bind", source: "/state/ca.pem", target: CONTAINER_CA_PATH, read_only: true },
    ]);
    expect(web.environment!.NODE_EXTRA_CA_CERTS).toBe(CONTAINER_CA_PATH);
  });

  it("changes nothing when the project has no routes", () => {
    const plan = planCompose(model({ worker: { image: "worker" } }));
    expect(withContainerAccess(plan, access).services.worker).toEqual({ image: "worker" });
  });
});

describe("duplicate bindings", () => {
  it("keeps one loopback binding when a port is published on IPv4 and IPv6", () => {
    const plan = planCompose(
      model({
        dual: {
          ports: [
            { target: 80, published: "8090", host_ip: "0.0.0.0", protocol: "tcp" },
            { target: 80, published: "8090", host_ip: "::", protocol: "tcp" },
          ],
        },
      })
    );
    expect(plan.model.services.dual!.ports).toEqual([
      { target: 80, protocol: "tcp", host_ip: "127.0.0.1" },
    ]);
    expect(plan.routes).toEqual([{ service: "dual", target: 80, name: "dual.shop" }]);
  });
});

describe("wantsHelp", () => {
  it("detects help flags", () => {
    expect(wantsHelp(["--help"])).toBe(true);
    expect(wantsHelp(["-h"])).toBe(true);
    expect(wantsHelp(["-d"])).toBe(false);
  });
});
