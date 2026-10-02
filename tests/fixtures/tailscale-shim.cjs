const fs = require("node:fs");

const args = process.argv.slice(2);
const logPath = process.env.PORTLESS_TEST_TAILSCALE_LOG;
if (logPath) fs.appendFileSync(logPath, `${JSON.stringify(args)}\n`);

if (args[0] === "version") {
  process.exit(0);
}

if (args[0] === "status" && args[1] === "--json") {
  console.log(
    JSON.stringify({
      Self: {
        DNSName: "devbox.example.ts.net",
        Capabilities: ["https", "funnel"],
      },
    })
  );
  process.exit(0);
}

if (args[0] === "serve" && args[1] === "status" && args[2] === "--json") {
  console.log(JSON.stringify({ Web: { "devbox.example.ts.net:443": {} } }));
  process.exit(0);
}

if (args[0] === "serve" || args[0] === "funnel") {
  process.exit(0);
}

process.exit(1);
