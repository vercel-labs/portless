import {
  defineGeistdocsSourceConfig,
  geistdocsFrontmatterSchema,
  geistdocsMetaSchema,
} from "@vercel/geistdocs/source-config";
import { defineDocs } from "fumadocs-mdx/config";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: geistdocsFrontmatterSchema,
    postprocess: { includeProcessedMarkdown: true },
  },
  meta: { schema: geistdocsMetaSchema },
});

export default defineGeistdocsSourceConfig({
  mdxOptions: {
    remarkStructureOptions: {
      types: [
        "heading",
        "paragraph",
        "blockquote",
        "tableCell",
        "mdxJsxFlowElement",
        "mdxJsxTextElement",
        "text",
        "inlineCode",
        "code",
      ],
    },
  },
});
