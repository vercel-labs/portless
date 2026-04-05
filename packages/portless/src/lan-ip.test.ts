import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkInterfaceInfo } from "node:os";

const hoisted = vi.hoisted(() => ({
  probeAddress: "192.168.1.10",
  socketFail: false,
  interfaces: {} as NodeJS.Dict<NetworkInterfaceInfo[] | undefined>,
}));

vi.mock("node:dgram", () => ({
  createSocket: vi.fn(() => {
    const socket = {
      on: vi.fn((event: string, handler: (e?: unknown) => void) => {
        if (event === "error") {
          (socket as { _onError?: (e: unknown) => void })._onError = handler;
        }
      }),
      connect: vi.fn((_port: number, _host: string, cb: () => void) => {
        queueMicrotask(() => {
          if (hoisted.socketFail) {
            const onErr = (socket as { _onError?: (e: unknown) => void })._onError;
            onErr?.(new Error("EHOSTUNREACH"));
            return;
          }
          cb();
        });
      }),
      address: vi.fn(() => ({
        address: hoisted.probeAddress,
        family: "IPv4" as const,
        port: 52341,
      })),
      close: vi.fn(),
      unref: vi.fn(),
    };
    return socket;
  }),
}));

vi.mock("node:os", () => ({
  networkInterfaces: vi.fn(() => hoisted.interfaces),
}));

describe("getLocalNetworkIp", () => {
  beforeEach(async () => {
    vi.resetModules();
    hoisted.probeAddress = "192.168.1.10";
    hoisted.socketFail = false;
    hoisted.interfaces = {
      en0: [
        {
          address: "192.168.1.10",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: false,
          cidr: "192.168.1.10/24",
          scopeid: undefined,
        },
      ],
    };
    const { networkInterfaces } = await import("node:os");
    vi.mocked(networkInterfaces).mockImplementation(() => hoisted.interfaces);
  });

  it("returns the probed address when the interface is not internal", async () => {
    const { getLocalNetworkIp } = await import("./lan-ip.js");
    await expect(getLocalNetworkIp()).resolves.toBe("192.168.1.10");
  });

  it("accepts numeric IPv4 family from os", async () => {
    hoisted.interfaces = {
      eth0: [
        {
          address: "10.0.0.5",
          netmask: "255.0.0.0",
          family: 4,
          mac: "aa:bb:cc:dd:ee:01",
          internal: false,
          cidr: "10.0.0.5/8",
          scopeid: undefined,
        },
      ],
    };
    hoisted.probeAddress = "10.0.0.5";
    const { networkInterfaces } = await import("node:os");
    vi.mocked(networkInterfaces).mockImplementation(() => hoisted.interfaces);

    const { getLocalNetworkIp } = await import("./lan-ip.js");
    await expect(getLocalNetworkIp()).resolves.toBe("10.0.0.5");
  });

  it("returns null when the probe reports 0.0.0.0", async () => {
    hoisted.probeAddress = "0.0.0.0";
    const { getLocalNetworkIp } = await import("./lan-ip.js");
    await expect(getLocalNetworkIp()).resolves.toBeNull();
  });

  it("returns null when the probed address is 127.0.0.1", async () => {
    hoisted.probeAddress = "127.0.0.1";
    hoisted.interfaces = {
      lo0: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
          scopeid: undefined,
        },
      ],
    };
    const { networkInterfaces } = await import("node:os");
    vi.mocked(networkInterfaces).mockImplementation(() => hoisted.interfaces);

    const { getLocalNetworkIp } = await import("./lan-ip.js");
    await expect(getLocalNetworkIp()).resolves.toBeNull();
  });

  it("returns null when Node marks the interface internal", async () => {
    hoisted.interfaces = {
      en0: [
        {
          address: "192.168.1.10",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: true,
          cidr: "192.168.1.10/24",
          scopeid: undefined,
        },
      ],
    };
    const { networkInterfaces } = await import("node:os");
    vi.mocked(networkInterfaces).mockImplementation(() => hoisted.interfaces);

    const { getLocalNetworkIp } = await import("./lan-ip.js");
    await expect(getLocalNetworkIp()).resolves.toBeNull();
  });

  it("returns null when the probed IP is not listed in networkInterfaces", async () => {
    hoisted.interfaces = {};
    const { networkInterfaces } = await import("node:os");
    vi.mocked(networkInterfaces).mockImplementation(() => hoisted.interfaces);

    const { getLocalNetworkIp } = await import("./lan-ip.js");
    await expect(getLocalNetworkIp()).resolves.toBeNull();
  });

  it("returns null for all-zero MAC", async () => {
    hoisted.interfaces = {
      en0: [
        {
          address: "192.168.1.10",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "192.168.1.10/24",
          scopeid: undefined,
        },
      ],
    };
    const { networkInterfaces } = await import("node:os");
    vi.mocked(networkInterfaces).mockImplementation(() => hoisted.interfaces);

    const { getLocalNetworkIp } = await import("./lan-ip.js");
    await expect(getLocalNetworkIp()).resolves.toBeNull();
  });

  it("returns null for Microsoft virtual MAC prefix", async () => {
    hoisted.interfaces = {
      eth0: [
        {
          address: "192.168.1.10",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "00:15:5d:01:02:03",
          internal: false,
          cidr: "192.168.1.10/24",
          scopeid: undefined,
        },
      ],
    };
    const { networkInterfaces } = await import("node:os");
    vi.mocked(networkInterfaces).mockImplementation(() => hoisted.interfaces);

    const { getLocalNetworkIp } = await import("./lan-ip.js");
    await expect(getLocalNetworkIp()).resolves.toBeNull();
  });

  it("returns null for vEthernet interface names", async () => {
    hoisted.interfaces = {
      "vEthernet (Default Switch)": [
        {
          address: "192.168.1.10",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: false,
          cidr: "192.168.1.10/24",
          scopeid: undefined,
        },
      ],
    };
    const { networkInterfaces } = await import("node:os");
    vi.mocked(networkInterfaces).mockImplementation(() => hoisted.interfaces);

    const { getLocalNetworkIp } = await import("./lan-ip.js");
    await expect(getLocalNetworkIp()).resolves.toBeNull();
  });

  it("returns null for Linux bridgeN names", async () => {
    hoisted.interfaces = {
      bridge0: [
        {
          address: "192.168.1.10",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: false,
          cidr: "192.168.1.10/24",
          scopeid: undefined,
        },
      ],
    };
    const { networkInterfaces } = await import("node:os");
    vi.mocked(networkInterfaces).mockImplementation(() => hoisted.interfaces);

    const { getLocalNetworkIp } = await import("./lan-ip.js");
    await expect(getLocalNetworkIp()).resolves.toBeNull();
  });

  it("returns null when the UDP socket errors", async () => {
    hoisted.socketFail = true;
    const { getLocalNetworkIp } = await import("./lan-ip.js");
    await expect(getLocalNetworkIp()).resolves.toBeNull();
  });
});
