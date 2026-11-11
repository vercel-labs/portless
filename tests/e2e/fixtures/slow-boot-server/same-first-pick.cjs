/* global process */
// Preloaded into the portless CLI. The first port that findFreePort draws is
// FIRST_PICK_PORT, so every concurrent run probes the same port first. Other
// Math.random() calls (lock retry jitter, later draws) stay random, so a run
// that is refused can pick another port.
const port = Number(process.env.FIRST_PICK_PORT);
const random = Math.random;
let forced = false;
Math.random = () => {
  if (!forced && new Error().stack.includes("findFreePort")) {
    forced = true;
    return (port - 4000 + 0.5) / 1000;
  }
  return random();
};
