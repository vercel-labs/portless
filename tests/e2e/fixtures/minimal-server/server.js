/* global process, console */
import http from "node:http";

const port = parseInt(process.env.PORT || "3000", 10);
const name = process.env.APP_NAME || "minimal";

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`ok:${name}`);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`${name} listening on http://127.0.0.1:${port}`);
});
