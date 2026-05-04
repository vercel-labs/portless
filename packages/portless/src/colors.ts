function supportsColor(): boolean {
  if ("NO_COLOR" in process.env) return false;
  if ("FORCE_COLOR" in process.env) return true;
  return !!(process.stdout.isTTY || process.stderr.isTTY);
}

const enabled = supportsColor();

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
