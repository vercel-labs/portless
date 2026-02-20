"use client";

import {
  useRef,
  useEffect,
  useState,
  useCallback,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { Streamdown } from "streamdown";
import Link from "next/link";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

const STORAGE_KEY = "docs-chat-messages";
const transport = new DefaultChatTransport({ api: "/api/docs-chat" });

const DESKTOP_DEFAULT_WIDTH = 400;
const DESKTOP_MIN_WIDTH = 300;
const DESKTOP_MAX_WIDTH = 700;

function setCookie(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)};path=/;max-age=${60 * 60 * 24 * 365};samesite=lax`;
}

const TOOL_LABELS: Record<string, { label: string; pastLabel: string; argKey?: string }> = {
  readFile: { label: "Reading", pastLabel: "Read", argKey: "path" },
  bash: { label: "Running", pastLabel: "Ran", argKey: "command" },
};

function isToolPart(part: { type: string }): part is {
  type: string;
  toolCallId: string;
  toolName?: string;
  state: string;
  input?: Record<string, unknown>;
  output?: unknown;
  errorText?: string;
} {
  return part.type.startsWith("tool-") || part.type === "dynamic-tool";
}

function getToolName(part: { type: string; toolName?: string }): string {
  if (part.type === "dynamic-tool") return part.toolName ?? "tool";
  return part.type.replace(/^tool-/, "");
}

function ToolCallDisplay({
  part,
}: {
  part: {
    type: string;
    toolCallId: string;
    toolName?: string;
    state: string;
    input?: Record<string, unknown>;
    output?: unknown;
    errorText?: string;
  };
}) {
  const toolName = getToolName(part);
  const config = TOOL_LABELS[toolName] ?? {
    label: toolName,
    pastLabel: toolName,
  };
  const isDone = part.state === "output-available";
  const isError = part.state === "output-error";
  const isRunning = !isDone && !isError;
  const displayLabel = isRunning ? config.label : config.pastLabel;

  const args = (part.input ?? {}) as Record<string, unknown>;
  const argValue = config.argKey ? args[config.argKey] : undefined;
  const argPreview =
    argValue != null
      ? String(argValue)
          .replace(/^\/workspace\//, "/")
          .replace(/\.md$/, "")
          .replace(/\/index$/, "") || "/"
      : "";

  const docsLink = toolName === "readFile" && argPreview.startsWith("/") ? argPreview : null;

  const argEl = argPreview ? (
    docsLink ? (
      <Link href={docsLink} className="truncate underline underline-offset-2">
        {argPreview}
      </Link>
    ) : (
      <span className="truncate">{argPreview}</span>
    )
  ) : null;

  return (
    <div className="text-xs py-0.5 min-w-0">
      {isRunning ? (
        <span className="inline-flex items-center gap-1 font-mono text-neutral-500 dark:text-neutral-400 animate-tool-shimmer min-w-0 max-w-full">
          <span className="shrink-0">{displayLabel}</span>
          {argEl}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 font-mono text-neutral-400 dark:text-neutral-500 min-w-0 max-w-full">
          <span className="shrink-0">{displayLabel}</span>
          {argEl}
          {isError && <span className="text-red-500">failed</span>}
        </span>
      )}
    </div>
  );
}

const SUGGESTIONS = [
  "What is portless?",
  "How do I install it?",
  "What commands are available?",
  "How does HTTPS work?",
  "How do I configure it?",
];

export function DocsChat({
  defaultOpen = false,
  defaultWidth = DESKTOP_DEFAULT_WIDTH,
}: {
  defaultOpen?: boolean;
  defaultWidth?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [input, setInput] = useState("");
  const [isDesktop, setIsDesktop] = useState(false);
  const [hasMounted, setHasMounted] = useState(false);
  const [desktopWidth, setDesktopWidth] = useState(
    Math.min(DESKTOP_MAX_WIDTH, Math.max(DESKTOP_MIN_WIDTH, defaultWidth))
  );
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const restoredRef = useRef(false);
  const isDraggingRef = useRef(false);

  const { messages, sendMessage, status, setMessages, error } = useChat({
    transport,
  });

  const isLoading = status === "streaming" || status === "submitted";
  const showMessages = messages.length > 0 || !!error || isLoading;

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    setIsDesktop(mq.matches);
    setHasMounted(true);
    if (!mq.matches && defaultOpen) {
      setOpen(false);
    }
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []); // intentionally run once on mount

  useEffect(() => {
    if (hasMounted) {
      setCookie("docs-chat-open", String(open));
    }
  }, [open, hasMounted]);

  useEffect(() => {
    const body = document.body;
    if (isDesktop && open) {
      body.style.paddingRight = `${desktopWidth}px`;
      if (!isDraggingRef.current) {
        body.style.transition = "padding-right 150ms ease";
      }
    } else if (isDesktop) {
      body.style.paddingRight = "0px";
      body.style.transition = "padding-right 150ms ease";
    }
    return () => {
      body.style.paddingRight = "0px";
      body.style.transition = "";
    };
  }, [isDesktop, open, desktopWidth]);

  const handleResizePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      isDraggingRef.current = true;
      document.documentElement.style.transition = "none";
      const startX = e.clientX;
      const startWidth = desktopWidth;

      const onPointerMove = (ev: globalThis.PointerEvent) => {
        const delta = startX - ev.clientX;
        const newWidth = Math.min(
          DESKTOP_MAX_WIDTH,
          Math.max(DESKTOP_MIN_WIDTH, startWidth + delta)
        );
        setDesktopWidth(newWidth);
      };

      const onPointerUp = () => {
        isDraggingRef.current = false;
        document.documentElement.style.transition = "";
        document.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("pointerup", onPointerUp);
      };

      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
    },
    [desktopWidth]
  );

  useEffect(() => {
    setCookie("docs-chat-width", String(desktopWidth));
  }, [desktopWidth]);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setMessages(parsed);
        }
      }
    } catch {
      // ignore parse errors
    }
  }, [setMessages]);

  useEffect(() => {
    if (!restoredRef.current) return;
    if (isLoading) return;
    if (messages.length === 0) {
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch {
      // ignore quota errors
    }
  }, [messages, isLoading]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => {
          if (!prev) {
            setTimeout(() => inputRef.current?.focus(), 200);
          }
          return !prev;
        });
      }
      if (e.key === "Escape" && open && isDesktop) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, isDesktop]);

  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => inputRef.current?.focus(), 200);
      return () => clearTimeout(timer);
    }
  }, [open]);

  useEffect(() => {
    if (error) setOpen(true);
  }, [error]);

  useEffect(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [messages, error]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!input.trim() || isLoading) return;
      sendMessage({ text: input });
      setInput("");
    },
    [input, isLoading, sendMessage]
  );

  const handleClear = useCallback(() => {
    setMessages([]);
    sessionStorage.removeItem(STORAGE_KEY);
  }, [setMessages]);

  const hasVisibleContent = (parts: (typeof messages)[number]["parts"]): boolean => {
    return parts.some((p) => (p.type === "text" && p.text.length > 0) || isToolPart(p));
  };

  const chatPanel = (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 shrink-0">
        <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
          portless Docs
        </span>
        <div className="flex items-center gap-3">
          {showMessages && (
            <button
              onClick={handleClear}
              className="text-xs text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100 transition-colors"
              aria-label="Clear conversation"
            >
              Clear
            </button>
          )}
          <button
            onClick={() => setOpen(false)}
            className="text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100 transition-colors"
            aria-label="Close panel"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Content: suggestions or messages */}
      {showMessages ? (
        <div ref={messagesScrollRef} className="flex-1 min-h-0 p-4 space-y-4 overflow-y-auto">
          {messages.map((message) => {
            if (!hasVisibleContent(message.parts)) return null;
            return (
              <div key={message.id}>
                {message.role === "user" ? (
                  <div className="text-sm text-neutral-500 dark:text-neutral-400 whitespace-pre-wrap leading-relaxed">
                    {message.parts
                      .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
                      .map((p) => p.text)
                      .join("")}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {message.parts.map((part, i) => {
                      if (part.type === "text" && part.text) {
                        return (
                          <div
                            key={i}
                            className="docs-chat-content text-sm text-neutral-900 dark:text-neutral-100 leading-relaxed max-w-none"
                          >
                            <Streamdown>{part.text}</Streamdown>
                          </div>
                        );
                      }
                      if (isToolPart(part)) {
                        return <ToolCallDisplay key={part.toolCallId} part={part} />;
                      }
                      return null;
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {error && (
            <div className="text-sm text-red-600/80 dark:text-red-400/80 bg-red-50 dark:bg-red-950/30 rounded-md px-3 py-2">
              {(() => {
                try {
                  const parsed = JSON.parse(error.message);
                  return parsed.message || parsed.error || error.message;
                } catch {
                  return error.message || "Something went wrong. Please try again.";
                }
              })()}
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex flex-wrap gap-2 p-4">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  sendMessage({ text: s });
                }}
                className="text-xs px-3 py-1.5 rounded-full border border-neutral-200 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800 font-medium text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input bar */}
      <form
        onSubmit={handleSubmit}
        className="flex items-end gap-2 px-4 py-3 border-t border-neutral-200 dark:border-neutral-800 shrink-0"
      >
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${e.target.scrollHeight}px`;
          }}
          rows={1}
          enterKeyHint="send"
          placeholder="Ask a question..."
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit(e);
            }
          }}
          className="flex-1 bg-transparent text-base sm:text-sm text-neutral-900 dark:text-neutral-100 outline-none disabled:opacity-50 resize-none max-h-32 leading-relaxed placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
        />
        <button
          type="submit"
          disabled={isLoading || !input.trim()}
          className="bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 rounded-full p-1.5 hover:bg-neutral-700 dark:hover:bg-neutral-300 transition-colors disabled:opacity-30 shrink-0"
          aria-label="Send message"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="12" y1="19" x2="12" y2="5" />
            <polyline points="5 12 12 5 19 12" />
          </svg>
        </button>
      </form>
    </>
  );

  return (
    <>
      {/* Ask AI trigger button */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed z-50 bottom-4 left-1/2 -translate-x-1/2 sm:left-auto sm:translate-x-0 sm:right-4 flex items-center gap-2 px-4 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 shadow-lg hover:bg-neutral-900 hover:text-white dark:hover:bg-neutral-100 dark:hover:text-neutral-900 transition-colors text-sm font-medium"
          aria-label="Ask AI"
        >
          Ask AI
          <kbd className="hidden sm:inline-flex items-center gap-0.5 text-xs opacity-60 font-mono">
            <span>&#8984;</span>K
          </kbd>
        </button>
      )}

      {/* Desktop: resizable side pane */}
      <aside
        className={`hidden sm:flex fixed top-0 right-0 bottom-0 z-40 border-l border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 transition-transform duration-150 ease-in-out ${open ? "translate-x-0" : "translate-x-full"}`}
        style={{ width: desktopWidth }}
        aria-hidden={!open}
      >
        {/* Resize handle */}
        <div
          onPointerDown={handleResizePointerDown}
          className="absolute top-0 bottom-0 left-0 w-1.5 cursor-col-resize hover:bg-neutral-300/30 dark:hover:bg-neutral-600/30 active:bg-neutral-300/50 dark:active:bg-neutral-600/50 transition-colors z-10"
        />
        <div className="flex flex-col flex-1 min-w-0">{chatPanel}</div>
      </aside>

      {/* Mobile: Sheet overlay/drawer */}
      {hasMounted && !isDesktop && (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent
            side="right"
            showCloseButton={false}
            overlayClassName="bg-white! dark:bg-neutral-950!"
            className="inset-0! w-full! h-full! max-w-none! p-0! flex flex-col"
            style={{ backgroundColor: "inherit", opacity: 1 }}
          >
            <SheetTitle className="sr-only">AI Chat</SheetTitle>
            {chatPanel}
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}
