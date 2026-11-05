/** NO_COLOR set to a non-empty value disables color. FORCE_COLOR "0" or "false" disables it, any other set value forces it. */
export function supportsColor(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false";
  return isTTY;
}

const enabled = supportsColor(process.env, !!(process.stdout.isTTY || process.stderr.isTTY));

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
