import { describe, it, expect } from "vitest";
import {
  ensureTailscaleReady,
  formatTailscaleUrl,
  registerServePath,
  tailscalePathFor,
  unregisterServePath,
  type TailscaleCommandRunner,
} from "./tailscale.js";

interface MockResult {
  status?: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

function createRunner(
  results: Record<string, MockResult>,
  calls: string[][] = []
): TailscaleCommandRunner {
  return (args: string[]) => {
    calls.push(args);
    const key = args.join(" ");
    const result = results[key];
    if (!result) {
      throw new Error(`Unexpected tailscale call: ${key}`);
    }
    return {
      status: result.status ?? 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      ...(result.error ? { error: result.error } : {}),
    };
  };
}

describe("tailscale", () => {
  it("resolves base URL from Self.DNSName", () => {
    const runner = createRunner({
      version: { status: 0 },
      "status --json": {
        status: 0,
        stdout: JSON.stringify({
          Self: {
            DNSName: "devbox.example.ts.net.",
          },
        }),
      },
    });
    const ready = ensureTailscaleReady(runner);
    expect(ready.dnsName).toBe("devbox.example.ts.net");
    expect(ready.baseUrl).toBe("https://devbox.example.ts.net");
  });

  it("falls back to HostName and MagicDNSSuffix", () => {
    const runner = createRunner({
      version: { status: 0 },
      "status --json": {
        status: 0,
        stdout: JSON.stringify({
          Self: { HostName: "devbox" },
          CurrentTailnet: { MagicDNSSuffix: "example.ts.net." },
        }),
      },
    });
    const ready = ensureTailscaleReady(runner);
    expect(ready.dnsName).toBe("devbox.example.ts.net");
  });

  it("shows install guidance when tailscale binary is missing", () => {
    const enoent = Object.assign(new Error("spawn tailscale ENOENT"), { code: "ENOENT" });
    const runner = createRunner({
      version: { status: null, error: enoent },
    });
    expect(() => ensureTailscaleReady(runner)).toThrow("Tailscale CLI not found");
  });

  it("registers a serve path", () => {
    const calls: string[][] = [];
    const runner = createRunner(
      {
        "serve --bg --yes --https=443 --set-path=/myapp http://127.0.0.1:4123": { status: 0 },
      },
      calls
    );
    registerServePath("myapp", 4123, { runner });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "serve",
      "--bg",
      "--yes",
      "--https=443",
      "--set-path=/myapp",
      "http://127.0.0.1:4123",
    ]);
  });

  it("registers with --force by clearing old path first", () => {
    const calls: string[][] = [];
    const runner = createRunner(
      {
        "serve --yes --https=443 --set-path=/myapp off": {
          status: 1,
          stderr: "path not found",
        },
        "serve --bg --yes --https=443 --set-path=/myapp http://127.0.0.1:4123": { status: 0 },
      },
      calls
    );
    registerServePath("myapp", 4123, { force: true, runner });
    expect(calls).toHaveLength(2);
    expect(calls[0][calls[0].length - 1]).toBe("off");
    expect(calls[1][calls[1].length - 1]).toBe("http://127.0.0.1:4123");
  });

  it("throws a force hint on conflict", () => {
    const runner = createRunner({
      "serve --bg --yes --https=443 --set-path=/myapp http://127.0.0.1:4123": {
        status: 1,
        stderr: "path already exists",
      },
    });
    expect(() => registerServePath("myapp", 4123, { runner })).toThrow("Re-run with --force");
  });

  it("removes a serve path", () => {
    const runner = createRunner({
      "serve --yes --https=443 --set-path=/myapp off": { status: 0 },
    });
    expect(() => unregisterServePath("myapp", { runner })).not.toThrow();
  });

  it("ignores missing path errors when requested", () => {
    const runner = createRunner({
      "serve --yes --https=443 --set-path=/myapp off": {
        status: 1,
        stderr: "path does not exist",
      },
    });
    expect(() => unregisterServePath("myapp", { ignoreMissing: true, runner })).not.toThrow();
  });

  it("builds canonical tailscale URLs", () => {
    expect(tailscalePathFor("myapp")).toBe("/myapp");
    expect(formatTailscaleUrl("https://devbox.example.ts.net", "myapp")).toBe(
      "https://devbox.example.ts.net/myapp"
    );
  });
});
