import type { MetadataRoute } from "next";
import { allDocsPages } from "@/lib/docs-navigation";

const baseUrl = "https://portless.sh";

export default function sitemap(): MetadataRoute.Sitemap {
  return allDocsPages.map((page) => ({
    url: `${baseUrl}${page.href}`,
    lastModified: new Date(),
  }));
}
