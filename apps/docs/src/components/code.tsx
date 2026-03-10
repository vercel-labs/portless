import { codeToHtml } from "shiki";

const vercelDarkTheme = {
  name: "vercel-dark",
  type: "dark" as const,
  colors: {
    "editor.background": "transparent",
    "editor.foreground": "#EDEDED",
  },
  settings: [
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#A1A1A1" },
    },
    {
      scope: ["string", "string.quoted", "string.template", "punctuation.definition.string"],
      settings: { foreground: "#00CA50" },
    },
    {
      scope: ["constant.numeric", "constant.language.boolean", "constant.language.null"],
      settings: { foreground: "#47A8FF" },
    },
    {
      scope: ["keyword", "storage.type", "storage.modifier"],
      settings: { foreground: "#FF4D8D" },
    },
    {
      scope: ["keyword.operator", "keyword.control"],
      settings: { foreground: "#FF4D8D" },
    },
    {
      scope: ["entity.name.function", "support.function", "meta.function-call"],
      settings: { foreground: "#C472FB" },
    },
    {
      scope: ["variable", "variable.other"],
      settings: { foreground: "#EDEDED" },
    },
    {
      scope: ["variable.parameter"],
      settings: { foreground: "#FF9300" },
    },
    {
      scope: ["entity.name.tag", "support.class.component", "entity.name.type"],
      settings: { foreground: "#FF4D8D" },
    },
    {
      scope: ["punctuation", "meta.brace", "meta.bracket"],
      settings: { foreground: "#EDEDED" },
    },
    {
      scope: [
        "support.type.property-name",
        "entity.name.tag.json",
        "meta.object-literal.key",
        "punctuation.support.type.property-name",
      ],
      settings: { foreground: "#FF4D8D" },
    },
    {
      scope: ["entity.other.attribute-name"],
      settings: { foreground: "#00CA50" },
    },
    {
      scope: ["support.type.primitive", "entity.name.type.primitive"],
      settings: { foreground: "#00CA50" },
    },
  ],
};

const vercelLightTheme = {
  name: "vercel-light",
  type: "light" as const,
  colors: {
    "editor.background": "transparent",
    "editor.foreground": "#171717",
  },
  settings: [
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#6B7280" },
    },
    {
      scope: ["string", "string.quoted", "string.template", "punctuation.definition.string"],
      settings: { foreground: "#067A6E" },
    },
    {
      scope: ["constant.numeric", "constant.language.boolean", "constant.language.null"],
      settings: { foreground: "#0070C0" },
    },
    {
      scope: ["keyword", "storage.type", "storage.modifier"],
      settings: { foreground: "#D6409F" },
    },
    {
      scope: ["keyword.operator", "keyword.control"],
      settings: { foreground: "#D6409F" },
    },
    {
      scope: ["entity.name.function", "support.function", "meta.function-call"],
      settings: { foreground: "#6E56CF" },
    },
    {
      scope: ["variable", "variable.other"],
      settings: { foreground: "#171717" },
    },
    {
      scope: ["variable.parameter"],
      settings: { foreground: "#B45309" },
    },
    {
      scope: ["entity.name.tag", "support.class.component", "entity.name.type"],
      settings: { foreground: "#D6409F" },
    },
    {
      scope: ["punctuation", "meta.brace", "meta.bracket"],
      settings: { foreground: "#6B7280" },
    },
    {
      scope: [
        "support.type.property-name",
        "entity.name.tag.json",
        "meta.object-literal.key",
        "punctuation.support.type.property-name",
      ],
      settings: { foreground: "#D6409F" },
    },
    {
      scope: ["entity.other.attribute-name"],
      settings: { foreground: "#067A6E" },
    },
    {
      scope: ["support.type.primitive", "entity.name.type.primitive"],
      settings: { foreground: "#067A6E" },
    },
  ],
};

function DiffBlock({ children }: { children: string }) {
  const lines = children.trim().split("\n");
  return (
    <div className="my-4 rounded-lg border border-neutral-200 bg-neutral-50 text-[13px] font-mono overflow-hidden dark:border-neutral-800 dark:bg-neutral-900">
      <pre className="m-0 overflow-x-auto">
        <code>
          {lines.map((line, i) => {
            let cls = "block px-4";
            if (i === 0) cls += " pt-4";
            if (i === lines.length - 1) cls += " pb-4";
            if (line.startsWith("+")) cls += " diff-add";
            else if (line.startsWith("-")) cls += " diff-remove";
            return (
              <span key={i} className={cls}>
                {line}
                {"\n"}
              </span>
            );
          })}
        </code>
      </pre>
    </div>
  );
}

interface CodeProps {
  children: string;
  lang?: string;
}

export async function Code({ children, lang = "typescript" }: CodeProps) {
  if (lang === "diff") {
    return <DiffBlock>{children}</DiffBlock>;
  }

  const html = await codeToHtml(children.trim(), {
    lang,
    themes: {
      light: vercelLightTheme,
      dark: vercelDarkTheme,
    },
    defaultColor: false,
  });

  return (
    <div className="my-4 rounded-lg border border-neutral-200 bg-neutral-50 text-[13px] font-mono overflow-hidden dark:border-neutral-800 dark:bg-neutral-900">
      <div
        className="overflow-x-auto [&_pre]:bg-transparent! [&_pre]:m-0! [&_pre]:p-4! [&_code]:bg-transparent! [&_.shiki]:bg-transparent!"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
