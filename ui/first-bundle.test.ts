// The heavy panel libraries (terminal, editor, diff) and the math and diagram
// renderers load only when a panel or a message needs them, so a phone does not
// download them to show the office. One static value import of a module that
// pulls one in (EditorPanel.tsx from anywhere, say) puts it back in the first
// bundle, and nothing else goes red: the build and every other test still pass.
//
// The check walks the static import graph of our own sources from the entry,
// the graph the bundler follows for index.js. Type-only imports are erased and
// a dynamic import() starts a separate chunk, so neither is followed.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const REPO = join(import.meta.dir, "..");
const ENTRY = join(REPO, "ui", "index.tsx");

const LAZY_PACKAGES = [
  "@xterm/",
  "@codemirror/",
  "@lezer/",
  "diff2html",
  "katex",
  "mermaid",
];

const isLazyPackage = (specifier: string): boolean =>
  LAZY_PACKAGES.some((p) =>
    p.endsWith("/")
      ? specifier.startsWith(p)
      : specifier === p || specifier.startsWith(`${p}/`),
  );

interface Walk {
  files: Set<string>;
  // package specifier -> one source file that imports it
  packages: Map<string, string>;
}

function walk(followDynamic: boolean): Walk {
  const transpiler = new Bun.Transpiler({ loader: "tsx" });
  const files = new Set<string>();
  const packages = new Map<string, string>();
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    if (!/\.(tsx?|jsx?|mjs)$/.test(file)) continue;
    for (const imp of transpiler.scanImports(readFileSync(file, "utf8"))) {
      if (imp.kind === "dynamic-import" && !followDynamic) continue;
      if (imp.path.startsWith(".") || imp.path.startsWith("/")) {
        queue.push(Bun.resolveSync(imp.path, dirname(file)));
      } else if (!packages.has(imp.path)) {
        packages.set(imp.path, relative(REPO, file));
      }
    }
  }
  return { files, packages };
}

describe("first bundle", () => {
  it("reaches no heavy panel or renderer library through static imports", () => {
    const { files, packages } = walk(false);
    // The walk really covered the app: the office view and React are in it.
    expect(files.has(join(REPO, "ui", "App.tsx"))).toBe(true);
    expect(packages.has("react")).toBe(true);

    const leaked = [...packages]
      .filter(([specifier]) => isLazyPackage(specifier))
      .map(([specifier, importer]) => `${specifier} (from ${importer})`)
      .sort();
    expect(leaked).toEqual([]);
  });

  it("sees every one of those libraries when dynamic imports are followed", () => {
    // Fails closed: a renamed package or a walk that misses a branch would
    // make the check above pass for nothing.
    const { packages } = walk(true);
    for (const prefix of LAZY_PACKAGES) {
      const found = [...packages.keys()].some((s) =>
        prefix.endsWith("/")
          ? s.startsWith(prefix)
          : s === prefix || s.startsWith(`${prefix}/`),
      );
      expect({ prefix, found }).toEqual({ prefix, found: true });
    }
  });
});
