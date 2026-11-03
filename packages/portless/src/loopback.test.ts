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

describe("loopback connection timing", () => {
  it.each([
    [250, 2000],
    [1999, 2000],
    [2000, 2000],
    [3500, 3500],
  ])("uses %i ms as the Node default and %i ms for the connection", (nodeDefault, expected) => {
    netMocks.getDefaultAutoSelectFamilyAttemptTimeout.mockReturnValue(nodeDefault);

    expect(createLoopbackConnection(4321)).toBe(socket);
    expect(netMocks.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "localhost",
        port: 4321,
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: expected,
      })
    );
  });

  it("passes an explicit 250 ms attempt timeout through", () => {
    createLoopbackConnection(4321, 250);
    expect(netMocks.connect).toHaveBeenCalledWith(
      expect.objectContaining({ autoSelectFamilyAttemptTimeout: 250 })
    );
  });

  it("keeps the 250 ms Node default for a short-lived port probe", async () => {
    const setTimeout = vi.spyOn(socket, "setTimeout");
    const listening = isPortListening(8765);
    socket.emit("connect");

    await expect(listening).resolves.toBe(true);
    expect(netMocks.connect).toHaveBeenCalledWith(
      expect.objectContaining({ port: 8765, autoSelectFamilyAttemptTimeout: 250 })
    );
    expect(setTimeout).toHaveBeenCalledWith(500);
  });
});
