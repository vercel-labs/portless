import { applyMarkdownHeaders, generateNotFoundMarkdown } from "@vercel/agent-readability";
import { isSafePathSegments } from "@/lib/docs-source";
import { applyDocsResponseHeaders } from "@/lib/docs-response-headers";
import { markdownForPathname } from "@/lib/page-markdown";
import { canonicalUrlFor, siteUrl } from "@/lib/site";

type RouteContext = {
  params: Promise<{ slug?: string[] }>;
};

export async function GET(_request: Request, { params }: RouteContext) {
  const { slug = [] } = await params;
  const safe = isSafePathSegments(slug);
  const pathname = slug.length > 0 ? `/${slug.join("/")}` : "/";
  const page = safe
    ? await markdownForPathname(pathname)
    : {
        body: generateNotFoundMarkdown(pathname, {
          sitemapUrl: "/sitemap.md",
          indexUrl: "/llms.txt",
          exampleUrl: "/commands",
          baseUrl: siteUrl,
        }),
        canonicalUrl: canonicalUrlFor(pathname),
        found: false,
      };
  const headers = new Headers({ "Content-Type": "text/markdown; charset=utf-8" });
  applyMarkdownHeaders(headers, { canonicalUrl: page.canonicalUrl });
  applyDocsResponseHeaders(headers);

  return new Response(page.body, { status: page.found ? 200 : 404, headers });
}
