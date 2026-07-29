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
    expect(fs.readFileSync(full, "utf-8")).not.toMatch(/warns once/i);
  });

  it.each(SURFACES)("%s attributes the warning to the registering command", (surface) => {
    const text = fs.readFileSync(path.join(REPO_ROOT, surface), "utf-8");
    expect(text).toMatch(/(command|terminal) that registered the route warns/i);
  });
});
