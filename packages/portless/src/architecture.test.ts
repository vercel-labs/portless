import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { RouteStore } from "./routes.js";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const cleanUtilsStorageAllowlistReason =
  "clean-utils.ts names route files only so cleanup can remove them.";
const routeStorageAllowlist = new Set(["routes.ts", "clean-utils.ts"]);
const allocationImportAllowlist = new Set(["cli.ts"]);
const routePathDisplayAllowlist =
  /console\.log\s*\(\s*colors\.gray\s*\(\s*`Routes file: \$\{store\.getRoutesPath\(\)\}`\s*\)\s*\)/;
const routeStoreMethods = [
  "ensureDir",
  "findStaleRoutes",
  "getRoutesPath",
  "isRouteOwnerAlive",
  "loadRoutes",
  "recordStaleOrphan",
  "register",
  "remove",
  "removeStaleRoute",
  "transferRoute",
  "updateRoute",
  "watch",
].sort();

function privateRouteStoreMethodNames(): Set<string> {
  const source = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");
  const classStart = source.indexOf("export class RouteStore {");
  const classEnd = source.lastIndexOf("\n}");
  const classSource = source.slice(classStart, classEnd);
  const methods = classSource.matchAll(
    /^\s*private\s+(?!static\b)(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>\n]*>)?\s*\(/gm
  );
  return new Set([...methods].map((match) => match[1]));
}

/** This scan can misread regex literals, miss computed aliases, and flag strings or nested template expressions. */
function productionSources(): { file: string; text: string }[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = `${dir}/${entry.name}`;
      if (entry.isDirectory()) visit(fullPath);
      else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".d.ts")
      ) {
        files.push(fullPath);
      }
    }
  };
  visit(sourceDir);
  return files.map((fullPath) => {
    const file = relative(sourceDir, fullPath).split(sep).join("/");
    const raw = readFileSync(fullPath, "utf8");
    const text = raw.replace(
      /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
      (part) => (part.startsWith("/") ? part.replace(/[^\r\n]/g, " ") : part)
    );
    return { file, text };
  });
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

function report(file: string, text: string, index: number, rule: string): string {
  return `${file}:${lineAt(text, index)} ${rule}`;
}

function assertNoViolations(violations: string[], rule: string): void {
  expect(violations, violations.join("\n") || rule).toEqual([]);
}

it("keeps removed route APIs out of production code", () => {
  const violations: string[] = [];
  const removed = /\b(?:findFreePort|addRoute|removeRoute|loadRoutesRaw)\b(?:\s*\()?/g;
  for (const { file, text } of productionSources()) {
    for (const match of text.matchAll(removed)) {
      violations.push(report(file, text, match.index!, "removed route API must stay removed"));
    }
  }
  assertNoViolations(violations, "Removed route APIs must stay removed.");
});

it("keeps route storage names inside their owners", () => {
  const violations: string[] = [];
  const storageName = /(["'`])routes\.(?:json|lock)\1/g;
  for (const { file, text } of productionSources()) {
    if (routeStorageAllowlist.has(file)) continue;
    for (const match of text.matchAll(storageName)) {
      violations.push(
        report(
          file,
          text,
          match.index!,
          "route storage names belong to routes.ts or clean-utils.ts"
        )
      );
    }
  }
  assertNoViolations(violations, cleanUtilsStorageAllowlistReason);
});

it("keeps route paths and route-file operations inside RouteStore", () => {
  const violations: string[] = [];
  const pathCalls = /\bgetRoutesPath\s*\(/g;
  const fileOperations = /\b(?:fs\.)?(?:watch|watchFile|chmodSync)\s*\(([\s\S]{0,240}?)\)/g;
  for (const { file, text } of productionSources()) {
    if (file === "routes.ts") continue;
    const lines = text.split("\n");
    for (const match of text.matchAll(pathCalls)) {
      const line = lines[lineAt(text, match.index!) - 1] ?? "";
      if (file !== "cli.ts" || !routePathDisplayAllowlist.test(line)) {
        violations.push(
          report(
            file,
            text,
            match.index!,
            "getRoutesPath() is limited to RouteStore and the CLI display call"
          )
        );
      }
    }
    for (const match of text.matchAll(fileOperations)) {
      if (/routesPath|getRoutesPath\s*\(/.test(match[1] ?? "")) {
        violations.push(
          report(
            file,
            text,
            match.index!,
            "route-derived watch, watchFile, and chmodSync belong to RouteStore"
          )
        );
      }
    }
  }
  assertNoViolations(
    violations,
    "Route path access and file operations must stay inside RouteStore."
  );
});

it("pins the public RouteStore methods to the TLA+ model", () => {
  const privateMethods = privateRouteStoreMethodNames();
  const actual = Object.getOwnPropertyNames(RouteStore.prototype)
    .filter((method) => method !== "constructor" && !privateMethods.has(method))
    .sort();
  expect(
    actual,
    `RouteStore public methods changed. Update routeStoreMethods and spec/tla/RouteStore.tla together.`
  ).toEqual(routeStoreMethods);
});

it("keeps port availability checks and app port allocation in RouteStore", () => {
  const violations: string[] = [];
  const imports = /\bimport\s+([\s\S]*?)\s+from\s*["'][^"']+["']/g;
  for (const { file, text } of productionSources()) {
    if (file !== "routes.ts" && !allocationImportAllowlist.has(file)) {
      for (const match of text.matchAll(imports)) {
        if (/\bisPortFree\b/.test(match[1] ?? "")) {
          violations.push(
            report(
              file,
              text,
              match.index!,
              "only RouteStore and the allowlisted CLI may import isPortFree"
            )
          );
        }
      }
    }
    if (file !== "routes.ts" && /\b4000\b/.test(text) && /\b4999\b/.test(text)) {
      violations.push(
        report(
          file,
          text,
          text.search(/\b4000\b/),
          "the 4000-4999 app port range belongs to RouteStore"
        )
      );
    }
  }
  assertNoViolations(
    violations,
    "Port availability checks and app port allocation must stay inside RouteStore."
  );
});
