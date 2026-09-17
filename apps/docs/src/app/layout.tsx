import type { Metadata, Viewport } from "next";
import { Footer } from "@vercel/geistdocs/footer";
import { Navbar } from "@vercel/geistdocs/navbar";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { cookies } from "next/headers";
import { DocsChat } from "@/components/docs-chat";
import { DocsProvider } from "@/components/geistdocs-provider";
import { config } from "@/lib/geistdocs/config";
import "./globals.css";

export const viewport: Viewport = { viewportFit: "cover" };

export const metadata: Metadata = {
  metadataBase: new URL("https://portless.sh"),
  title: {
    default: "portless | Named .localhost URLs for Development",
    template: "%s | portless",
  },
  description: "Replace port numbers with stable, named .localhost URLs. For humans and agents.",
  alternates: {
    canonical: "/",
    types: { "text/markdown": "/index.md" },
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://portless.sh",
    siteName: "portless",
    title: "portless | Named .localhost URLs for Development",
    description: "Replace port numbers with stable, named .localhost URLs. For humans and agents.",
    images: [{ url: "/og", width: 1200, height: 630, alt: "portless" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "portless | Named .localhost URLs for Development",
    description: "Replace port numbers with stable, named .localhost URLs. For humans and agents.",
    images: ["/og"],
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const chatOpen = cookieStore.get("docs-chat-open")?.value === "true";
  const storedWidth = Number(cookieStore.get("docs-chat-width")?.value);
  const chatWidth =
    Number.isFinite(storedWidth) && storedWidth > 0
      ? Math.min(700, Math.max(300, storedWidth))
      : 400;
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "portless",
    url: "https://portless.sh",
    description: "Replace port numbers with stable, named .localhost URLs. For humans and agents.",
  };

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable} antialiased`}
    >
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
        {chatOpen && (
          <style
            dangerouslySetInnerHTML={{
              __html: `@media(min-width:1280px){body{padding-right:${chatWidth}px}}`,
            }}
          />
        )}
      </head>
      <body>
        <DocsProvider>
          <Navbar config={config} />
          {children}
          <Footer />
          <DocsChat defaultOpen={chatOpen} defaultWidth={chatWidth} />
        </DocsProvider>
      </body>
    </html>
  );
}
