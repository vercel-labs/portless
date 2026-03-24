import { afterEach, describe, expect, it } from "vitest";
import * as net from "node:net";
import { once } from "node:events";
import { findFreePort } from "./cli-utils.js";
import { createTcpProxy } from "./tcp-proxy.js";

const serversToClose: net.Server[] = [];

async function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function listen(server: net.Server, port: number): Promise<void> {
  server.listen(port);
  await once(server, "listening");
}

describe("createTcpProxy", () => {
  afterEach(async () => {
    while (serversToClose.length > 0) {
      const server = serversToClose.pop();
      if (server) await closeServer(server);
    }
  });

  it("forwards data bidirectionally", async () => {
    const targetPort = await findFreePort(6100, 6199);
    const proxyPort = await findFreePort(6200, 6299);

    const targetServer = net.createServer((socket) => {
      socket.on("data", (chunk) => {
        socket.write(Buffer.from(`echo:${chunk.toString()}`));
      });
    });
    serversToClose.push(targetServer);
    await listen(targetServer, targetPort);

    const proxyServer = createTcpProxy({ listenPort: proxyPort, targetPort });
    serversToClose.push(proxyServer);
    await listen(proxyServer, proxyPort);

    const client = net.connect(proxyPort, "127.0.0.1");
    await once(client, "connect");

    const response = new Promise<string>((resolve) => {
      client.once("data", (chunk) => resolve(chunk.toString()));
    });

    client.write("hello");
    await expect(response).resolves.toBe("echo:hello");

    client.end();
    await once(client, "close");
  });

  it("closes the upstream socket when the client disconnects", async () => {
    const targetPort = await findFreePort(6300, 6399);
    const proxyPort = await findFreePort(6400, 6499);

    let resolveAccepted: (() => void) | null = null;
    const targetAccepted = new Promise<void>((resolve) => {
      resolveAccepted = resolve;
    });
    let resolveTargetClosed: (() => void) | null = null;
    const targetClosed = new Promise<void>((resolve) => {
      resolveTargetClosed = resolve;
    });

    const targetServer = net.createServer((socket) => {
      socket.resume();
      resolveAccepted?.();
      socket.once("close", () => resolveTargetClosed?.());
    });
    serversToClose.push(targetServer);
    await listen(targetServer, targetPort);

    const proxyServer = createTcpProxy({ listenPort: proxyPort, targetPort });
    serversToClose.push(proxyServer);
    await listen(proxyServer, proxyPort);

    const client = net.connect(proxyPort, "127.0.0.1");
    await once(client, "connect");
    client.write("ping");
    await targetAccepted;
    client.end();
    await once(client, "close");

    await expect(targetClosed).resolves.toBeUndefined();
  });

  it("reports errors when the target is unreachable", async () => {
    const proxyPort = await findFreePort(6500, 6599);
    const targetPort = await findFreePort(6600, 6699);
    const errors: string[] = [];

    const proxyServer = createTcpProxy({
      listenPort: proxyPort,
      targetPort,
      onError: (message) => errors.push(message),
    });
    serversToClose.push(proxyServer);
    await listen(proxyServer, proxyPort);

    const client = net.connect(proxyPort, "127.0.0.1");
    await once(client, "connect");
    client.write("ping");
    await once(client, "close");

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`port ${proxyPort} -> ${targetPort}`);
  });
});
