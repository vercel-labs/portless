import { loadAllDocsSources } from "./docs-source";

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

export async function getSearchIndex(): Promise<IndexEntry[]> {
  if (cached) return cached;

  const sources = await loadAllDocsSources();
  cached = sources.map((source) => ({
    title: source.title,
    href: source.href,
    content: stripMarkdown(source.markdown),
  }));
  return cached;
}
