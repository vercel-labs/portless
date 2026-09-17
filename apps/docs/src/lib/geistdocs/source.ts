import { createSource } from "@vercel/geistdocs/source";
import { docs } from "@/.source/server";
import { markdownForPathname } from "@/lib/page-markdown";
import { config } from "./config";

export const geistdocsSource = createSource({
  docs,
  config,
  baseUrl: "/",
  markdown: {
    transform: async (_markdown, { page }) =>
      (await markdownForPathname(`/${page.slugs.join("/")}`)).body,
  },
});
