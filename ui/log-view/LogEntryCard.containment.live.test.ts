// Real-Chrome check that a chat reply cannot draw outside its own bubble
// (task 1b92a224). Containment is geometry, which happy-dom does not lay out,
// so this renders the real assistant card with the real stylesheet in Chrome.
// Local Chrome only, gated with the other Chrome tests (*.live.test.ts).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { LIVE } from "../../server/test-support/live-gate.ts";

const REPO = resolve(import.meta.dir, "../..");
const CHROME = "/usr/bin/google-chrome";

// Payloads an echoed reply can carry. Each escapes the bubble by a different
// route, so each mutant of the containment rule dies on its own case.
const FIXED = `<div style="position: fixed; inset: 0; z-index: 99999; background: red">Sign in</div>`;
const ABSOLUTE = `<div style="position: absolute; top: -500px; left: -500px; width: 3000px; height: 3000px; z-index: 99999; background: red">Sign in</div>`;
const TRANSFORM = `<div style="transform: translate(-300px, -300px) scale(20); background: red">Sign in</div>`;
const PROSE =
  "The first line of this reply wraps beside the date and the buttons in the corner of the bubble. ".repeat(
    4,
  );

let dir = "";
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;

describe.skipIf(!LIVE)("chat reply containment (real Chrome)", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "containment-"));
    // The entry lives outside the repo, so it names every module by its
    // resolved path, and it uses createElement because no JSX runtime
    // resolves from there.
    const entry = join(dir, "entry.ts");
    const from = (spec: string) => JSON.stringify(Bun.resolveSync(spec, REPO));
    writeFileSync(
      entry,
      `import { createElement } from ${from("react")};
import { createRoot } from ${from("react-dom/client")};
import { CSS } from ${from("./ui/styles.ts")};
import { LogEntryCard } from ${from("./ui/log-view/LogEntryCard.tsx")};
const style = document.createElement("style");
style.textContent = CSS;
document.head.append(style);
const content = decodeURIComponent(location.hash.slice(1));
createRoot(document.getElementById("root")).render(
  createElement(LogEntryCard, {
    entry: { id: "e", agentId: "a", timestamp: Date.UTC(2026, 9, 25), kind: "text", content },
  }),
);
`,
    );
    const built = await Bun.build({ entrypoints: [entry], outdir: dir });
    if (!built.success)
      throw new Error(built.logs.map((log) => log.message).join("\n"));
    writeFileSync(
      join(dir, "index.html"),
      `<!doctype html><html><body style="margin:0"><div id="root" style="width:480px;margin:200px auto"></div><script type="module" src="/entry.js"></script></body></html>`,
    );
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        const file = Bun.file(join(dir, path === "/" ? "index.html" : path));
        return file.size
          ? new Response(file)
          : new Response(null, { status: 404 });
      },
    });
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop(true);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function open(content: string): Promise<Page> {
    const page = await browser!.newPage({
      viewport: { width: 1000, height: 900 },
    });
    await page.goto(
      `http://127.0.0.1:${server!.port}/#${encodeURIComponent(content)}`,
    );
    await page.waitForSelector("time[data-message-timestamp]");
    await page.waitForSelector(".md-content p");
    return page;
  }

  // Points outside the bubble, in each direction. Each must hit the page, not
  // the reply. The enabling condition (the payload kept its style) is part of
  // the result so a sanitizer that strips the style cannot make it vacuous.
  async function outside(page: Page) {
    return page.evaluate(() => {
      const md = document.querySelector<HTMLElement>(".md-content")!;
      // The sanitizer drops data-* and class, so the payload is the one
      // styled block in the reply.
      const payload = md.querySelector<HTMLElement>("div[style]");
      const box = md.parentElement!.getBoundingClientRect();
      const points = [
        [20, 20],
        [box.left - 40, box.top + 10],
        [box.right + 40, box.top + 10],
        [box.left + 20, box.bottom + 40],
        [innerWidth - 20, innerHeight - 20],
      ];
      return {
        payloadStyled: !!payload && payload.style.length > 0,
        inReply: points.map(([x, y]) => {
          const hit = document.elementFromPoint(x, y);
          return !!hit?.closest(".md-content");
        }),
      };
    });
  }

  for (const [name, payload] of [
    ["position: fixed", FIXED],
    ["position: absolute with a far offset", ABSOLUTE],
    ["a transform that moves and scales", TRANSFORM],
  ] as const) {
    it(`keeps ${name} inside the message`, async () => {
      const page = await open(`${PROSE}\n\n${payload}`);
      const result = await outside(page);
      await page.close();
      expect(result).toEqual({
        payloadStyled: true,
        inReply: [false, false, false, false, false],
      });
    });
  }

  it("keeps the bubble's date and buttons above a payload", async () => {
    const page = await open(`${PROSE}\n\n${FIXED}`);
    const result = await page.evaluate(() => {
      const md = document.querySelector<HTMLElement>(".md-content")!;
      const corner = document.querySelector(
        "time[data-message-timestamp]",
      )!.parentElement!;
      const c = corner.getBoundingClientRect();
      const m = md.getBoundingClientRect();
      const controls = [
        ...corner.querySelectorAll<HTMLElement>("time, button"),
      ];
      return {
        // Enabling: the corner floats over the reply's own box.
        overlaps:
          c.left >= m.left &&
          c.right <= m.right &&
          c.top >= m.top &&
          c.bottom <= m.bottom,
        controls: controls.length,
        hits: controls.map((el) => {
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(
            r.left + r.width / 2,
            r.top + r.height / 2,
          );
          return !!hit && el.contains(hit);
        }),
      };
    });
    await page.close();
    expect(result.overlaps).toBe(true);
    expect(result.controls).toBeGreaterThan(1);
    expect(result.hits).toEqual(result.hits.map(() => true));
  });

  // The containment must not make the reply its own formatting context:
  // that narrows the whole reply by the corner's width instead of wrapping
  // the first lines around it (contain: paint and contain: layout do this).
  it("still wraps the first lines beside the corner at full width", async () => {
    const page = await open(PROSE);
    const result = await page.evaluate(() => {
      const md = document.querySelector<HTMLElement>(".md-content")!;
      const bubble = md.parentElement!;
      const cs = getComputedStyle(bubble);
      const inner =
        bubble.clientWidth -
        parseFloat(cs.paddingLeft) -
        parseFloat(cs.paddingRight);
      const corner = document
        .querySelector("time[data-message-timestamp]")!
        .parentElement!.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(md.querySelector("p")!);
      const lines = [...range.getClientRects()];
      return {
        fullWidth:
          Math.round(md.getBoundingClientRect().width) === Math.round(inner),
        firstBesideCorner:
          lines[0].top < corner.bottom && lines[0].right <= corner.left,
        belowReachesCorner: lines.some(
          (r) => r.top >= corner.bottom && r.right > corner.left,
        ),
        wraps: lines.length > 2,
      };
    });
    await page.close();
    expect(result).toEqual({
      fullWidth: true,
      firstBesideCorner: true,
      belowReachesCorner: true,
      wraps: true,
    });
  });
});
