import { generateNotFoundMarkdown } from "@vercel/agent-readability";
import { loadAllDocsSources, loadDocsSource, normalizeDocsHref } from "./docs-source";
import { canonicalUrlFor, siteName, siteUrl } from "./site";

function frontmatter(fields: { title: string; description: string; canonicalUrl: string }): string {
  return [
    "---",
    `title: ${JSON.stringify(fields.title)}`,
    `description: ${JSON.stringify(fields.description)}`,
    `canonical_url: ${JSON.stringify(fields.canonicalUrl)}`,
    "---",
    "",
  ].join("\n");
}

async function sitemapMarkdown(): Promise<string> {
  const sources = await loadAllDocsSources();
  return [
    `# ${siteName} documentation`,
    "",
    ...sources.map((source) => `- [${source.title}](${source.canonicalUrl})`),
    "",
  ].join("\n");
}

export async function markdownForPathname(pathname: string): Promise<{
  body: string;
  canonicalUrl: string;
  found: boolean;
}> {
  const normalized = normalizeDocsHref(pathname);

  if (normalized === "/sitemap") {
    return {
      body: await sitemapMarkdown(),
      canonicalUrl: `${siteUrl}/sitemap.md`,
      found: true,
    };
  }

  const source = await loadDocsSource(normalized);
  if (source) {
    return {
      body: `${frontmatter({
        title: source.title,
        description: source.description,
        canonicalUrl: source.canonicalUrl,
      })}${source.markdown}\n`,
      canonicalUrl: source.canonicalUrl,
      found: true,
    };
  }

  return {
    body: generateNotFoundMarkdown(normalized, {
      sitemapUrl: "/sitemap.md",
      indexUrl: "/llms.txt",
      exampleUrl: "/commands",
      baseUrl: siteUrl,
    }),
    canonicalUrl: canonicalUrlFor(normalized),
    found: false,
  };
}
