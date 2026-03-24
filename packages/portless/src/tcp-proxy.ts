import * as net from "node:net";

export interface TcpProxyOptions {
  /** Used only for error messages; the caller is responsible for listen(). */
  listenPort: number;
  targetPort: number;
  targetHost?: string;
  onError?: (message: string) => void;
}

export function createTcpProxy(options: TcpProxyOptions): net.Server {
  const { listenPort, targetPort, targetHost = "127.0.0.1", onError } = options;

  return net.createServer((clientSocket) => {
    clientSocket.pause();
    clientSocket.on("error", () => clientSocket.destroy());

    const targetSocket = net.connect(targetPort, targetHost, () => {
      clientSocket.pipe(targetSocket);
      targetSocket.pipe(clientSocket);
      clientSocket.resume();
    });

    targetSocket.on("error", (err) => {
      onError?.(`TCP proxy error (port ${listenPort} -> ${targetPort}): ${err.message}`);
      clientSocket.destroy();
      targetSocket.destroy();
    });

    clientSocket.on("close", () => targetSocket.destroy());
    targetSocket.on("close", () => clientSocket.destroy());
  });
}
