"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sheet, SheetTrigger, SheetContent, SheetTitle } from "@/components/ui/sheet";

const nav = [
  { href: "/", label: "Getting Started" },
  { href: "/why", label: "Why Portless" },
  { href: "/commands", label: "Commands" },
  { href: "/https", label: "HTTPS" },
  { href: "/configuration", label: "Configuration" },
  { href: "/changelog", label: "Changelog" },
];

export function DocsMobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  const currentPage = useMemo(() => {
    return nav.find((page) => page.href === pathname) ?? nav[0];
  }, [pathname]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        aria-label="Open table of contents"
        className="lg:hidden sticky top-14 z-40 w-full px-6 py-3 bg-white/80 dark:bg-neutral-950/80 backdrop-blur-sm border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between focus:outline-none"
      >
        <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
          {currentPage.label}
        </div>
        <div className="w-8 h-8 flex items-center justify-center">
          <svg
            className="h-4 w-4 text-neutral-500 dark:text-neutral-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="8" y1="6" x2="21" y2="6" />
            <line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" />
            <line x1="3" y1="6" x2="3.01" y2="6" />
            <line x1="3" y1="12" x2="3.01" y2="12" />
            <line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
        </div>
      </SheetTrigger>
      <SheetContent side="left" className="overflow-y-auto p-6" showCloseButton={false}>
        <SheetTitle className="mb-6">Table of Contents</SheetTitle>
        <nav>
          <ul className="space-y-1">
            {nav.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className={`text-sm block py-2 transition-colors ${
                    pathname === item.href
                      ? "text-neutral-900 dark:text-neutral-100 font-medium"
                      : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100"
                  }`}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </SheetContent>
    </Sheet>
  );
}
