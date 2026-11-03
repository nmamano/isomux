// version-assets.ts gives a page's scripts and styles URLs that change with
// their content, so the site host can cache them as immutable (server.test.ts
// checks that side). Here: what it rewrites, what it leaves alone, and that a
// second run changes nothing (CI runs it on site/, then server.test.ts runs it
// again on a copy).
import { afterAll, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assetVersion } from "./server.ts";
import { versionAssets } from "./version-assets.ts";

const scratch = mkdtempSync(join(tmpdir(), "version-assets-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const ASSETS: Record<string, string> = {
  "a.js": "console.log('a');\n",
  "s/b.css": "body { margin: 0; }\n",
  "s/c.js": "console.log('c');\n",
  "docs/_styles.css": "p { color: red; }\n",
  "demo/e.js": "export {};\n",
};

// References that must stay as written: a query or a fragment, a relative or
// absolute URL, a protocol-relative URL, a file that does not exist.
const LEFT_ALONE = `<script src="/a.js?x=1"></script>
<script src="/a.js#f"></script>
<script src="a.js"></script>
<script src="./a.js"></script>
<script src="https://cdn.example/a.js"></script>
<script src="//cdn.example/a.js"></script>
<script src="/missing.js"></script>
<link rel="stylesheet" href="/missing.css" />
`;

// The home page, with `ref` turning a site path into the URL the page holds.
const home = (ref: (path: string) => string) => `<!doctype html>
<script defer src="${ref("/a.js")}"></script>
<link rel="stylesheet" href="${ref("/s/b.css")}" />
<link rel="stylesheet" href="${ref("/docs/_styles.css")}"/>
<script type="module" src="${ref("/demo/e.js")}"></script>
<p>twice</p><script src="${ref("/a.js")}"></script>
${LEFT_ALONE}`;
const docPage = (ref: (path: string) => string) => `<!doctype html>
<link rel="stylesheet" href="${ref("/docs/_styles.css")}" />
<script defer src="${ref("/s/c.js")}"></script>
`;
// Markdown is served as written: it is not a page of the site.
const MARKDOWN = `<script src="/a.js"></script>\n`;

const plain = (path: string) => path;
const versioned = (path: string) =>
  `${path}?v=${assetVersion(Buffer.from(ASSETS[path.slice(1)]))}`;

/** A fresh site under the scratch directory. */
function makeSite(name: string): string {
  const dir = join(scratch, name);
  const files: Record<string, string> = {
    ...ASSETS,
    "index.html": home(plain),
    "docs/x/index.html": docPage(plain),
    "notes.md": MARKDOWN,
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const read = (dir: string, path: string) =>
  readFileSync(join(dir, path), "utf8");

describe("assetVersion", () => {
  it("is 12 hex characters that follow the content", () => {
    const a = assetVersion(Buffer.from("one"));
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(assetVersion(new TextEncoder().encode("one"))).toBe(a);
    expect(assetVersion(Buffer.from("one\n"))).not.toBe(a);
  });
});

describe("versionAssets", () => {
  it("adds ?v=<version> to every script and style reference of the site's pages", async () => {
    const dir = makeSite("rewrite");
    const count = await versionAssets(dir);
    expect(read(dir, "index.html")).toBe(home(versioned));
    expect(read(dir, "docs/x/index.html")).toBe(docPage(versioned));
    expect(read(dir, "notes.md")).toBe(MARKDOWN);
    for (const [path, content] of Object.entries(ASSETS))
      expect(read(dir, path)).toBe(content);
    // Five references on the home page, two on the doc page.
    expect(count).toBe(7);
  });

  it("changes nothing on a second run", async () => {
    const dir = makeSite("again");
    await versionAssets(dir);
    const once = {
      home: read(dir, "index.html"),
      doc: read(dir, "docs/x/index.html"),
    };
    expect(once.home).toBe(home(versioned));
    expect(await versionAssets(dir)).toBe(0);
    expect(read(dir, "index.html")).toBe(once.home);
    expect(read(dir, "docs/x/index.html")).toBe(once.doc);
  });
});

describe("bun site-host/version-assets.ts <siteDir>", () => {
  const cli = (dir: string) =>
    Bun.spawnSync({
      cmd: [process.execPath, join(import.meta.dir, "version-assets.ts"), dir],
      stdout: "pipe",
      stderr: "pipe",
    });

  it("rewrites the site's pages", () => {
    const dir = makeSite("cli");
    const run = cli(dir);
    expect(run.exitCode).toBe(0);
    expect(read(dir, "index.html")).toBe(home(versioned));
  });

  // CI always has references to rewrite: none means the rewrite is broken,
  // and the build must not ship the plain names without notice.
  it("fails when it rewrites no reference", () => {
    const dir = makeSite("cli-none");
    writeFileSync(join(dir, "index.html"), `<!doctype html>\n${LEFT_ALONE}`);
    writeFileSync(join(dir, "docs/x/index.html"), "<!doctype html>\n");
    const run = cli(dir);
    expect(run.exitCode).not.toBe(0);
    expect(read(dir, "index.html")).toBe(`<!doctype html>\n${LEFT_ALONE}`);
  });
});
