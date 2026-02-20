"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const nav = [
  { href: "/docs", label: "Getting Started" },
  { href: "/docs/why", label: "Why Portless" },
  { href: "/docs/commands", label: "Commands" },
  { href: "/docs/https", label: "HTTPS" },
  { href: "/docs/configuration", label: "Configuration" },
];

function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden w-56 shrink-0 md:block">
      <nav className="sticky top-20 space-y-1">
        {nav.map(({ href, label }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={`block rounded-md px-3 py-1.5 text-sm transition-colors ${
                active
                  ? "bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
                  : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
              }`}
            >
              {label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

function MobileNav() {
  const pathname = usePathname();

  return (
    <div className="mb-8 flex gap-2 overflow-x-auto border-b border-neutral-200 pb-4 md:hidden dark:border-neutral-800">
      {nav.map(({ href, label }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            className={`whitespace-nowrap rounded-full px-3 py-1 text-sm ${
              active
                ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </div>
  );
}

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <div className="flex gap-12">
        <Sidebar />
        <main className="min-w-0 flex-1">
          <MobileNav />
          <article className="max-w-none">{children}</article>
        </main>
      </div>
    </div>
  );
}
