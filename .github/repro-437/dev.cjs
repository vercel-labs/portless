// Stand-in for a raw-mode dev server (Vite/Next keypress handling), from #437.
const fs = require("fs");
const path = require("path");
const out = process.env.REPRO_OUT;
const log = (line) => fs.appendFileSync(path.join(out, "dev.log"), line + "\n");
// Under turbo the child may not own a TTY; raw mode is only possible with one.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (b) => log("STOLE " + JSON.stringify(b.toString())));
require("http")
  .createServer((_, res) => res.end("ok"))
  .listen(Number(process.env.PORT), "127.0.0.1", () => {
    fs.writeFileSync(path.join(out, "dev.pid"), String(process.pid));
    log("TTY " + Boolean(process.stdin.isTTY));
    log("DEVUP pid=" + process.pid + " ppid=" + process.ppid);
  });
const exitAfter = Number(process.env.DEV_EXIT_AFTER_MS || 0);
if (exitAfter) setTimeout(() => process.exit(0), exitAfter);
setInterval(() => {}, 1000);
