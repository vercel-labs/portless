export type NavItem = {
  name: string;
  href: string;
};

export const allDocsPages: NavItem[] = [
  { name: "Getting Started", href: "/" },
  { name: "Why Portless", href: "/why" },
  { name: "Commands", href: "/commands" },
  { name: "HTTPS", href: "/https" },
  { name: "Configuration", href: "/configuration" },
  { name: "Changelog", href: "/changelog" },
];
