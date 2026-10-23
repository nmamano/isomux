import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { RESERVED_APP_NAMES } from "./app-registry.ts";
import { ALL_ROUTES } from "./routes/table.ts";

// The eligibility branches (live app, deleted app, reserved name, port-only
// office) are proved through the request pipeline in
// test-support/app-short-url-routes.test.ts.
describe("app short URL eligibility", () => {
  it("reserves every routable top-level office name, including UI paths and built assets", () => {
    const paths = ALL_ROUTES.map((route) => route.path);
    // Runtime comparisons and path constants outside the route table. The
    // transpiler drops comments and types, so only code literals remain; a new
    // path in any of these dispatchers fails this test until registration also
    // reserves its name.
    // Add new dispatchers here when they declare paths outside the route table.
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const scanned = new Set<string>();
    for (const file of [
      "isomux-office.ts",
      "auth-middleware.ts",
      "app-auth.ts",
      "tls-ask.ts",
      "browser-extension-session.ts",
      "../ui/routes.ts",
    ]) {
      const js = transpiler.transformSync(
        readFileSync(new URL(file, import.meta.url), "utf8"),
      );
      for (const m of js.matchAll(/(["'`])(\/[^"'`$\\\n]*)\1/g))
        scanned.add(m[2]);
    }
    // The scan finds literals at all: /backup (isomux-office.ts) and /inbox
    // (ui/routes.ts) are in no route table entry.
    const segments = [...scanned].map((path) => path.split("/")[1]);
    expect(segments).toContain("backup");
    expect(segments).toContain("inbox");
    paths.push(...scanned);
    const assets = readdirSync(new URL("../ui/dist/", import.meta.url));
    expect(assets.length).toBeGreaterThan(0);
    paths.push(...assets.map((name) => `/${name}`));
    const names = new Set(
      paths
        .map((path) => path.split("/")[1])
        .filter((name) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)),
    );
    for (const name of names)
      expect(RESERVED_APP_NAMES.has(name), `office path /${name}`).toBe(true);
  });
});
