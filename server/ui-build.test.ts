import { afterEach, describe, expect, it } from "bun:test";
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
  readUiBuild,
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

async function until(cond: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await Bun.sleep(5);
  }
}

describe("readUiBuild", () => {
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
    expect(readUiBuild(dir)).toBe(want);
  });

  it("a missing page", () => {
    expect(readUiBuild(distDir())).toBeNull();
  });
});

describe("stampUiBuild", () => {
  function stage(js: string, html = PLACEHOLDER_HTML): string {
    const dir = distDir();
    writeFileSync(join(dir, "index.js"), js);
    writeFileSync(join(dir, "index.html"), html);
    return dir;
  }
  const metaOf = (dir: string) =>
    /<meta name="isomux-ui-build" content="([^"]*)"/.exec(
      readFileSync(join(dir, "index.html"), "utf8"),
    )?.[1];

  it("puts the id in the page meta, where the server reads it", () => {
    const dir = stage("console.log(1);");
    const id = stampUiBuild(dir);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(metaOf(dir)).toBe(id);
    expect(readUiBuild(dir)).toBe(id);
    // The page is the only carrier: no other file is added to the stage,
    // where the publish would take it into ui/dist.
    expect(readdirSync(dir).sort()).toEqual(["index.html", "index.js"]);
  });

  // A second stamp finds no placeholder. A new id for a page that carries the
  // old one would never match it, and the notice would never clear.
  it("refuses a page that is already stamped, and keeps the first id", () => {
    const dir = stage("console.log(1);");
    const id = stampUiBuild(dir);
    expect(() => stampUiBuild(dir)).toThrow();
    expect(metaOf(dir)).toBe(id);
    expect(readUiBuild(dir)).toBe(id);
  });

  it("the id depends only on the bundle and the page", () => {
    const same1 = stampUiBuild(stage("console.log(1);"));
    const same2 = stampUiBuild(stage("console.log(1);"));
    const otherJs = stampUiBuild(stage("console.log(2);"));
    const otherHtml = stampUiBuild(
      stage(
        "console.log(1);",
        PLACEHOLDER_HTML.replace("</body>", "<p></p></body>"),
      ),
    );
    expect(same2).toBe(same1);
    expect(otherJs).not.toBe(same1);
    expect(otherHtml).not.toBe(same1);
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

  it("picks up a build that lands after start", async () => {
    const dir = distDir();
    const { tracker, sent } = track(dir);
    expect(tracker.current()).toBeNull();
    writeBuild(dir, "aaaaaaaaaaaaaaaa");
    await until(() => sent.length >= 1, "first build");
    expect(sent).toEqual([{ type: "ui_build", uiBuild: "aaaaaaaaaaaaaaaa" }]);
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
