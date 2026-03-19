import { readFile } from "fs/promises";
import { join } from "path";
import { allDocsPages } from "./docs-navigation";
import { mdxToCleanMarkdown } from "./mdx-to-markdown";

export type IndexEntry = {
  title: string;
  href: string;
  content: string;
};

let cached: IndexEntry[] | null = null;

function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function mdxFileForSlug(slug: string): string {
  const docsRoot = join(process.cwd(), "src", "app");
  if (slug === "/") {
    return join(docsRoot, "page.mdx");
  }
  const rest = slug.replace(/^\//, "");
  return join(docsRoot, ...rest.split("/"), "page.mdx");
}

export async function getSearchIndex(): Promise<IndexEntry[]> {
  if (cached) return cached;

  const entries: IndexEntry[] = [];

  for (const item of allDocsPages) {
    try {
      const raw = await readFile(mdxFileForSlug(item.href), "utf-8");
      const md = mdxToCleanMarkdown(raw);
      const content = stripMarkdown(md);
      entries.push({
        title: item.name,
        href: item.href,
        content,
      });
    } catch {
      entries.push({
        title: item.name,
        href: item.href,
        content: "",
      });
    }
  }

  cached = entries;
  return entries;
}
