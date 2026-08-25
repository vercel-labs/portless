import { withAgentReadability } from "@vercel/agent-readability/next";

export default withAgentReadability({
  docsPrefix: "/",
  rewrite: (pathname) => (pathname === "/" ? "/api/docs-md" : `/api/docs-md${pathname}`),
  canonicalUrl: () => null,
});

export const config = {
  matcher: "/((?!_next|api|og|.*\\..*|favicon|manifest|robots|health|status).*)",
};
