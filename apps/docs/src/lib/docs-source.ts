import { readFile } from "fs/promises";
import { join } from "path";
import { allDocsPages } from "./docs-navigation";
import { mdxToCleanMarkdown } from "./mdx-to-markdown";
import { canonicalUrlFor, siteDescription } from "./site";

export type DocsSource = {
  title: string;
  href: string;
  markdownHref: string;
  canonicalUrl: string;
  description: string;
  markdown: string;
};

const sourcePromises = new Map<string, Promise<DocsSource>>();
const pagesByHref = new Map(allDocsPages.map((page) => [page.href, page]));

export function isSafePathSegments(segments: readonly string[]): boolean {
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !segment.includes("/") &&
      !segment.includes("\\")
  );
}

export function normalizeDocsHref(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function sourcePath(href: string): string {
  const docsRoot = join(process.cwd(), "src", "app");
  if (href === "/") return join(docsRoot, "page.mdx");
  return join(docsRoot, ...href.slice(1).split("/"), "page.mdx");
}

export async function loadDocsSource(href: string): Promise<DocsSource | null> {
  const normalized = normalizeDocsHref(href);
  const page = pagesByHref.get(normalized);
  if (!page) return null;

  let pending = sourcePromises.get(normalized);
  if (!pending) {
    pending = readFile(sourcePath(normalized), "utf-8").then((raw) => ({
      title: page.name,
      href: normalized,
      markdownHref: normalized === "/" ? "/index.md" : `${normalized}.md`,
      canonicalUrl: canonicalUrlFor(normalized),
      description: siteDescription,
      markdown: mdxToCleanMarkdown(raw),
    }));
    sourcePromises.set(normalized, pending);
    pending.catch(() => {
      if (sourcePromises.get(normalized) === pending) {
        sourcePromises.delete(normalized);
      }
    });
  }

  return pending;
}

export async function loadAllDocsSources(): Promise<DocsSource[]> {
  const sources = await Promise.all(allDocsPages.map((page) => loadDocsSource(page.href)));
  return sources.filter((source): source is DocsSource => source !== null);
}
