"use client";

import { useState, useRef, isValidElement } from "react";
import { Check, Copy } from "lucide-react";

interface CodeBlockProps {
  children: React.ReactNode;
  className?: string;
}

export function CodeBlock({ children, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const handleCopy = async () => {
    // Extract text content from the code block
    const codeElement = preRef.current?.querySelector("code");
    const text = codeElement?.textContent || "";

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  // Check if this is an actual code block (not inline code)
  const hasCodeChild =
    isValidElement(children) &&
    typeof children.props === "object" &&
    children.props !== null &&
    "className" in children.props &&
    typeof children.props.className === "string" &&
    children.props.className.includes("language-");

  if (!hasCodeChild) {
    // Regular pre block without syntax highlighting
    return (
      <pre
        className={`mb-4 overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-[13px] leading-relaxed dark:border-neutral-800 dark:bg-neutral-900 ${className || ""}`}
      >
        {children}
      </pre>
    );
  }

  return (
    <div className="group relative mb-4">
      <pre
        ref={preRef}
        className={`overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-50 p-4 pr-12 text-[13px] leading-relaxed dark:border-neutral-800 dark:bg-neutral-900 ${className || ""}`}
      >
        {children}
      </pre>
      <button
        onClick={handleCopy}
        className="absolute right-2 top-2 rounded-md bg-white p-2 opacity-0 transition-opacity hover:bg-neutral-50 group-hover:opacity-100 dark:bg-neutral-800 dark:hover:bg-neutral-700"
        title={copied ? "Copied!" : "Copy code"}
        aria-label={copied ? "Copied!" : "Copy code"}
      >
        {copied ? (
          <Check className="h-4 w-4 text-green-600 dark:text-green-400" />
        ) : (
          <Copy className="h-4 w-4 text-neutral-600 dark:text-neutral-400" />
        )}
      </button>
    </div>
  );
}
