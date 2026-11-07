import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "../shared/types.ts";
import {
  addModulePreloads,
  stampUiBuild,
  trackUiBuild,
  type UiBuildTracker,
} from "./ui-build.ts";

const POLL_MS = 20;
const PLACEHOLDER = "__ISOMUX_UI_BUILD__";
const PLACEHOLDER_HTML = readFileSync(
  join(import.meta.dir, "..", "ui", "index.html"),
  "utf8",
);
// The real page with its build meta set to a value.
const pageWith = (value: string) =>
  PLACEHOLDER_HTML.replace(PLACEHOLDER, value);

const dirs: string[] = [];
const trackers: UiBuildTracker[] = [];
afterEach(() => {
  for (const t of trackers.splice(0)) t.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function distDir(): string {
  const d = mkdtempSync(join(tmpdir(), "isomux-ui-build-"));
  dirs.push(d);
  return d;
}

// scripts/publish-ui-dist.ts renames index.html into place, which replaces
// the inode.
function writeBuild(dir: string, id: string): void {
  const tmp = join(dir, "index.html.tmp");
  writeFileSync(tmp, pageWith(id));
  renameSync(tmp, join(dir, "index.html"));
}

// The id the server holds for a dist dir: what a tracker reads at start.
function servedId(dir: string): string | null {
  const tracker = trackUiBuild(dir, () => {});
  tracker.stop();
  return tracker.current();
}

async function until(cond: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await Bun.sleep(5);
  }
}

describe("the id the server reads", () => {
  it.each([
    ["a stamped page", pageWith("0123456789abcdef"), "0123456789abcdef"],
    // A stage dir before the stamp, or a page that was never built.
    ["a page that still holds the placeholder", PLACEHOLDER_HTML, null],
    ["an empty meta", pageWith(""), null],
    ["a meta with an id too short", pageWith("0123456789abcde"), null],
    ["a meta with an id too long", pageWith("0123456789abcdef0"), null],
    ["a meta with markup", pageWith("&lt;b&gt;0123456789abcdef"), null],
    // The id comes from the isomux-ui-build meta, not from any value in the
    // page that looks like one.
    [
      "a page with no build meta and an id elsewhere",
      PLACEHOLDER_HTML.replace(
        /<meta name="isomux-ui-build"[^>]*>/,
        '<meta name="other" content="0123456789abcdef" />',
      ),
      null,
    ],
    [
      "a placeholder build meta and an id in another meta",
      PLACEHOLDER_HTML.replace(
        "</head>",
        '<meta name="other" content="0123456789abcdef" /></head>',
      ),
      null,
    ],
    ["an empty file", "", null],
  ])("%s", (_label, html, want) => {
    const dir = distDir();
    writeFileSync(join(dir, "index.html"), html);
    expect(servedId(dir)).toBe(want);
  });

  it("a missing page", () => {
    expect(servedId(distDir())).toBeNull();
  });
});

describe("stampUiBuild", () => {
  // A bundle as Bun writes it: the placeholder sits wherever ui/ui-build.ts's
  // constant ended up, possibly inlined at more than one use.
  const BUNDLE = `var a="${PLACEHOLDER}";console.log(a,"${PLACEHOLDER}");`;
  function stage(
    js: string,
    html = PLACEHOLDER_HTML,
    extra: Record<string, string> = {},
  ): string {
    const dir = distDir();
    writeFileSync(join(dir, "index.js"), js);
    writeFileSync(join(dir, "index.html"), html);
    for (const [name, body] of Object.entries(extra))
      writeFileSync(join(dir, name), body);
    return dir;
  }
  const read = (dir: string, name: string) =>
    readFileSync(join(dir, name), "utf8");
  const metaOf = (dir: string) =>
    /<meta name="isomux-ui-build" content="([^"]*)"/.exec(
      read(dir, "index.html"),
    )?.[1];
  const snapshot = (dir: string) =>
    Object.fromEntries(
      readdirSync(dir)
        .sort()
        .map((name) => [name, read(dir, name)]),
    );

  it("puts the same id in the page meta and in the bundle", () => {
    const dir = stage(BUNDLE);
    const id = stampUiBuild(dir);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(metaOf(dir)).toBe(id);
    expect(servedId(dir)).toBe(id);
    // Every placeholder in the bundle, and nothing else in it.
    expect(read(dir, "index.js")).toBe(BUNDLE.replaceAll(PLACEHOLDER, id));
    // No other file is added to the stage, where the publish would take it
    // into ui/dist.
    expect(readdirSync(dir).sort()).toEqual(["index.html", "index.js"]);
  });

  // A second stamp finds no placeholder. A new id for a page that carries the
  // old one would never match it, and the notice would never clear.
  it("refuses a stage that is already stamped, and keeps the first id", () => {
    const dir = stage(BUNDLE);
    const id = stampUiBuild(dir);
    const stamped = snapshot(dir);
    expect(() => stampUiBuild(dir)).toThrow();
    expect(snapshot(dir)).toEqual(stamped);
    expect(metaOf(dir)).toBe(id);
  });

  it.each([
    // The running code would never know its build: no notice, ever.
    ["a bundle with no placeholder", "console.log(1);", {}],
    // Chunks are cached for a year under their hashed names: new bytes under
    // the same name would reach no tab that has the old ones.
    [
      "a placeholder in a chunk",
      BUNDLE,
      { "chunk-0a1b2c3d.js": `export var b="${PLACEHOLDER}";` },
    ],
  ])("refuses %s, and leaves the stage as it was", (_label, js, extra) => {
    const dir = stage(js, PLACEHOLDER_HTML, extra);
    const before = snapshot(dir);
    expect(() => stampUiBuild(dir)).toThrow();
    expect(snapshot(dir)).toEqual(before);
  });

  // A rebuild that changes nothing must not tell open tabs to reload.
  it("the id depends only on the unstamped bundle and page", () => {
    const same1 = stampUiBuild(stage(BUNDLE));
    const same2 = stampUiBuild(stage(BUNDLE));
    const otherJs = stampUiBuild(stage(BUNDLE + "console.log(2);"));
    const otherHtml = stampUiBuild(
      stage(BUNDLE, PLACEHOLDER_HTML.replace("</body>", "<p></p></body>")),
    );
    expect(same2).toBe(same1);
    expect(otherJs).not.toBe(same1);
    expect(otherHtml).not.toBe(same1);
  });

  // The tab's id comes from the code it runs, never from the page: a
  // restored tab can pair an old cached page with the current index.js.
  // Built as scripts/build.sh builds it (minified), because a minifier can
  // fold a compare against the placeholder before the stamp runs.
  describe("the id the running bundle reports", () => {
    const PAGE_ID = "aaaaaaaaaaaaaaaa";
    let realDocument: PropertyDescriptor | undefined;
    beforeEach(() => {
      realDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
      // A page whose meta holds some other build.
      (globalThis as { document?: unknown }).document = {
        querySelector: () => ({ getAttribute: () => PAGE_ID }),
      };
    });
    // Absent before is absent after: a document left as undefined still
    // reads as a DOM to the render harness's next file.
    afterEach(() => {
      if (realDocument)
        Object.defineProperty(globalThis, "document", realDocument);
      else delete (globalThis as { document?: unknown }).document;
    });

    async function bundleStage(): Promise<string> {
      const built = await Bun.build({
        entrypoints: [join(import.meta.dir, "..", "ui", "ui-build.ts")],
        minify: true,
        target: "browser",
      });
      expect(built.success).toBe(true);
      return stage(await built.outputs[0]!.text());
    }
    const ownOf = async (dir: string) =>
      (
        (await import(join(dir, "index.js"))) as {
          ownUiBuild: () => string | null;
        }
      ).ownUiBuild();

    it("is the stamped id", async () => {
      const dir = await bundleStage();
      const id = stampUiBuild(dir);
      expect(id).not.toBe(PAGE_ID);
      expect(await ownOf(dir)).toBe(id);
    });

    it("is unknown in a bundle that was never stamped", async () => {
      expect(await ownOf(await bundleStage())).toBeNull();
    });
  });
});

// The browser finds a chunk index.js imports only after it has downloaded and
// parsed index.js. A modulepreload link in the page starts each static chunk
// with index.js instead (task 459936c8).
describe("addModulePreloads", () => {
  function stage(files: Record<string, string>): string {
    const dir = distDir();
    writeFileSync(join(dir, "index.html"), PLACEHOLDER_HTML);
    for (const [name, body] of Object.entries(files))
      writeFileSync(join(dir, name), body);
    return dir;
  }
  // The chunk path each modulepreload link loads, as the browser resolves its
  // href against the page at /.
  async function preloadsOf(dir: string): Promise<string[]> {
    const hrefs: string[] = [];
    await new HTMLRewriter()
      .on('link[rel="modulepreload"]', {
        element(el) {
          hrefs.push(el.getAttribute("href") ?? "");
        },
      })
      .transform(new Response(readFileSync(join(dir, "index.html"), "utf8")))
      .text();
    return hrefs.map((href) => new URL(href, "https://office.test/").pathname);
  }

  // Bun's own split output: index.js imports the shared chunk statically and
  // the lazy chunk dynamically, and its preload runtime names the lazy chunk
  // in a string as well.
  it("links the chunk index.js imports statically, not the lazy one", async () => {
    const src = mkdtempSync(join(tmpdir(), "isomux-preload-src-"));
    dirs.push(src);
    writeFileSync(
      join(src, "shared.ts"),
      "export const shared = (x: number) => x * 2 + Math.random();\n",
    );
    writeFileSync(
      join(src, "lazy.ts"),
      'import { shared } from "./shared.ts";\nexport const lazy = () => shared(3);\n',
    );
    writeFileSync(
      join(src, "index.ts"),
      'import { shared } from "./shared.ts";\nconsole.log(shared(1));\nimport("./lazy.ts").then((m) => console.log(m.lazy()));\n',
    );
    const dir = distDir();
    const built = await Bun.build({
      entrypoints: [join(src, "index.ts")],
      outdir: dir,
      splitting: true,
      minify: true,
      target: "browser",
    });
    expect(built.success).toBe(true);
    writeFileSync(join(dir, "index.html"), PLACEHOLDER_HTML);
    const chunks = readdirSync(dir).filter(
      (n) => n.endsWith(".js") && n !== "index.js",
    );
    const sharedChunk = chunks.find(
      (n) => !readFileSync(join(dir, n), "utf8").includes("lazy"),
    );
    const lazyChunk = chunks.find((n) => n !== sharedChunk);
    // The shape this case stands for: one static and one dynamic chunk.
    expect(chunks.length).toBe(2);
    expect(sharedChunk).toBeDefined();
    expect(lazyChunk).toBeDefined();

    addModulePreloads(dir);
    expect(await preloadsOf(dir)).toEqual([`/${sharedChunk}`]);
  });

  it("follows static imports from chunk to chunk, each chunk once", async () => {
    const dir = stage({
      // The bare form, and a dynamic import that must not be linked.
      "index.js": 'import"./a-1.js";import("./lazy-3.js").then(()=>{});',
      // a and b import each other: the walk must end.
      "a-1.js": 'import{b as x}from"./b-2.js";export const a=()=>x;',
      "b-2.js": 'import{a}from"./a-1.js";export const b=1;console.log(a);',
      "lazy-3.js": 'import{b}from"./b-2.js";export const l=b;',
    });
    addModulePreloads(dir);
    expect((await preloadsOf(dir)).sort()).toEqual(["/a-1.js", "/b-2.js"]);
  });

  it("keeps the page otherwise as it was", async () => {
    const dir = stage({ "index.js": 'import"./a-1.js";', "a-1.js": "" });
    addModulePreloads(dir);
    const html = readFileSync(join(dir, "index.html"), "utf8");
    const withoutLinks = html.replace(
      /\s*<link rel="modulepreload"[^>]*>/g,
      "",
    );
    expect(withoutLinks.replace(/\s+/g, " ")).toBe(
      PLACEHOLDER_HTML.replace(/\s+/g, " "),
    );
  });

  it("adds no link for an index.js with no static import", async () => {
    const dir = stage({
      "index.js": 'import("./lazy-3.js");',
      "lazy-3.js": "",
    });
    addModulePreloads(dir);
    expect(await preloadsOf(dir)).toEqual([]);
  });

  // scripts/build.sh runs this script on the stage dir: the links go in before
  // the stamp, so the build id covers them.
  it("the stamp script adds the links before it stamps", async () => {
    const dir = stage({
      "index.js": `import"./a-1.js";var v="${PLACEHOLDER}";`,
      "a-1.js": "export{};",
    });
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        join(import.meta.dir, "..", "scripts", "stamp-ui-build.ts"),
        dir,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await proc.exited).toBe(0);
    expect(await preloadsOf(dir)).toEqual(["/a-1.js"]);
    const html = readFileSync(join(dir, "index.html"), "utf8");
    const id = /<meta name="isomux-ui-build" content="([^"]*)"/.exec(html)?.[1];
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    // The id hashes the page with its links: the same page without them
    // stamps to another id.
    const bare = stage({
      "index.js": `import"./a-1.js";var v="${PLACEHOLDER}";`,
      "a-1.js": "export{};",
    });
    expect(stampUiBuild(bare)).not.toBe(id);
  });
});

describe("trackUiBuild", () => {
  function track(dir: string) {
    const sent: ServerMessage[] = [];
    const tracker = trackUiBuild(dir, (msg) => sent.push(msg), {
      pollMs: POLL_MS,
    });
    trackers.push(tracker);
    return { tracker, sent };
  }

  it("knows the id at start and sends one message per change", async () => {
    const dir = distDir();
    writeBuild(dir, "aaaaaaaaaaaaaaaa");
    const { tracker, sent } = track(dir);
    expect(tracker.current()).toBe("aaaaaaaaaaaaaaaa");

    writeBuild(dir, "bbbbbbbbbbbbbbbb");
    await until(() => sent.length >= 1, "first change");
    expect(tracker.current()).toBe("bbbbbbbbbbbbbbbb");

    // The same id again, with a new mtime: the stat changes, the id does not.
    writeBuild(dir, "bbbbbbbbbbbbbbbb");
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "index.html"), later, later);
    await Bun.sleep(POLL_MS * 5);

    writeBuild(dir, "cccccccccccccccc");
    await until(() => sent.length >= 2, "second change");
    await Bun.sleep(POLL_MS * 3);
    expect(sent).toEqual([
      { type: "ui_build", uiBuild: "bbbbbbbbbbbbbbbb" },
      { type: "ui_build", uiBuild: "cccccccccccccccc" },
    ]);
  });

  it("sends null when the page goes away", async () => {
    const dir = distDir();
    writeBuild(dir, "aaaaaaaaaaaaaaaa");
    const { tracker, sent } = track(dir);
    rmSync(join(dir, "index.html"));
    await until(() => sent.length >= 1, "removal");
    expect(sent).toEqual([{ type: "ui_build", uiBuild: null }]);
    expect(tracker.current()).toBeNull();
  });

  it("sends nothing after stop", async () => {
    const dir = distDir();
    writeBuild(dir, "aaaaaaaaaaaaaaaa");
    const { tracker, sent } = track(dir);
    writeBuild(dir, "bbbbbbbbbbbbbbbb");
    await until(() => sent.length >= 1, "change before stop");
    tracker.stop();
    writeBuild(dir, "cccccccccccccccc");
    await Bun.sleep(POLL_MS * 5);
    expect(sent).toEqual([{ type: "ui_build", uiBuild: "bbbbbbbbbbbbbbbb" }]);
  });
});
