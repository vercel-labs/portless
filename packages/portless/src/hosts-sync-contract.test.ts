import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// The hosts-sync failure warning is delivered per registering process: the
// daemon's warn-once latch bounds its own proxy.log, while every CLI that
// registers a route reads the published outcome for that route and prints it.
// Both halves are deliberate and both are pinned by unit tests elsewhere (the
// latch in cli-utils.test.ts, the non-destructive read in the status-file
// suite).
//
// What went unpinned was the sentence describing them. Five surfaces said the
// failure "warns once", which is true of the daemon log and false of the thing
// a user sees; two successive registrations against one failing daemon print
// two warnings. The claim survived three rewrites of these same files across
// three review rounds, because docs review checked that the new sentence was
// present and that its exception list was complete, never that it was true.
//
// This is the missing half: the wording is now a test. A future edit that
// reintroduces the unscoped claim fails here rather than shipping.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const SURFACES = [
  "README.md",
  "skills/portless/SKILL.md",
  "apps/docs/src/app/page.mdx",
  "apps/docs/src/app/commands/page.mdx",
  "packages/portless/src/cli.ts",
];

describe("hosts-sync failure wording", () => {
  it.each(SURFACES)("%s does not claim the failure warns once", (surface) => {
    const full = path.join(REPO_ROOT, surface);
    // A surface that moved is a finding, not a skip: silence here would be the
    // same false pass the claim itself enjoyed.
    expect(fs.existsSync(full), `${surface} not found; update SURFACES`).toBe(true);
    const text = fs.readFileSync(full, "utf-8");
    expect(text).not.toMatch(/warns once/i);
    // The old framing. A failed write is not what a user can observe, and on
    // current macOS and glibc a .localhost name resolves without the entry, so
    // promising a warning on a failed write promises one that does not come.
    expect(text).not.toMatch(/cannot write the (hosts )?file, the command/i);
  });

  it.each(SURFACES)("%s attributes the warning to the registering command", (surface) => {
    const text = fs.readFileSync(path.join(REPO_ROOT, surface), "utf-8");
    expect(text).toMatch(/will not resolve, the command that registered it warns/i);
  });

  // File-level assertions on cli.ts are not enough: it carries several help
  // sections, and one of them describing auto-sync correctly satisfies a
  // whole-file match while another stays stale. That is exactly how the
  // dedicated `hosts --help` section kept the old wording while global help
  // gained the new one. Check every passage that opts users out, since each one
  // is a place a reader learns what happens when the write fails.
  it("states the warning in every help passage that mentions the opt-out", () => {
    const cli = fs.readFileSync(path.join(REPO_ROOT, "packages/portless/src/cli.ts"), "utf-8");
    const passages = cli
      .split(/\n\s*\n/)
      .filter(
        (block) => block.includes("PORTLESS_SYNC_HOSTS=0") && block.includes(HOSTS_DISPLAY_HINT)
      );
    expect(passages.length).toBeGreaterThan(0);
    for (const passage of passages) {
      expect(passage).toMatch(/will not resolve, the command that\s+registered it warns/i);
    }
  });
});

/** Substring every user-facing auto-sync passage shares, on either platform. */
const HOSTS_DISPLAY_HINT = "hosts";

// `cachedRoutes` is the route watcher's before-image: `reloadRoutes` diffs a fresh
// load against it to decide which mDNS records to publish and unpublish. The
// hosts-sync handler needs the current route set too, and reading it into that
// same variable makes the next diff compare the new set with itself, so in LAN
// mode a route registered through this path never gets a `.local` publisher.
//
// Asserted on source text, which is weaker than driving LAN mode and is chosen
// because the handler is a closure with no export and mDNS needs a real
// publisher. It goes red on exactly the assignment that caused the regression.
describe("hosts-sync handler and the watcher's before-image", () => {
  it("does not write to cachedRoutes", () => {
    const cli = fs.readFileSync(path.join(REPO_ROOT, "packages/portless/src/cli.ts"), "utf-8");
    const start = cli.indexOf("const onHostsSyncRequest = ");
    expect(start).toBeGreaterThan(-1);
    const body = cli.slice(start, cli.indexOf("\n  };", start));
    expect(body).not.toMatch(/cachedRoutes\s*=/);
  });
});
