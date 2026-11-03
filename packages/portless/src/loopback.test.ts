import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as net from "node:net";
import { isPortListening } from "./cli-utils.js";
import { createLoopbackConnection } from "./utils.js";

const netMocks = vi.hoisted(() => ({
  connect: vi.fn<(options: net.TcpNetConnectOpts) => net.Socket>(),
  getDefaultAutoSelectFamilyAttemptTimeout: vi.fn<() => number>(),
}));

vi.mock("node:net", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:net")>()),
  ...netMocks,
}));

let socket: net.Socket;

beforeEach(() => {
  netMocks.connect.mockReset();
  netMocks.getDefaultAutoSelectFamilyAttemptTimeout.mockReset().mockReturnValue(250);
  socket = new net.Socket();
  netMocks.connect.mockReturnValue(socket);
});

afterEach(() => {
  socket.destroy();
  vi.restoreAllMocks();
});

function connectionOptions(): net.TcpNetConnectOpts {
  expect(netMocks.connect).toHaveBeenCalledTimes(1);
  return netMocks.connect.mock.calls[0]![0];
}

describe("createLoopbackConnection", () => {
  it("returns the Node socket and enables automatic family selection", () => {
    const result = createLoopbackConnection(4321);

    expect(result).toBe(socket);
    expect(result).toBeInstanceOf(net.Socket);
    expect(connectionOptions()).toMatchObject({
      host: "localhost",
      port: 4321,
      autoSelectFamily: true,
    });
  });

  it.each([
    { nodeDefault: 250, expected: 2000 },
    { nodeDefault: 1999, expected: 2000 },
    { nodeDefault: 2000, expected: 2000 },
    { nodeDefault: 3500, expected: 3500 },
  ])("uses $expected ms for a Node default of $nodeDefault ms", ({ nodeDefault, expected }) => {
    netMocks.getDefaultAutoSelectFamilyAttemptTimeout.mockReturnValue(nodeDefault);

    createLoopbackConnection(4321);

    expect(connectionOptions().autoSelectFamilyAttemptTimeout).toBe(expected);
    expect(netMocks.getDefaultAutoSelectFamilyAttemptTimeout).toHaveBeenCalledTimes(1);
  });

  it("reads the current Node default for each connection", () => {
    netMocks.getDefaultAutoSelectFamilyAttemptTimeout
      .mockReturnValueOnce(250)
      .mockReturnValueOnce(3500);

    createLoopbackConnection(4321);
    createLoopbackConnection(4322);

    expect(
      netMocks.connect.mock.calls.map(([options]) => options.autoSelectFamilyAttemptTimeout)
    ).toEqual([2000, 3500]);
  });

  it.each([100, 5000])("passes an explicit %i ms attempt timeout through", (timeout) => {
    createLoopbackConnection(4321, timeout);

    expect(connectionOptions().autoSelectFamilyAttemptTimeout).toBe(timeout);
  });

  it("supplies IPv4 and IPv6 loopback addresses in that order", async () => {
    createLoopbackConnection(4321);
    const lookup = connectionOptions().lookup as (
      hostname: string,
      options: { all: boolean; family: number },
      callback: (
        error: NodeJS.ErrnoException | null,
        addresses: { address: string; family: number }[]
      ) => void
    ) => void;
    expect(lookup).toBeTypeOf("function");

    const addresses = await new Promise<{ address: string; family: number }[]>(
      (resolve, reject) => {
        lookup("localhost", { all: true, family: 0 }, (error, result) => {
          if (error) reject(error);
          else resolve(result);
        });
      }
    );

    expect(addresses).toEqual([
      { address: "127.0.0.1", family: 4 },
      { address: "::1", family: 6 },
    ]);
  });
});

describe("isPortListening", () => {
  it.each([250, 3500])(
    "uses the current Node default of %i ms for the probe",
    async (nodeDefault) => {
      netMocks.getDefaultAutoSelectFamilyAttemptTimeout.mockReturnValue(nodeDefault);
      const setTimeout = vi.spyOn(socket, "setTimeout");

      const listening = isPortListening(8765);
      socket.emit("connect");

      await expect(listening).resolves.toBe(true);
      expect(connectionOptions()).toMatchObject({
        port: 8765,
        autoSelectFamilyAttemptTimeout: nodeDefault,
      });
      expect(netMocks.getDefaultAutoSelectFamilyAttemptTimeout).toHaveBeenCalledTimes(1);
      expect(setTimeout).toHaveBeenCalledWith(500);
    }
  );

  it("returns false on a probe timeout", async () => {
    const listening = isPortListening(8765);
    socket.emit("timeout");

    await expect(listening).resolves.toBe(false);
    expect(socket.destroyed).toBe(true);
  });
});
