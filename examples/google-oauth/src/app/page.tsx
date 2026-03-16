"use client";

import { useState, useEffect } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import { SessionProvider } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <path
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z"
        fill="#34A853"
      />
      <path
        d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.997 8.997 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
        fill="#EA4335"
      />
    </svg>
  );
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function GlobeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </svg>
  );
}

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function AuthCard() {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center rounded-xl border bg-card p-10">
        <div className="size-5 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-foreground" />
      </div>
    );
  }

  if (session) {
    return (
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="border-b bg-emerald-500/5 px-6 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-emerald-600">
            <ShieldIcon className="text-emerald-500" />
            Authenticated
          </div>
        </div>
        <div className="flex items-center gap-4 p-6">
          <Avatar size="lg">
            {session.user?.image && (
              <AvatarImage src={session.user.image} alt={session.user?.name ?? ""} />
            )}
            <AvatarFallback>
              {session.user?.name?.[0]?.toUpperCase() ?? "?"}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{session.user?.name}</p>
            <p className="truncate text-sm text-muted-foreground">
              {session.user?.email}
            </p>
          </div>
        </div>
        <div className="border-t bg-muted/30 px-6 py-3">
          <Button variant="outline" size="sm" onClick={() => signOut()}>
            Sign out
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="p-6 pb-0">
        <p className="text-sm font-medium">Welcome</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Sign in to verify the OAuth flow works with your custom domain.
        </p>
      </div>
      <div className="p-6">
        <Button className="w-full" size="lg" onClick={() => signIn("google")}>
          <GoogleIcon />
          Continue with Google
        </Button>
      </div>
    </div>
  );
}

function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <div className="min-w-0">
        <p className="text-muted-foreground">{label}</p>
        <p className="truncate font-mono text-xs text-foreground">{value}</p>
      </div>
    </div>
  );
}

function Content() {
  const [origin, setOrigin] = useState("");
  const [tld, setTld] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
    const host = window.location.hostname;
    const parts = host.split(".");
    if (parts.length > 1) {
      setTld("." + parts[parts.length - 1]);
    }
  }, []);

  return (
    <div className="flex min-h-svh items-center justify-center px-6 py-16">
      <div className="w-full max-w-md space-y-8">
        <div className="space-y-3">
          <h1 className="text-3xl font-semibold tracking-tight">
            Google OAuth + Portless
          </h1>
          <p className="text-base leading-relaxed text-muted-foreground">
            Google OAuth rejects <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">.localhost</code> subdomains.
            Portless fixes this by serving your app on any valid TLD.
            Use a domain you own to keep traffic from reaching something you don&apos;t control.
          </p>
        </div>

        <AuthCard />

        {origin && (
          <div className="space-y-3 rounded-xl border bg-card p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Connection details
            </p>
            <div className="space-y-4">
              <InfoRow
                icon={<GlobeIcon />}
                label="Domain"
                value={new URL(origin).hostname}
              />
              <InfoRow
                icon={<LockIcon />}
                label="Protocol"
                value={new URL(origin).protocol === "https:" ? "HTTPS (TLS)" : "HTTP"}
              />
              {tld && (
                <InfoRow
                  icon={<ShieldIcon />}
                  label="TLD"
                  value={tld}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <SessionProvider>
      <Content />
    </SessionProvider>
  );
}
