export type NavItem = {
  name: string;
  href: string;
};

export const allDocsPages: NavItem[] = [
  { name: "Getting Started", href: "/docs" },
  { name: "Why Portless", href: "/docs/why" },
  { name: "Commands", href: "/docs/commands" },
  { name: "HTTPS", href: "/docs/https" },
  { name: "Configuration", href: "/docs/configuration" },
];
