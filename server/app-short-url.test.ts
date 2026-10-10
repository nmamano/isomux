import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { appShortUrl } from "./app-short-url.ts";
import { RESERVED_APP_NAMES, checkAppName } from "./app-registry.ts";
import { ALL_ROUTES } from "./routes/table.ts";

describe("app short URL eligibility", () => {
  it("uses the configured office origin only for a live, non-reserved app with a public URL", () => {
    const origin = "https://office.example:8443";
    const publicUrl = "https://board.office.example";
    expect(appShortUrl({ name: "board" }, publicUrl, origin)).toBe(`${origin}/board`);
    expect(appShortUrl(null, publicUrl, origin)).toBeNull();
    expect(appShortUrl({ name: "board" }, null, origin)).toBeNull();
    for (const name of RESERVED_APP_NAMES) {
      expect(appShortUrl({ name }, publicUrl, origin)).toBeNull();
      expect(checkAppName(name)?.code).toBe("reserved_name");
    }
  });

  it("reserves every routable top-level office name, including UI paths and built assets", () => {
    const paths = ALL_ROUTES.map((route) => route.path);
    // Runtime comparisons and path constants outside the route table. Parse
    // literals rather than comments so a new path in any of these dispatchers
    // fails this test until registration also reserves its name.
    // Add new dispatchers here when they declare paths outside the route table.
    for (const file of ["isomux-office.ts", "auth-middleware.ts", "app-auth.ts", "tls-ask.ts", "browser-extension-session.ts", "../ui/routes.ts"]) {
      const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node) {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          if (node.text.startsWith("/")) paths.push(node.text);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    const assets = readdirSync(new URL("../ui/dist/", import.meta.url));
    expect(assets.length).toBeGreaterThan(0);
    paths.push(...assets.map((name) => `/${name}`));
    const names = new Set(paths.map((path) => path.split("/")[1]).filter((name) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)));
    for (const name of names) expect(RESERVED_APP_NAMES.has(name), `office path /${name}`).toBe(true);
  });
});
