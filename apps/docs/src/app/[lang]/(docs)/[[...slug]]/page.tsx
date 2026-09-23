import { MobileDocsBar } from "@vercel/geistdocs/mobile-docs-bar";
import { createDocsPage } from "@vercel/geistdocs/pages/docs";
import { notFound } from "next/navigation";
import { isSafePathSegments } from "@/lib/docs-source";
import { config } from "@/lib/geistdocs/config";
import { geistdocsSource } from "@/lib/geistdocs/source";
import { pageMetadata } from "@/lib/page-metadata";

type PageProps = {
  params: Promise<{ lang: string; slug?: string[] }>;
};

async function getValidatedPage(params: PageProps["params"]) {
  const resolved = await params;
  if (resolved.lang !== "en" || !isSafePathSegments(resolved.slug ?? [])) notFound();
  try {
    const page = geistdocsSource.source.getPage(resolved.slug, resolved.lang);
    if (!page) notFound();
    return { page, params: resolved };
  } catch (error) {
    if (error instanceof URIError) notFound();
    throw error;
  }
}

const docsPage = createDocsPage({
  config,
  source: geistdocsSource,
  metadata: ({ page }) => pageMetadata(page.slugs.join("/")),
  renderTop: ({ data }) => <MobileDocsBar toc={data.toc} />,
});

export default async function Page({ params }: PageProps) {
  const validated = await getValidatedPage(params);
  return <docsPage.Page params={Promise.resolve(validated.params)} />;
}

export async function generateMetadata({ params }: PageProps) {
  const { page } = await getValidatedPage(params);
  return pageMetadata(page.slugs.join("/"));
}

export const generateStaticParams = docsPage.generateStaticParams;
