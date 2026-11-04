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
import { stampUiBuild, trackUiBuild, type UiBuildTracker } from "./ui-build.ts";

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
