type CleanMarkdownState =
  | { kind: "prose" }
  | { kind: "fence"; marker: "`" | "~"; length: number }
  | { kind: "jsx"; depth: number };

function parseOpeningFence(line: string): { marker: "`" | "~"; length: number } | null {
  const match = line.replace(/\r$/, "").match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  const fence = match[1];
  const rest = match[2];
  const marker = fence[0] as "`" | "~";
  if (marker === "`" && rest.includes("`")) return null;
  return { marker, length: fence.length };
}

function isClosingFence(line: string, marker: "`" | "~", length: number): boolean {
  const match = line.replace(/\r$/, "").match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
  if (!match) return false;
  return match[1][0] === marker && match[1].length >= length;
}

/**
 * Converts raw MDX content to clean Markdown suitable for indexing.
 *
 * Strips top-level export/import statements and standalone JSX divs with
 * className attributes outside fenced code blocks, passing everything else
 * through unchanged.
 */
export function mdxToCleanMarkdown(raw: string): string {
  const lines = raw.split("\n");
  const out: string[] = [];
  let state: CleanMarkdownState = { kind: "prose" };

  for (const line of lines) {
    if (state.kind === "fence") {
      out.push(line);
      if (isClosingFence(line, state.marker, state.length)) {
        state = { kind: "prose" };
      }
      continue;
    }

    if (state.kind === "jsx") {
      const opens = (line.match(/<div[\s>]/g) || []).length;
      const closes = (line.match(/<\/div>/g) || []).length;
      const nextDepth: number = state.depth + opens - closes;
      state = nextDepth <= 0 ? { kind: "prose" } : { kind: "jsx", depth: nextDepth };
      continue;
    }

    const opening = parseOpeningFence(line);
    if (opening) {
      out.push(line);
      state = { kind: "fence", marker: opening.marker, length: opening.length };
      continue;
    }

    const trimmed = line.trim();

    if (trimmed.startsWith("export ") || trimmed.startsWith("import ")) {
      continue;
    }

    if (trimmed.startsWith("<div ") && trimmed.includes("className=")) {
      const opens = (line.match(/<div[\s>]/g) || []).length;
      const closes = (line.match(/<\/div>/g) || []).length;
      const depth = opens - closes;
      if (depth > 0) {
        state = { kind: "jsx", depth };
      }
      continue;
    }

    out.push(line);
  }

  let result = out.join("\n");
  result = result.replace(/^\n+/, "\n").trim();
  return result;
}
