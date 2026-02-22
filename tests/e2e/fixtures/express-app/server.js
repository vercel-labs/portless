/* global process, console */
import { createServer } from "node:http";

const port = parseInt(process.env.PORT || "3000", 10);
createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<h1>hello from express</h1>");
}).listen(port, "127.0.0.1", () => {
  console.log(`Listening on http://127.0.0.1:${port}`);
});
