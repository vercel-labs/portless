import { defineConfig } from "@vercel/geistdocs/config";
import { siteUrl } from "@/lib/site";

export const config = defineConfig({
  title: "portless",
  siteUrl,
  defaultLanguage: "en",
  logo: <span className="font-medium">portless</span>,
  navbarActiveProduct: "portless",
  navbarBrand: "labs",
  github: {
    owner: "vercel-labs",
    repo: "portless",
    branch: "main",
    editPath: "apps/docs/content/docs",
  },
  content: [{ id: "docs", label: "Documentation", dir: "content/docs", route: "/" }],
  nav: [
    { label: "Docs", href: "/" },
    { label: "npm", href: "https://www.npmjs.com/package/portless", external: true },
  ],
  ai: { enabled: false },
  feedback: { enabled: false },
  language: { enabled: false },
  pageActions: { askAI: false, openInChat: false },
  webmcp: { enabled: true },
});
