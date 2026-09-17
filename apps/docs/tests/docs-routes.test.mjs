import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { test } from "node:test";

const base = process.env.DOCS_TEST_URL;
if (!base) throw new Error("Run pnpm --filter @portless/docs test:routes after building the docs.");
const noindex = process.env.DOCS_EXPECT_NOINDEX === "1";
const { pages } = JSON.parse(
  await readFile(new URL("fixtures/docs-baseline.json", import.meta.url), "utf8")
);
const origin = "https://portless.sh";
const browser = { "user-agent": "Mozilla/5.0", accept: "text/html" };
const representationInputs = [
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
const get = (path, options = {}) =>
  fetch(new URL(path, base), {
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
    ...options,
    headers: { ...browser, ...options.headers },
  });
const canonical = (path) => `${origin}${path === "/" ? "" : path}`;
const markdownPath = (path) => (path === "/" ? "/index.md" : `${path}.md`);
const apiPath = (path) => `/api/docs-md${path === "/" ? "" : path}`;
const hash = (body) => createHash("sha256").update(body).digest("hex");
const tokens = (value) =>
  (value ?? "")
    .toLowerCase()
    .split(/\s*,\s*/)
    .filter(Boolean);
const decode = (value) =>
  value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => {
    if (entity.startsWith("#"))
      return String.fromCodePoint(
        entity[1].toLowerCase() === "x"
          ? Number.parseInt(entity.slice(2), 16)
          : Number(entity.slice(1))
      );
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[entity.toLowerCase()];
  });
const text = (html) =>
  decode(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
const attributes = (tag) =>
  Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((match) => [
      match[1].toLowerCase(),
      decode(match[2] ?? match[3]),
    ])
  );
const tags = (html, name) =>
  [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map(([tag]) => attributes(tag));
const meta = (html, key) =>
  tags(html, "meta")
    .filter((tag) => tag.name === key || tag.property === key)
    .map((tag) => tag.content);

function responseType(response, expected, status = 200) {
  assert.equal(response.status, status, response.url);
  assert.equal(response.headers.get("content-type")?.split(";")[0], expected, response.url);
}

function privateRepresentation(response, next = false) {
  const vary = tokens(response.headers.get("vary"));
  for (const input of [...representationInputs, ...(next ? ["next-router-state-tree"] : [])]) {
    assert.ok(vary.includes(input), `${response.url}: Vary missing ${input}: ${vary}`);
  }
  const cache = tokens(response.headers.get("cache-control"));
  assert.ok(cache.includes("private") && cache.includes("no-store"), `${response.url}: ${cache}`);
  assert.ok(!cache.includes("public"));
  for (const name of ["cdn-cache-control", "vercel-cdn-cache-control"]) {
    assert.ok(tokens(response.headers.get(name)).includes("no-store"), `${response.url}: ${name}`);
  }
}

function indexing(response, html) {
  const values = tokens(response.headers.get("x-robots-tag"));
  if (html) values.push(...meta(html, "robots").flatMap(tokens));
  if (noindex) {
    assert.ok(tokens(response.headers.get("x-robots-tag")).includes("noindex"), response.url);
    if (html) assert.ok(meta(html, "robots").flatMap(tokens).includes("noindex"), response.url);
  } else {
    assert.ok(
      !values.some((value) => ["noindex", "nofollow", "none"].includes(value)),
      `${response.url}: ${values}`
    );
  }
}

for (const page of pages) {
  test(`${page.path}: original MDX body is unchanged`, async () => {
    const slug = page.path === "/" ? "index" : page.path.slice(1);
    const raw = await readFile(new URL(`../content/docs/${slug}.mdx`, import.meta.url), "utf8");
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
    assert.equal(hash(`# ${page.markdownTitle}\n${body}`), page.mdxSha256, page.source);
  });

  test(`${page.path}: HTML retains metadata, JSON-LD and server-rendered content`, async () => {
    const response = await get(page.path);
    responseType(response, "text/html");
    privateRepresentation(response, true);
    assert.equal(response.headers.get("set-cookie"), null);
    const html = await response.text();
    indexing(response, html);
    assert.deepEqual(
      [...html.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)].map((match) => text(match[1])),
      [page.title]
    );
    assert.deepEqual(meta(html, "description"), [page.description]);
    assert.deepEqual(
      tags(html, "link")
        .filter((tag) => tag.rel === "canonical")
        .map((tag) => tag.href),
      [canonical(page.path)]
    );
    assert.deepEqual(
      tags(html, "link")
        .filter((tag) => tag.rel === "alternate" && tag.type === "text/markdown")
        .map((tag) => tag.href),
      [`${origin}${markdownPath(page.path)}`]
    );
    for (const [key, expected] of Object.entries({
      "og:title": page.title,
      "og:description": page.description,
      "og:url": canonical(page.path),
      "og:type": "website",
      "og:site_name": "portless",
      "og:locale": "en_US",
      "og:image": `${origin}/og${page.path === "/" ? "" : page.path}`,
      "og:image:width": "1200",
      "og:image:height": "630",
      "og:image:alt": page.path === "/" ? "portless" : `${page.markdownTitle} - portless`,
      "twitter:card": "summary_large_image",
      "twitter:title": page.title,
      "twitter:description": page.description,
      "twitter:image": `${origin}/og${page.path === "/" ? "" : page.path}`,
    }))
      assert.deepEqual(meta(html, key), [expected], `${page.path}: ${key}`);
    const structured = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
      .filter((match) => attributes(match[1]).type === "application/ld+json")
      .map((match) => JSON.parse(match[2]));
    assert.ok(
      structured.some(
        (data) =>
          data["@context"] === "https://schema.org" &&
          data["@type"] === "WebSite" &&
          data.name === "portless" &&
          data.url === origin &&
          data.description === page.description
      ),
      "WebSite JSON-LD retained"
    );
    const h1 = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)];
    assert.equal(h1.length, 1);
    assert.equal(text(h1[0][1]), page.markdownTitle);
    const rendered = text(html);
    for (const sample of page.ssr)
      assert.ok(rendered.includes(sample), `${page.path}: SSR missing ${sample}`);
  });

  test(`${page.path}: every original heading remains addressable in SSR`, async () => {
    const response = await get(page.path);
    responseType(response, "text/html");
    const html = await response.text();
    const headings = [...html.matchAll(/<h([2-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi)].map((match) => [
      Number(match[1]),
      text(match[3]),
      attributes(match[2]).id,
    ]);
    for (const heading of page.headings.filter(([level]) => level > 1)) {
      assert.deepEqual(
        headings.filter(([, , id]) => id === heading[2]),
        [heading],
        `${page.path}: ${heading[2]}`
      );
    }
  });

  test(`${page.path}: explicit, negotiated and API Markdown have exact baseline parity`, async () => {
    const bodies = [];
    for (const [path, headers] of [
      [markdownPath(page.path), {}],
      [page.path, { accept: "text/markdown" }],
      [apiPath(page.path), {}],
    ]) {
      const response = await get(path, { headers });
      responseType(response, "text/markdown");
      privateRepresentation(response);
      indexing(response);
      assert.equal(response.headers.get("link"), `<${canonical(page.path)}>; rel="canonical"`);
      const body = await response.text();
      const frontmatter = `---\ntitle: ${JSON.stringify(page.markdownTitle)}\ndescription: ${JSON.stringify(page.description)}\ncanonical_url: ${JSON.stringify(canonical(page.path))}\n---\n`;
      assert.ok(body.startsWith(frontmatter), `${path}: canonical frontmatter`);
      assert.equal(
        hash(body.slice(frontmatter.length)),
        page.markdownBodySha256,
        `${path}: original Markdown body`
      );
      bodies.push(body);
    }
    assert.equal(bodies[0], bodies[1]);
    assert.equal(bodies[0], bodies[2]);
  });

  test(`${page.path}: HEAD keeps representation headers without a body`, async () => {
    for (const [path, headers, type] of [
      [page.path, {}, "text/html"],
      [markdownPath(page.path), {}, "text/markdown"],
      [page.path, { accept: "text/markdown" }, "text/markdown"],
      [apiPath(page.path), {}, "text/markdown"],
    ]) {
      const response = await get(path, { method: "HEAD", headers });
      responseType(response, type);
      privateRepresentation(response, type === "text/html");
      indexing(response);
      assert.equal(await response.text(), "");
    }
  });
}

for (const [name, headers, type] of [
  ["q=0 excludes Markdown", { accept: "text/markdown;q=0, text/html" }, "text/html"],
  ["HTML has higher quality", { accept: "text/markdown;q=0.5, text/html;q=1" }, "text/html"],
  [
    "Markdown has higher quality",
    { accept: "text/html;q=0.5, text/markdown;q=1" },
    "text/markdown",
  ],
  ...["Slackbot-LinkExpanding 1.0", "Discordbot/2.0", "Googlebot/2.1"].map((ua) => [
    ua,
    { "user-agent": ua, accept: "*/*" },
    "text/html",
  ]),
  ["ClaudeBot", { "user-agent": "ClaudeBot/1.0", accept: "*/*" }, "text/markdown"],
  ...["next-router-prefetch", "next-router-segment-prefetch", "purpose", "sec-purpose"].map(
    (header) => [
      `${header} bypasses Markdown`,
      {
        "user-agent": "ClaudeBot/1.0",
        accept: "text/markdown",
        [header]: header.startsWith("next-") ? "1" : "prefetch",
      },
      "text/html",
    ]
  ),
  [
    "agent RSC stays Flight",
    { "user-agent": "ClaudeBot/1.0", accept: "text/markdown", rsc: "1" },
    "text/x-component",
  ],
]) {
  test(`negotiation: ${name}`, async () => {
    const response = await get(type === "text/x-component" ? "/commands?_rsc" : "/commands", {
      headers,
    });
    responseType(response, type);
    privateRepresentation(response, type !== "text/markdown");
    const body = await response.text();
    if (type === "text/html") assert.ok(tags(body, "html").length === 1);
    if (type === "text/markdown") assert.ok(body.startsWith('---\ntitle: "Commands"\n'));
    if (type === "text/x-component") assert.ok(!body.startsWith("---\n") && body.length > 0);
  });
}

test("browser navigation overrides agent detection with unmodified Sec-Fetch headers", async () => {
  const response = await new Promise((resolve, reject) => {
    const req = request(
      new URL("/commands", base),
      {
        headers: {
          "user-agent": "ClaudeBot/1.0",
          accept: "*/*",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        },
        signal: AbortSignal.timeout(30000),
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.once("error", reject);
        res.once("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })
          )
        );
      }
    );
    req.once("error", reject);
    req.end();
  });
  responseType(response, "text/html");
  privateRepresentation(response, true);
  assert.equal(tags(await response.text(), "html").length, 1);
});

for (const path of [
  "/missing-page",
  "/docs",
  "/docs/commands",
  "/%",
  "/%25",
  "/%2F",
  "/%5C",
  "/why%2Fcommands",
  "/%252F",
  "/%E0%A4%A",
]) {
  for (const [name, url, headers] of [
    ["HTML", path, {}],
    ["explicit Markdown", `${path}.md`, {}],
    ["negotiated Markdown", path, { accept: "text/markdown" }],
    ["API Markdown", `/api/docs-md${path}`, {}],
  ]) {
    test(`404 ${name}: ${url}`, async () => {
      const response = await get(url, { headers });
      await response.body?.cancel();
      assert.equal(response.status, 404, url);
    });
  }
}

test("locale and trailing slash redirects are permanent, query-preserving and cookie-free", async () => {
  for (const [path, target] of [
    ["/en", "/"],
    ["/en/commands", "/commands"],
    ...pages.filter((page) => page.path !== "/").map((page) => [`${page.path}/`, page.path]),
  ]) {
    const query = "?utm_source=route-test&value=a%2Fb&value=two";
    const response = await get(`${path}${query}`);
    assert.equal(response.status, 308, path);
    assert.equal(response.headers.get("set-cookie"), null, path);
    const location = new URL(response.headers.get("location"), base);
    assert.equal(location.origin, new URL(base).origin);
    assert.equal(location.pathname, target);
    assert.equal(location.search, query);
    await response.body?.cancel();
    const destination = await get(`${location.pathname}${location.search}`);
    responseType(destination, "text/html");
    const html = await destination.text();
    assert.deepEqual(
      tags(html, "link")
        .filter((tag) => tag.rel === "canonical")
        .map((tag) => tag.href),
      [canonical(target)]
    );
    assert.equal(destination.headers.get("set-cookie"), null);
  }
});

test("sitemap, robots and agent indexes expose exactly the six production URLs", async () => {
  const sitemap = await get("/sitemap.xml", { headers: { "user-agent": "ClaudeBot/1.0" } });
  responseType(sitemap, "application/xml");
  indexing(sitemap);
  const locations = [...(await sitemap.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) =>
    decode(match[1])
  );
  assert.deepEqual(locations.sort(), pages.map((page) => `${origin}${page.path}`).sort());
  for (const path of ["/llms.txt", "/sitemap.md"]) {
    const response = await get(path);
    responseType(response, path.endsWith(".md") ? "text/markdown" : "text/plain");
    indexing(response);
    const links = [...(await response.text()).matchAll(/^- \[([^\]]+)\]\(([^)]+)\)/gm)].map(
      (match) => [match[1], match[2]]
    );
    assert.deepEqual(
      links,
      pages.map((page) => [page.markdownTitle, canonical(page.path)])
    );
  }
  const robots = await get("/robots.txt", {
    headers: { "user-agent": "ClaudeBot/1.0", accept: "text/markdown" },
  });
  responseType(robots, "text/plain");
  indexing(robots);
  const directives = (await robots.text())
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
  assert.ok(directives.includes("user-agent: *"));
  assert.ok(directives.includes(`sitemap: ${origin}/sitemap.xml`));
  assert.ok(directives.includes(noindex ? "disallow: /" : "allow: /"));
  if (!noindex) assert.ok(!directives.some((line) => /^disallow:\s*\S/.test(line)));
});

test("search indexes body text, not only titles, and returns addressable fragments", async () => {
  const response = await get("/api/search?query=EADDRINUSE&locale=en");
  responseType(response, "application/json");
  const results = await response.json();
  assert.ok(Array.isArray(results));
  assert.ok(
    results.some(
      (result) =>
        result.type === "text" &&
        result.url === "/why#port-conflicts" &&
        result.content.includes("EADDRINUSE")
    )
  );
});

test("search retains configuration table body content", async () => {
  const response = await get("/api/search?query=PORTLESS_SYNC_HOSTS&locale=en");
  responseType(response, "application/json");
  const results = await response.json();
  assert.ok(
    results.some((result) => result.url?.split("#")[0] === "/configuration"),
    `Missing /configuration table result; got ${results.map((result) => result.url).join(", ")}`
  );
});

test("search returns empty results for unmatched, empty and absent queries", async () => {
  for (const query of [
    "?query=zzzyyy-nonexistent-123456&locale=en",
    "?query=&locale=en",
    "?locale=en",
  ]) {
    const response = await get(`/api/search${query}`);
    responseType(response, "application/json");
    assert.deepEqual(await response.json(), []);
  }
});

test("OG, favicon and bundled fonts bypass Markdown and locale routing", async () => {
  const headers = { "user-agent": "ClaudeBot/1.0", accept: "text/markdown" };
  for (const page of pages) {
    const response = await get(`/og${page.path === "/" ? "" : page.path}`, { headers });
    responseType(response, "image/png");
    assert.deepEqual(
      [...new Uint8Array(await response.arrayBuffer()).slice(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10]
    );
  }
  const favicon = await get("/favicon.ico", { headers });
  assert.equal(favicon.status, 200);
  assert.match(favicon.headers.get("content-type"), /^image\//);
  assert.ok((await favicon.arrayBuffer()).byteLength > 0);
  const home = await get("/");
  const html = await home.text();
  const font =
    tags(html, "link").find((tag) => tag.as === "font" && tag.href.startsWith("/_next/"))?.href ??
    /<([^>]+\.woff2)>/.exec(home.headers.get("link") ?? "")?.[1];
  assert.ok(font?.startsWith("/_next/"), "SSR preloads a bundled font in HTML or Link headers");
  const response = await get(font, { headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^(font\/|application\/(font|octet-stream))/);
  assert.ok((await response.arrayBuffer()).byteLength > 0);
});
