import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "portless",
  description: "Replace port numbers with stable, named .localhost URLs. For humans and agents.",
};

function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-neutral-200 bg-white/80 backdrop-blur-sm dark:border-neutral-800 dark:bg-neutral-950/80">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
        <Link
          href="/docs"
          className="text-sm font-semibold tracking-tight text-neutral-900 dark:text-neutral-100"
        >
          portless
        </Link>
        <a
          href="https://github.com/vercel-labs/portless"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          GitHub
        </a>
      </div>
    </header>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-white text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
        <Header />
        {children}
      </body>
    </html>
  );
}
