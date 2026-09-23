import { createProxy } from "@vercel/geistdocs/proxy";
import { createI18nMiddleware } from "fumadocs-core/i18n/middleware";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { applyDocsResponseHeaders } from "@/lib/docs-response-headers";
import { config as geistdocsConfig } from "@/lib/geistdocs/config";

const localeProxy = createI18nMiddleware({
  defaultLanguage: "en",
  languages: ["en"],
  hideLocale: "default-locale",
});

const geistdocsProxy = createProxy({
  config: geistdocsConfig,
  markdownRoutes: [{ from: "/*path", to: "/api/docs-md/*path" }],
  before: async ({ request, context }) => {
    const { pathname } = request.nextUrl;
    if (pathname === "/en" || pathname.startsWith("/en/")) {
      const destination = request.nextUrl.clone();
      destination.pathname = pathname.slice(3) || "/";
      return NextResponse.redirect(destination, 308);
    }
    if (
      request.headers.get("rsc") === "1" ||
      request.headers.has("next-router-prefetch") ||
      request.headers.has("next-router-segment-prefetch") ||
      /\bprefetch\b/i.test(request.headers.get("purpose") ?? "") ||
      /\bprefetch\b/i.test(request.headers.get("sec-purpose") ?? "")
    ) {
      return (await localeProxy(request, context)) ?? NextResponse.next();
    }
  },
});

export default async function proxy(request: NextRequest, event: NextFetchEvent) {
  const { pathname } = request.nextUrl;
  try {
    decodeURIComponent(pathname);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    const response = new NextResponse("Not Found", { status: 404 });
    applyDocsResponseHeaders(response.headers);
    return response;
  }
  if (
    pathname !== "/en" &&
    !pathname.startsWith("/en/") &&
    (pathname.includes(".") ||
      /^\/(?:api(?:\/|$)|og(?:\/|$)|_next(?:\/|$)|favicon|manifest|robots|health|status)/.test(
        pathname
      ))
  ) {
    return NextResponse.next();
  }
  const response = await geistdocsProxy(request, event);
  for (const header of ["x-middleware-rewrite", "location"]) {
    const target = response.headers.get(header);
    if (!target) continue;
    const destination = new URL(target);
    if (
      destination.hostname === "localhost" &&
      request.headers.get("host") === `127.0.0.1:${destination.port}`
    ) {
      destination.hostname = "127.0.0.1";
      response.headers.set(header, destination.toString());
    }
  }
  applyDocsResponseHeaders(response.headers);
  return response;
}

export const config = {
  matcher: [
    "/(.*%.*)",
    "/en/:path*",
    "/((?!api(?:/|$)|og(?:/|$)|_next(?:/|$)|.*\\..*|favicon|manifest|robots|health|status).*)",
  ],
};
