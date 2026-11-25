import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  describeTailscaleShare,
  ensureTailscaleReady,
  findWindowsCmdShim,
  inferServiceName,
  normalizeServiceName,
  share,
  tailscaleShareFromRoute,
  tailscaleShareKey,
  unshare,
  type TailscaleCommandRunner,
  type TailscaleShareRecord,
} from "./tailscale.js";

type Result = ReturnType<TailscaleCommandRunner>;

function runnerFor(status: object, replies: Record<string, Partial<Result>> = {}) {
  const calls: string[][] = [];
  const runner: TailscaleCommandRunner = (args) => {
    calls.push(args);
    const key = args.join(" ");
    const result = key === "status --json" ? { stdout: JSON.stringify(status) } : replies[key];
    if (!result && key !== "version") throw new Error(`Unexpected command: ${key}`);
    return { status: 0, stdout: "", stderr: "", ...result };
  };
  return { runner, calls };
}

const httpsStatus = {
  Self: { DNSName: "devbox.example.ts.net.", Capabilities: ["https", "funnel"] },
  CurrentTailnet: { MagicDNSEnabled: true },
};

const tcpStatus = {
  Self: { TailscaleIPs: ["100.64.0.10", "fd7a:115c:a1e0::1"] },
  CurrentTailnet: { MagicDNSEnabled: false },
};

describe("ensureTailscaleReady", () => {
  it("uses the node DNS name without requiring a MagicDNS suffix for serve", () => {
    const { runner } = runnerFor(httpsStatus);
    expect(ensureTailscaleReady({ kind: "serve" }, { runner })).toMatchObject({
      transport: "https",
      host: "devbox.example.ts.net",
      baseUrl: "https://devbox.example.ts.net",
    });
  });

  it("chooses IPv4 or bracketed IPv6 TCP when MagicDNS is disabled", () => {
    const ipv4 = runnerFor(tcpStatus);
    expect(ensureTailscaleReady({ kind: "serve" }, ipv4)).toMatchObject({
      transport: "tcp",
      host: "100.64.0.10",
      baseUrl: "http://100.64.0.10",
    });
    const ipv6 = runnerFor({ ...tcpStatus, Self: { TailscaleIPs: ["fd7a:115c:a1e0::1"] } });
    expect(ensureTailscaleReady({ kind: "serve" }, ipv6)).toMatchObject({
      transport: "tcp",
      host: "[fd7a:115c:a1e0::1]",
      baseUrl: "http://[fd7a:115c:a1e0::1]",
    });
  });

  it.each([{ kind: "funnel" } as const, { kind: "service", serviceName: "api" } as const])(
    "rejects $kind when MagicDNS is disabled",
    (request) => {
      const { runner } = runnerFor(tcpStatus);
      expect(() => ensureTailscaleReady(request, { runner })).toThrow("MagicDNS is disabled");
    }
  );

  it("reports missing HTTPS and Funnel capabilities", () => {
    const noHttps = runnerFor({ Self: { DNSName: "devbox.example.ts.net" } });
    expect(() => ensureTailscaleReady({ kind: "serve" }, noHttps)).toThrow("HTTPS is not enabled");
    const noFunnel = runnerFor({
      Self: { DNSName: "devbox.example.ts.net", Capabilities: ["https"], ID: "node123" },
    });
    expect(() => ensureTailscaleReady({ kind: "funnel" }, noFunnel)).toThrow("node=node123");
  });

  it("requires tags for service mode", () => {
    const { runner } = runnerFor(httpsStatus);
    expect(() => ensureTailscaleReady({ kind: "service", serviceName: "api" }, { runner })).toThrow(
      "tag-based identity"
    );
  });

  it.each([
    [{ MagicDNSSuffix: "other.ts.net." }, "api.other.ts.net"],
    [{}, "api.example.ts.net"],
  ] as [Record<string, string>, string][])(
    "derives the service hostname from the tailnet or node DNS",
    (tailnet, host) => {
      const { runner } = runnerFor({
        Self: { DNSName: "devbox.example.ts.net.", Capabilities: ["https"], Tags: ["tag:dev"] },
        CurrentTailnet: tailnet,
      });
      expect(
        ensureTailscaleReady({ kind: "service", serviceName: "svc:API" }, { runner })
      ).toMatchObject({
        host,
        baseUrl: `https://${host}`,
        serviceId: "svc:api",
        serviceName: "api",
      });
    }
  );

  it("reports missing CLI and invalid status JSON", () => {
    const error = Object.assign(new Error("missing"), { code: "ENOENT" });
    expect(() =>
      ensureTailscaleReady(
        { kind: "serve" },
        { runner: () => ({ status: null, stdout: "", stderr: "", error }) }
      )
    ).toThrow("Tailscale CLI not found");
    const { runner } = runnerFor({});
    const invalid: TailscaleCommandRunner = (args) =>
      args[0] === "status" ? { status: 0, stdout: "bad", stderr: "" } : runner(args);
    expect(() => ensureTailscaleReady({ kind: "serve" }, { runner: invalid })).toThrow(
      "Failed to parse"
    );
  });
});

describe("normalizeServiceName", () => {
  it("strips the service prefix and normalizes case", () => {
    expect(normalizeServiceName(" svc:My-App ")).toBe("my-app");
  });
  it.each(["", "svc:", "-app", "app-", "bad name", "x".repeat(64)])(
    "rejects invalid name %s",
    (name) => {
      expect(() => normalizeServiceName(name)).toThrow("Invalid Tailscale service name");
    }
  );
});

describe("inferServiceName", () => {
  it.each([
    ["My App!", "my-app"],
    ["  Web_Server  ", "web-server"],
    ["svc:api", "svc-api"],
    ["-Edge..Case-", "edge-case"],
  ])("derives %s as %s", (raw, name) => {
    expect(inferServiceName(raw)).toBe(name);
  });

  it("truncates long names without leaving a trailing hyphen", () => {
    expect(inferServiceName(`${"a".repeat(62)} b`)).toBe("a".repeat(62));
    expect(inferServiceName("a".repeat(70))).toBe("a".repeat(63));
  });

  it("rejects names with no usable characters", () => {
    expect(() => inferServiceName("___")).toThrow("Invalid Tailscale service name");
  });
});

describe("share", () => {
  it.each([
    ["100.64.0.10", 80, "http://100.64.0.10"],
    ["100.64.0.10", 8080, "http://100.64.0.10:8080"],
    ["fd7a:115c:a1e0::1", 8080, "http://[fd7a:115c:a1e0::1]:8080"],
  ] as [string, number, string][])("registers TCP for %s on port %i", (ip, port, url) => {
    const { runner, calls } = runnerFor(
      { ...tcpStatus, Self: { TailscaleIPs: [ip] } },
      {
        "serve status --json": { stdout: "{}" },
        [`serve --bg --yes --tcp=${port} tcp://127.0.0.1:3000`]: {},
      }
    );
    const claimShare = vi.fn(() => null);
    expect(
      share({ kind: "serve", localPort: 3000, preferredPort: port, runner, claimShare })
    ).toEqual({
      url,
      record: { kind: "tcp", port },
    });
    expect(claimShare).toHaveBeenCalledWith({ kind: "tcp", port });
    expect(calls).toContainEqual([
      "serve",
      "--bg",
      "--yes",
      `--tcp=${port}`,
      "tcp://127.0.0.1:3000",
    ]);
  });

  it("automatically selects TCP port 80", () => {
    const { runner, calls } = runnerFor(tcpStatus, {
      "serve status --json": { stdout: "{}" },
      "serve --bg --yes --tcp=80 tcp://127.0.0.1:3000": {},
    });
    expect(share({ kind: "serve", localPort: 3000, runner }).url).toBe("http://100.64.0.10");
    expect(calls).toContainEqual(["serve", "--bg", "--yes", "--tcp=80", "tcp://127.0.0.1:3000"]);
  });

  it.each([0, 65536, 1.5, NaN])(
    "rejects invalid preferred port %s before invoking Tailscale",
    (port) => {
      const runner = vi.fn<TailscaleCommandRunner>();
      expect(() => share({ kind: "serve", localPort: 3000, preferredPort: port, runner })).toThrow(
        "Invalid Tailscale port"
      );
      expect(runner).not.toHaveBeenCalled();
    }
  );

  it.each([443, 8443, 10000])("accepts Funnel port %i", (port) => {
    const { runner } = runnerFor(httpsStatus, {
      "serve status --json": { stdout: "{}" },
      [`funnel --bg --yes --https=${port} http://127.0.0.1:3000`]: {},
    });
    expect(share({ kind: "funnel", localPort: 3000, preferredPort: port, runner }).record).toEqual({
      kind: "funnel",
      port,
    });
  });

  it("rejects a Funnel port outside the allowed set", () => {
    const runner = vi.fn<TailscaleCommandRunner>();
    expect(() => share({ kind: "funnel", localPort: 3000, preferredPort: 80, runner })).toThrow(
      "Funnel supports ports 443, 8443, and 10000"
    );
    expect(runner).not.toHaveBeenCalled();
  });

  it("releases a claim after a registration conflict and retries another port", () => {
    const { runner } = runnerFor(httpsStatus, {
      "serve status --json": { stdout: "{}" },
      "serve --bg --yes --https=443 http://127.0.0.1:3000": {
        status: 1,
        stderr: "port already in use",
      },
      "serve --bg --yes --https=8443 http://127.0.0.1:3000": {},
    });
    const claimShare = vi.fn(() => null);
    const releaseShare = vi.fn();
    expect(share({ kind: "serve", localPort: 3000, runner, claimShare, releaseShare })).toEqual({
      url: "https://devbox.example.ts.net:8443",
      record: { kind: "https", port: 8443 },
    });
    expect(claimShare.mock.calls).toEqual([
      [{ kind: "https", port: 443 }],
      [{ kind: "https", port: 8443 }],
    ]);
    expect(releaseShare).toHaveBeenCalledTimes(1);
  });

  it("rejects a preferred port already configured in the Tailscale daemon", () => {
    const { runner, calls } = runnerFor(httpsStatus, {
      "serve status --json": {
        stdout: JSON.stringify({ Web: { "devbox.example.ts.net:8443": {} } }),
      },
    });
    const claimShare = vi.fn(() => null);
    const releaseShare = vi.fn();
    expect(() =>
      share({
        kind: "serve",
        localPort: 3000,
        preferredPort: 8443,
        runner,
        claimShare,
        releaseShare,
      })
    ).toThrow("Tailscale port 8443 is already in use. Stop the existing serve");
    expect(claimShare).not.toHaveBeenCalled();
    expect(releaseShare).not.toHaveBeenCalled();
    expect(calls).toEqual([["version"], ["status", "--json"], ["serve", "status", "--json"]]);
  });

  it("releases a claim when registration fails for a non-conflict error", () => {
    const { runner } = runnerFor(httpsStatus, {
      "serve status --json": { stdout: "{}" },
      "serve --bg --yes --https=8443 http://127.0.0.1:3000": {
        status: 1,
        stderr: "permission denied",
      },
    });
    const releaseShare = vi.fn();
    expect(() =>
      share({
        kind: "serve",
        localPort: 3000,
        preferredPort: 8443,
        runner,
        claimShare: () => null,
        releaseShare,
      })
    ).toThrow("permission denied");
    expect(releaseShare).toHaveBeenCalledOnce();
  });

  it("rejects a preferred port already claimed by a live route", () => {
    const { runner, calls } = runnerFor(httpsStatus, {
      "serve status --json": { stdout: "{}" },
    });
    const releaseShare = vi.fn();
    expect(() =>
      share({
        kind: "serve",
        localPort: 3000,
        preferredPort: 8443,
        runner,
        claimShare: () => "other.localhost",
        releaseShare,
      })
    ).toThrow("already in use by other.localhost");
    expect(releaseShare).not.toHaveBeenCalled();
    expect(calls).toHaveLength(3);
  });

  it("registers a service and surfaces an approval notice", () => {
    const status = { ...httpsStatus, Self: { ...httpsStatus.Self, Tags: ["tag:dev"] } };
    const { runner, calls } = runnerFor(status, {
      "serve status --json": { stdout: "{}" },
      "serve --yes --service=svc:api --https=443 http://127.0.0.1:3000": {
        stdout: "approval from an admin is required",
      },
    });
    expect(share({ kind: "service", serviceName: "svc:API", localPort: 3000, runner })).toEqual({
      url: "https://api.example.ts.net",
      record: { kind: "service", serviceId: "svc:api", serviceName: "api" },
      pendingApproval: true,
    });
    expect(calls).toContainEqual([
      "serve",
      "--yes",
      "--service=svc:api",
      "--https=443",
      "http://127.0.0.1:3000",
    ]);
  });

  it("rejects a service already configured in tailscale serve status", () => {
    const status = { ...httpsStatus, Self: { ...httpsStatus.Self, Tags: ["tag:dev"] } };
    const { runner, calls } = runnerFor(status, {
      "serve status --json": {
        stdout: JSON.stringify({
          Services: {
            "svc:api": {
              TCP: { "443": { HTTPS: true } },
            },
          },
        }),
      },
    });
    const claimShare = vi.fn(() => null);
    expect(() =>
      share({ kind: "service", serviceName: "api", localPort: 3000, runner, claimShare })
    ).toThrow("Tailscale service svc:api is already in use");
    expect(claimShare).not.toHaveBeenCalled();
    expect(calls).not.toContainEqual([
      "serve",
      "--yes",
      "--service=svc:api",
      "--https=443",
      "http://127.0.0.1:3000",
    ]);
  });

  it("claims a service share before registering it", () => {
    const status = { ...httpsStatus, Self: { ...httpsStatus.Self, Tags: ["tag:dev"] } };
    const { runner } = runnerFor(status, {
      "serve status --json": { stdout: "{}" },
      "serve --yes --service=svc:api --https=443 http://127.0.0.1:3000": {},
    });
    const claimShare = vi.fn(() => null);
    share({ kind: "service", serviceName: "api", localPort: 3000, runner, claimShare });
    expect(claimShare).toHaveBeenCalledExactlyOnceWith({
      kind: "service",
      serviceId: "svc:api",
      serviceName: "api",
    });
  });

  it("rejects a service claim conflict without registering or releasing", () => {
    const status = { ...httpsStatus, Self: { ...httpsStatus.Self, Tags: ["tag:dev"] } };
    const { runner, calls } = runnerFor(status, {
      "serve status --json": { stdout: "{}" },
    });
    const releaseShare = vi.fn();
    expect(() =>
      share({
        kind: "service",
        serviceName: "api",
        localPort: 3000,
        runner,
        claimShare: () => "other.localhost",
        releaseShare,
      })
    ).toThrow("Tailscale service svc:api is already in use by other.localhost.");
    expect(calls).toEqual([["version"], ["status", "--json"], ["serve", "status", "--json"]]);
    expect(releaseShare).not.toHaveBeenCalled();
  });

  it("releases a service claim when registration fails", () => {
    const status = { ...httpsStatus, Self: { ...httpsStatus.Self, Tags: ["tag:dev"] } };
    const { runner } = runnerFor(status, {
      "serve status --json": { stdout: "{}" },
      "serve --yes --service=svc:api --https=443 http://127.0.0.1:3000": {
        status: 1,
        stderr: "permission denied",
      },
    });
    const releaseShare = vi.fn();
    expect(() =>
      share({
        kind: "service",
        serviceName: "api",
        localPort: 3000,
        runner,
        claimShare: () => null,
        releaseShare,
      })
    ).toThrow("permission denied");
    expect(releaseShare).toHaveBeenCalledOnce();
  });
});

describe("unshare", () => {
  it.each<[TailscaleShareRecord, string[]]>([
    [{ kind: "https", port: 443 }, ["serve", "--yes", "--https=443", "off"]],
    [{ kind: "tcp", port: 80 }, ["serve", "--yes", "--tcp=80", "off"]],
    [{ kind: "funnel", port: 8443 }, ["funnel", "--yes", "--https=8443", "off"]],
    [
      { kind: "service", serviceId: "svc:api", serviceName: "api" },
      ["serve", "--yes", "--service=svc:api", "--https=443", "off"],
    ],
  ])("removes $kind shares with the matching command", (record, args) => {
    const runner = vi.fn<TailscaleCommandRunner>(() => ({ status: 0, stdout: "", stderr: "" }));
    unshare(record, { runner });
    expect(runner).toHaveBeenCalledExactlyOnceWith(args);
  });

  it("throws for failed commands except matching missing shares", () => {
    const record = { kind: "https", port: 443 } as const;
    const missing: TailscaleCommandRunner = () => ({
      status: 1,
      stdout: "",
      stderr: "nothing to remove",
    });
    expect(() => unshare(record, { runner: missing })).toThrow("nothing to remove");
    expect(() => unshare(record, { runner: missing, ignoreMissing: true })).not.toThrow();
    const denied: TailscaleCommandRunner = () => ({
      status: 1,
      stdout: "",
      stderr: "permission denied",
    });
    expect(() => unshare(record, { runner: denied, ignoreMissing: true })).toThrow(
      "permission denied"
    );
  });

  it("throws on spawn errors even when missing shares are ignored", () => {
    const error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    const runner: TailscaleCommandRunner = () => ({ status: null, stdout: "", stderr: "", error });
    expect(() => unshare({ kind: "https", port: 443 }, { runner, ignoreMissing: true })).toThrow(
      "Tailscale CLI not found"
    );
  });
});

describe("tailscaleShareKey", () => {
  it("keys HTTPS, TCP, and Funnel shares by port so one daemon port has one owner", () => {
    expect(tailscaleShareKey({ kind: "https", port: 443 })).toBe("port:443");
    expect(tailscaleShareKey({ kind: "tcp", port: 443 })).toBe("port:443");
    expect(tailscaleShareKey({ kind: "funnel", port: 443 })).toBe("port:443");
    expect(tailscaleShareKey({ kind: "service", serviceId: "svc:api", serviceName: "api" })).toBe(
      "service:svc:api"
    );
  });
});

describe("route metadata", () => {
  it("prefers new share metadata and supports legacy serve and funnel fields", () => {
    const record = { kind: "tcp", port: 8080 } as const;
    expect(tailscaleShareFromRoute({ tailscaleShare: record, tailscaleHttpsPort: 443 })).toEqual(
      record
    );
    expect(tailscaleShareFromRoute({ tailscaleHttpsPort: 443 })).toEqual({
      kind: "https",
      port: 443,
    });
    expect(tailscaleShareFromRoute({ tailscaleHttpsPort: 8443, tailscaleFunnel: true })).toEqual({
      kind: "funnel",
      port: 8443,
    });
    expect(tailscaleShareFromRoute({})).toBeUndefined();
    expect(tailscaleShareKey(record)).toBe("port:8080");
    expect(describeTailscaleShare(record)).toBe("tailscale tcp serve on port 8080");
  });
});

describe("findWindowsCmdShim", () => {
  it("finds a shim on PATH and ignores absent entries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-tailscale-shim-"));
    try {
      expect(findWindowsCmdShim("tailscale", { PATH: dir })).toBeNull();
      const shim = path.join(dir, "tailscale.cmd");
      fs.writeFileSync(shim, "@echo off\r\n");
      expect(findWindowsCmdShim("tailscale", { PATH: dir })).toBe(shim);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
