import * as net from "node:net";

type Family = 4 | 6;
type DialCallback = (error: NodeJS.ErrnoException | null, socket?: net.Socket) => void;
type Attempt = { socket: net.Socket; detach: () => void };

const HEADROOM_MS = 5_000;
const MAX_TIMER_MS = 2_147_483_647;
const ignoreError = () => {};
const socketError = (message: string, code: string) => Object.assign(new Error(message), { code });

/**
 * The deadline is at least 10 seconds and 5 seconds after the scheduled fallback.
 * An event-loop stall can still delay a connect event beyond the deadline.
 */
export function dialLoopback(port: number, callback: DialCallback): { cancel: () => void } {
  const attempts = new Set<Attempt>();
  const errors: Partial<Record<Family, NodeJS.ErrnoException>> = {};
  let done = false;
  let startedIPv6 = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  function retire(attempt: Attempt, destroy: boolean): void {
    attempts.delete(attempt);
    attempt.detach();
    if (destroy) {
      attempt.socket.on("error", ignoreError);
      attempt.socket.destroy();
    }
  }

  function settle(winner?: Attempt): boolean {
    if (done) return false;
    done = true;
    clearTimeout(fallbackTimer);
    clearTimeout(deadlineTimer);
    for (const attempt of attempts) retire(attempt, attempt !== winner);
    return true;
  }

  function fail(family: Family, error: NodeJS.ErrnoException): void {
    if (done) return;
    errors[family] = error;
    if (family === 4) startIPv6();
    if (errors[4] && errors[6] && settle()) {
      callback(Object.assign(new AggregateError([errors[4], errors[6]]), { code: errors[4].code }));
    }
  }

  function start(family: Family): void {
    let socket: net.Socket;
    try {
      socket = net.connect({ host: family === 4 ? "127.0.0.1" : "::1", family, port });
    } catch (error) {
      fail(family, error as NodeJS.ErrnoException);
      return;
    }
    const onConnect = () => {
      if (settle(attempt)) callback(null, socket);
    };
    const onError = (error: NodeJS.ErrnoException) => {
      retire(attempt, true);
      fail(family, error);
    };
    const onClose = () => onError(socketError("Connection closed before connect", "ECONNRESET"));
    const attempt: Attempt = {
      socket,
      detach: () => {
        socket.off("connect", onConnect);
        socket.off("error", onError);
        socket.off("close", onClose);
      },
    };
    attempts.add(attempt);
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("close", onClose);
  }

  function startIPv6(): void {
    if (done || startedIPv6) return;
    startedIPv6 = true;
    clearTimeout(fallbackTimer);
    start(6);
  }

  // Startup is deferred, but a successful callback runs in the connect event.
  queueMicrotask(() => {
    if (done) return;
    const delay = Math.min(
      net.getDefaultAutoSelectFamilyAttemptTimeout(),
      MAX_TIMER_MS - HEADROOM_MS
    );
    const deadline = Math.max(10_000, delay + HEADROOM_MS);
    fallbackTimer = setTimeout(startIPv6, delay);
    deadlineTimer = setTimeout(() => {
      if (settle()) {
        callback(socketError(`Loopback connection timed out after ${deadline} ms`, "ETIMEDOUT"));
      }
    }, deadline);
    start(4);
  });

  return {
    cancel() {
      if (!settle()) return;
      const error = Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
        code: "ABORT_ERR",
      });
      queueMicrotask(() => callback(error));
    },
  };
}
