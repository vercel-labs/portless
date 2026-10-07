import http from "node:http";

const server = http.createServer((_request, response) => {
  response.end("self-daemon-ok");
});

server.listen(Number(process.env.PORT), "127.0.0.1", () => {
  process.stdout.write("ready\n");
});
