import { describe, expect, test } from "vitest";
import { GET as getMarkdown } from "../app/api/docs-md/[[...slug]]/route";
import { allDocsPages } from "./docs-navigation";
import { isSafePathSegments, loadAllDocsSources } from "./docs-source";
import { isPreviewBot } from "./agent-routing";
import { markdownForPathname } from "./page-markdown";

describe("docs source", () => {
  test("loads every inventory page as clean Markdown", async () => {
    const sources = await loadAllDocsSources();
    expect(sources).toHaveLength(allDocsPages.length);
    for (const source of sources) {
      expect(source.markdown).not.toMatch(/^(import|export) /m);
      expect(source.markdown).not.toContain("className=");
    }
  });

  test.each([
    ["parent", [".."]],
    ["slash", ["why/commands"]],
    ["backslash", [String.raw`..\\why`]],
    ["empty", [""]],
  ])("rejects a decoded %s segment", (_name, segments) => {
    expect(isSafePathSegments(segments)).toBe(false);
  });
});

describe("public Markdown", () => {
  test("renders canonical frontmatter for every page", async () => {
    for (const page of allDocsPages) {
      const rendered = await markdownForPathname(page.href);
      expect(rendered.found).toBe(true);
      expect(rendered.body).toContain(`canonical_url: ${JSON.stringify(rendered.canonicalUrl)}`);
      expect(rendered.body).not.toContain("last_updated:");
    }
  });

  test("returns a readable body for missing pages", async () => {
    const rendered = await markdownForPathname("/missing");
    expect(rendered.found).toBe(false);
    expect(rendered.body).toContain("# Page Not Found");
    expect(rendered.body).toContain("/sitemap.md");
  });

  test("serves missing pages with Markdown attribution", async () => {
    const response = await getMarkdown(new Request("https://portless.sh/missing.md"), {
      params: Promise.resolve({ slug: ["missing"] }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("vary")).toContain("Accept");
    expect(response.headers.get("link")).toBe('<https://portless.sh/missing>; rel="canonical"');
    expect(await response.text()).toContain("# Page Not Found");
  });
});

describe("social previews", () => {
  test.each(["Slackbot-LinkExpanding 1.0", "Discordbot/2.0"])("bypasses %s", (ua) => {
    expect(isPreviewBot(ua)).toBe(true);
  });

  test("does not bypass agents", () => {
    expect(isPreviewBot("ClaudeBot/1.0")).toBe(false);
  });
});
