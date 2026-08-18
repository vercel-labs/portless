import { withAgentReadability } from "@vercel/agent-readability/next";
import type { NextFetchEvent, NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isPreviewBot } from "@/lib/agent-routing";

const agentMarkdown = withAgentReadability({
  docsPrefix: "/",
  rewrite: (pathname) => (pathname === "/" ? "/api/docs-md" : `/api/docs-md${pathname}`),
  canonicalUrl: () => null,
});

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if (isPreviewBot(request.headers.get("user-agent") ?? "")) {
    return NextResponse.next();
  }
  return agentMarkdown(request, event);
}

export const config = {
  matcher: "/((?!_next|api|og|.*\\..*|favicon|manifest|robots|health|status).*)",
};
