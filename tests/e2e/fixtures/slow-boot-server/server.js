/* global process, console, setTimeout, setInterval */
import http from "node:http";

// A dev server that takes a while to boot and keeps running when its port is
// taken, as watch-mode runners such as tsx watch, node --watch and nodemon do.
const port = parseInt(process.env.PORT || "3000", 10);
const name = process.env.APP_NAME || "slow-boot";
const bootDelay = parseInt(process.env.BOOT_DELAY_MS || "1500", 10);

setTimeout(() => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`ok:${name}`);
  });
  server.on("error", (err) => {
    console.log(`${name} could not listen on ${port}: ${err.code}`);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`${name} listening on http://127.0.0.1:${port}`);
  });
}, bootDelay);

setInterval(() => {}, 1000);
