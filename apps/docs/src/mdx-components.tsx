import type { MDXComponents } from "mdx/types";

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    h1: (props) => (
      <h1
        className="mb-6 text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100"
        {...props}
      />
    ),
    h2: (props) => (
      <h2
        className="mb-4 mt-12 text-lg font-semibold text-neutral-900 first:mt-0 dark:text-neutral-100"
        {...props}
      />
    ),
    h3: (props) => (
      <h3
        className="mb-3 mt-8 text-base font-semibold text-neutral-900 dark:text-neutral-100"
        {...props}
      />
    ),
    p: (props) => (
      <p
        className="mb-4 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400"
        {...props}
      />
    ),
    ul: (props) => <ul className="mb-4 list-disc space-y-1 pl-5 text-sm" {...props} />,
    ol: (props) => <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm" {...props} />,
    li: (props) => <li className="text-neutral-600 dark:text-neutral-400" {...props} />,
    a: (props) => (
      <a
        className="text-neutral-900 underline decoration-neutral-300 underline-offset-2 hover:decoration-neutral-900 dark:text-neutral-100 dark:decoration-neutral-700 dark:hover:decoration-neutral-100"
        {...props}
      />
    ),
    code: (props) => {
      const isBlock = typeof props.className === "string" && props.className.includes("language-");
      if (isBlock) return <code {...props} />;
      return (
        <code
          className="rounded bg-neutral-100 px-1.5 py-0.5 text-[13px] dark:bg-neutral-800"
          {...props}
        />
      );
    },
    pre: (props) => (
      <pre
        className="mb-4 overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-[13px] leading-relaxed dark:border-neutral-800 dark:bg-neutral-900"
        {...props}
      />
    ),
    blockquote: (props) => (
      <blockquote
        className="mb-4 border-l-2 border-neutral-200 pl-4 text-sm text-neutral-500 dark:border-neutral-800 dark:text-neutral-500"
        {...props}
      />
    ),
    table: (props) => (
      <div className="mb-4 overflow-x-auto">
        <table className="w-full text-sm" {...props} />
      </div>
    ),
    th: (props) => (
      <th
        className="border-b border-neutral-200 px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-neutral-500 dark:border-neutral-800 dark:text-neutral-400"
        {...props}
      />
    ),
    td: (props) => (
      <td
        className="border-b border-neutral-100 px-3 py-2 text-neutral-600 dark:border-neutral-800/50 dark:text-neutral-400"
        {...props}
      />
    ),
    hr: () => <hr className="my-8 border-neutral-200 dark:border-neutral-800" />,
    strong: (props) => (
      <strong className="font-medium text-neutral-900 dark:text-neutral-100" {...props} />
    ),
    ...components,
  };
}
