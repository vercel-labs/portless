import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules:
      process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production"
        ? { userAgent: "*", disallow: "/" }
        : { userAgent: "*", allow: "/" },
    sitemap: "https://portless.sh/sitemap.xml",
  };
}
