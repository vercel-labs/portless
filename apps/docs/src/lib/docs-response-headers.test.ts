import { describe, expect, test } from "vitest";
import { applyDocsResponseHeaders } from "./docs-response-headers";

const required = [
  "accept",
  "user-agent",
  "signature-agent",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "rsc",
  "next-router-prefetch",
  "next-router-segment-prefetch",
  "purpose",
  "sec-purpose",
];

const varyTokens = (headers: Headers) =>
  headers
    .get("vary")!
    .toLowerCase()
    .split(/\s*,\s*/);

describe("docs response headers", () => {
  test("adds every representation input and disables shared caching", () => {
    const headers = new Headers({
      "Cache-Control": "public, max-age=3600",
      "CDN-Cache-Control": "max-age=3600",
      "Vercel-CDN-Cache-Control": "max-age=3600",
      "Content-Type": "text/markdown; charset=utf-8",
      Link: '<https://portless.sh/commands>; rel="canonical"',
    });

    applyDocsResponseHeaders(headers);

    expect(varyTokens(headers).sort()).toEqual([...required].sort());
    expect(headers.get("cache-control")).toBe("private, no-store");
    expect(headers.get("cdn-cache-control")).toBe("no-store");
    expect(headers.get("vercel-cdn-cache-control")).toBe("no-store");
    expect(headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(headers.get("link")).toBe('<https://portless.sh/commands>; rel="canonical"');
  });

  test("merges case-insensitively, preserves Next RSC tokens, and is idempotent", () => {
    const existing = ["next-router-state-tree", "next-url", "accept-encoding"];
    const headers = new Headers({
      Vary: "RSC, Next-Router-State-Tree, Next-Url, Accept-Encoding, ACCEPT, accept, , User-Agent",
    });

    applyDocsResponseHeaders(headers);
    const once = headers.get("vary");
    applyDocsResponseHeaders(headers);

    expect(headers.get("vary")).toBe(once);
    const tokens = varyTokens(headers);
    expect(tokens.sort()).toEqual([...required, ...existing].sort());
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  test("retains wildcard Vary rather than narrowing an upstream response", () => {
    const headers = new Headers({ Vary: "*" });
    applyDocsResponseHeaders(headers);
    expect(varyTokens(headers)).toContain("*");
  });
});
