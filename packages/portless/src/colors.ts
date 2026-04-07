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

const bold = wrap("1", "22");
const red = wrap("31", "39");
const green = wrap("32", "39");
const yellow = wrap("33", "39");
const blue = Object.assign(wrap("34", "39"), {
  bold: enabled ? (s: string) => `\x1b[34;1m${s}\x1b[22;39m` : (s: string) => s,
});
const cyan = Object.assign(wrap("36", "39"), {
  bold: enabled ? (s: string) => `\x1b[36;1m${s}\x1b[22;39m` : (s: string) => s,
});
const white = wrap("37", "39");
const gray = wrap("90", "39");

export default { bold, red, green, yellow, blue, cyan, white, gray };
