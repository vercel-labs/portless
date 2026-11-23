import { defineConfig } from "@vercel/geistdocs/config";
import { siteUrl } from "@/lib/site";

export const config = defineConfig({
  title: "portless",
  siteUrl,
  defaultLanguage: "en",
  logo: (
    <span
      className="font-sans text-[24.4px] font-semibold leading-none tracking-[-0.05em] text-black dark:text-white"
      style={{ transform: "translateY(-0.5px)" }}
    >
      portless
    </span>
  ),
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
