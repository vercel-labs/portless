import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import console from "node:console";
import { createServer } from "node:net";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";

const { AbortSignal, fetch } = globalThis;
const cwd = fileURLToPath(new URL("../", import.meta.url));
const socket = createServer();
await new Promise((resolve, reject) => {
  socket.once("error", reject);
  socket.listen(0, "127.0.0.1", resolve);
});
const port = socket.address().port;
await new Promise((resolve, reject) =>
  socket.close((error) => (error ? reject(error) : resolve()))
);

function launch(args, env) {
  const child = spawn(process.execPath, args, { cwd, stdio: "inherit", env });
  const result = { child, done: false, exited: undefined };
  result.exited = new Promise((resolve) => {
    child.once("error", (error) => {
      console.error(error.message);
      result.done = true;
      resolve(1);
    });
    child.once("exit", (code) => {
      result.done = true;
      resolve(code ?? 1);
    });
  });
  return result;
}

const server = launch(
  [
    fileURLToPath(import.meta.resolve("next/dist/bin/next")),
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  { ...process.env, NODE_ENV: "production" }
);
const url = `http://127.0.0.1:${port}`;
let tests;
let shutdown;
let stopping = false;
const stop = () => {
  stopping = true;
  shutdown ??= Promise.all(
    [tests, server].map(async (owned) => {
      if (!owned || owned.done) return;
      owned.child.kill("SIGTERM");
      const deadline = setTimeout(() => owned.child.kill("SIGKILL"), 5000);
      try {
        await owned.exited;
      } finally {
        clearTimeout(deadline);
      }
    })
  );
  return shutdown;
};
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, () => {
    void stop().finally(() => process.exit(code));
  });
}

try {
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline && !stopping) {
    if (server.done) throw new Error(`Docs server exited with ${await server.exited}`);
    try {
      const response = await fetch(`${url}/robots.txt`, {
        signal: AbortSignal.timeout(1000),
      });
      await response.body?.cancel();
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      ready = false;
    }
    await sleep(100);
  }
  if (!ready && !stopping)
    throw new Error("Docs server did not become ready. Run the docs build first.");
  if (!stopping) {
    const script = await fetch(`${url}/api/mcp?webmcp-script`, {
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type"), /^(application|text)\/javascript\b/);
    assert.ok((await script.text()).length > 0);

    const rpc = async (method, params) => {
      const response = await fetch(`${url}/api/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(30000),
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      const body = JSON.parse(
        response.headers.get("content-type")?.includes("text/event-stream")
          ? text
              .split(/\r?\n/)
              .find((line) => line.startsWith("data:"))
              ?.slice(5)
          : text
      );
      assert.equal(body.jsonrpc, "2.0");
      assert.equal(body.id, 1);
      assert.equal(body.error, undefined);
      return body.result;
    };
    const { tools } = await rpc("tools/list", {});
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["search_docs"]
    );
    const result = await rpc("tools/call", {
      name: "search_docs",
      arguments: { query: "EADDRINUSE", locale: "en" },
    });
    assert.ok(!result.isError);
    const results = result.content
      .filter((content) => content.type === "text")
      .flatMap((content) => JSON.parse(content.text));
    assert.ok(
      results.some(
        (item) => item.url === "/why#port-conflicts" && item.content.includes("EADDRINUSE")
      )
    );
    console.log("MCP route checks: 3 passed (bridge script, tools/list, tools/call)");

    tests = launch(["--test", "tests/docs-routes.test.mjs"], {
      ...process.env,
      DOCS_TEST_URL: url,
    });
    process.exitCode = await tests.exited;
  }
} finally {
  await stop();
}
