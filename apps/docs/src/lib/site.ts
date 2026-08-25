export const siteUrl = "https://portless.sh";
export const siteName = "portless";
export const siteDescription =
  "Replace port numbers with stable, named .localhost URLs. For humans and agents.";

export function canonicalUrlFor(href: string): string {
  return `${siteUrl}${href === "/" ? "" : href}`;
}
