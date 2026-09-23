import type { Metadata } from "next";
import { PAGE_TITLES } from "./page-titles";
import { siteDescription, siteUrl } from "./site";

export function pageMetadata(slug: string): Metadata {
  const title = PAGE_TITLES[slug];
  if (!title) return {};

  const displayTitle = title.replace(/\n/g, " ");
  const fullTitle = slug
    ? `${displayTitle} | portless`
    : "portless | Named .localhost URLs for Development";
  const ogImageUrl = slug ? `/og/${slug}` : "/og";

  return {
    title: slug ? displayTitle : { absolute: fullTitle },
    description: siteDescription,
    ...(process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production"
      ? { robots: { index: false, follow: false } }
      : {}),
    alternates: {
      canonical: `/${slug}`,
      types: { "text/markdown": slug ? `/${slug}.md` : "/index.md" },
    },
    openGraph: {
      url: `${siteUrl}${slug ? `/${slug}` : ""}`,
      type: "website",
      locale: "en_US",
      siteName: "portless",
      title: fullTitle,
      description: siteDescription,
      images: [
        {
          url: ogImageUrl,
          width: 1200,
          height: 630,
          alt: slug ? `${displayTitle} - portless` : "portless",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description: siteDescription,
      images: [ogImageUrl],
    },
  };
}
