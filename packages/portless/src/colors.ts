/** NO_COLOR set to a non-empty value disables color. FORCE_COLOR "0" or "false" disables it, any other set value forces it. */
export function supportsColor(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false";
  return isTTY;
}

const streamColor = {
  stdout: supportsColor(process.env, !!process.stdout.isTTY),
  stderr: supportsColor(process.env, !!process.stderr.isTTY),
};
const enabled = streamColor.stdout || streamColor.stderr;

const COLOR_CODES = new RegExp(String.raw`\x1b\[(?:1|2|22|31|33|39)m`, "g");

/** Remove the color codes this module adds, leaving any other escape sequence in place. */
export function stripColor(text: string): string {
  return text.replace(COLOR_CODES, "");
}

/** Text for a direct write to stdout or stderr, colored only when that stream supports color. */
export function colorFor(stream: "stdout" | "stderr", text: string): string {
  return streamColor[stream] ? text : stripColor(text);
}

/** Make a console method print without color, for a stream that does not support it. */
function printPlain(method: "log" | "info" | "error" | "warn"): void {
  const print = console[method].bind(console);
  console[method] = (...args: unknown[]) =>
    print(...args.map((arg) => (typeof arg === "string" ? stripColor(arg) : arg)));
}

if (enabled && !streamColor.stdout) {
  printPlain("log");
  printPlain("info");
}
if (enabled && !streamColor.stderr) {
  printPlain("error");
  printPlain("warn");
}

const wrap = (open: string, close: string) => {
  if (!enabled) return (s: string) => s;
  return (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;
};

const identity = (s: string) => s;

const bold = wrap("1", "22");
const dim = wrap("2", "22");

const red = wrap("31", "39");
const green = identity;
const yellow = wrap("33", "39");
const blue = Object.assign(identity, { bold } as { bold: (s: string) => string });
const cyan = Object.assign(identity, { bold } as { bold: (s: string) => string });
const white = identity;
const gray = dim;

export default { bold, dim, red, green, yellow, blue, cyan, white, gray };
