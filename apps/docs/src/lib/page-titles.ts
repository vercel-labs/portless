export const PAGE_TITLES: Record<string, string> = {
  "": "Replace Port Numbers\nwith Named URLs",
  why: "Why Portless",
  commands: "Commands",
  https: "HTTPS",
  configuration: "Configuration",
  changelog: "Changelog",
};

export function getPageTitle(slug: string): string | null {
  return slug in PAGE_TITLES ? PAGE_TITLES[slug]! : null;
}
