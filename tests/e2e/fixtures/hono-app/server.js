/* global process, console */
import { Hono } from "hono";
import { serve } from "@hono/node-server";

const app = new Hono();
app.get("/", (c) => c.html("<h1>hello from hono</h1>"));

const port = parseInt(process.env.PORT || "3000", 10);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`Listening on http://127.0.0.1:${port}`);
});
