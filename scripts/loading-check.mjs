// The loading check (task d3593a12): shows one view of the demo bundle while
// its data is held, then after it arrives, and reports what jumped. AGENTS.md
// "UI rules": a view keeps its layout while it loads.
//
//   bash scripts/loading-check.sh <out-dir> [--phone] [--light] [--warm]
//        [--root <css>] [--name <name>] [-- <selector to click>...]
//
// With no selectors, the demo is held from boot (the office state and every
// fetch): for the office, the sidebar, the lobby. With selectors, they are
// clicked in order with nothing held, and the hold starts just before the
// last click, the one that opens the view under test.
//
// With --warm, the demo first loads once with nothing held and then leaves
// the page, so the shapes the views store on this device for their
// placeholders (the sidebar's, the office's) are there for the checked load.
// Without it, the check is a first visit: only the default shapes can draw.
//
// Writes <out-dir>/loading-<name>.png (Loading and Loaded, labelled, a red
// box on each jump) and <out-dir>/report-<name>.txt. Exit 0: nothing jumped;
// 1: something jumped (the report lists it); 2: the check itself failed.
//
// playwright-core is not an Isomux dependency. The script takes it from
// --playwright <path to its index.mjs>, else the bare "playwright-core"
// specifier, else Nil's wallgame checkout. Google Chrome must be installed:
// it is driven through channel "chrome".

/* global Bun */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { layoutChanges, unstableIds } from "./loading-check-diff.ts";
import { rootShown, snapshot } from "./loading-check-snapshot.ts";

const repo = resolve(dirname(new URL(import.meta.url).pathname), "..");

function fail(message) {
  console.error(`loading-check: ${message}`);
  process.exit(2);
}

// A failure of the check itself, inside the browser run: reported as exit 2
// after the browser and the server are closed.
class CheckError extends Error {}
const die = (message) => {
  throw new CheckError(message);
};

function usage() {
  fail(
    "usage: loading-check.sh <out-dir under /tmp> [--phone] [--light] [--warm] [--root <css>] [--name <name>] [--playwright <index.mjs>] [-- <selector>...]",
  );
}

// Arguments.
const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
const opts = dash === -1 ? argv : argv.slice(0, dash);
const clicks = dash === -1 ? [] : argv.slice(dash + 1);
let outArg = null;
let phone = false;
let warm = false;
let theme = "dark";
let rootSel = "body";
let name = "view";
let playwrightPath = null;
for (let i = 0; i < opts.length; i++) {
  const a = opts[i];
  if (a === "--phone") phone = true;
  else if (a === "--light") theme = "light";
  else if (a === "--warm") warm = true;
  else if (a === "--root") rootSel = opts[++i] ?? usage();
  else if (a === "--name") name = opts[++i] ?? usage();
  else if (a === "--playwright") playwrightPath = resolve(opts[++i] ?? usage());
  else if (a.startsWith("--")) usage();
  else if (outArg === null) outArg = a;
  else usage();
}
if (!outArg) usage();
if (!/^[\w.-]+$/.test(name))
  fail("--name takes letters, digits, '.', '_' and '-'");
const outDir = resolve(outArg);
if (!outDir.startsWith("/tmp/"))
  fail(`the out dir must be under /tmp: ${outDir}`);
const toplevel = execFileSync(
  "git",
  ["-C", repo, "rev-parse", "--show-toplevel"],
  {
    encoding: "utf8",
  },
).trim();
if (outDir === toplevel || outDir.startsWith(`${toplevel}/`))
  fail(`the out dir must be outside the repo: ${outDir}`);
mkdirSync(outDir, { recursive: true });

const PLAYWRIGHT_TRIES = [
  ...(playwrightPath ? [playwrightPath] : []),
  "playwright-core",
  "/home/nil/nil/wallgame/node_modules/playwright-core/index.mjs",
];
let chromium = null;
for (const spec of PLAYWRIGHT_TRIES) {
  chromium = await import(spec).then(
    (m) => m.chromium,
    () => null,
  );
  if (chromium) break;
}
if (!chromium)
  fail(
    `cannot load playwright-core (tried ${PLAYWRIGHT_TRIES.join(", ")}): pass --playwright <path to playwright-core/index.mjs>. Google Chrome must be installed.`,
  );

// Build the demo bundle into the out dir and serve it.
const serveDir = join(outDir, "serve");
rmSync(serveDir, { recursive: true, force: true });
const build = spawnSync(
  "bun",
  ["scripts/build-demo.ts", join(serveDir, "demo")],
  {
    cwd: repo,
    encoding: "utf8",
  },
);
if (build.status !== 0)
  fail(`the demo build failed:\n${build.stdout}${build.stderr}`);

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    let path = decodeURIComponent(new URL(req.url).pathname);
    if (path === "/demo" || path === "/demo/") path = "/demo/index.html";
    const file = Bun.file(join(serveDir, path));
    return file
      .exists()
      .then((ok) =>
        ok && !path.includes("..")
          ? new Response(file)
          : new Response("", { status: 404 }),
      );
  },
});
const url = `http://127.0.0.1:${server.port}/demo/`;

// In the page: resolves when nothing under the root changed for quietMs,
// rejects after capMs.
function quiet([sel, quietMs, capMs]) {
  return new Promise((ok, no) => {
    const root = document.querySelector(sel) ?? document.body;
    let timer = setTimeout(done, quietMs);
    const cap = setTimeout(() => {
      obs.disconnect();
      clearTimeout(timer);
      no(new Error(`the view did not settle in ${capMs} ms`));
    }, capMs);
    const obs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, quietMs);
    });
    obs.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    function done() {
      obs.disconnect();
      clearTimeout(cap);
      ok();
    }
  });
}

// In the page: fonts loaded, finite animations done, SVG animations paused.
async function still(capMs) {
  await document.fonts.ready;
  const end = Date.now() + capMs;
  while (
    document
      .getAnimations()
      .some(
        (a) =>
          a.playState === "running" &&
          a.effect?.getTiming().iterations !== Infinity,
      ) &&
    Date.now() < end
  )
    await new Promise((r) => setTimeout(r, 50));
  for (const svg of document.querySelectorAll("svg")) svg.pauseAnimations?.();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let exitCode = 2;
const browser = await chromium
  .launch({ channel: "chrome", headless: true })
  .catch((err) => fail(`cannot start Chrome: ${err}`));
try {
  const context = await browser.newContext({
    viewport: phone
      ? { width: 390, height: 844 }
      : { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    hasTouch: phone,
    isMobile: phone,
  });
  await context.addInitScript((mode) => {
    localStorage.setItem("isomux-theme", mode);
  }, theme);
  if (warm) {
    // A visit before: loaded, then left, which stores the shapes.
    const before = await context.newPage();
    await before.goto(url, { waitUntil: "load" });
    await before.evaluate(quiet, ["body", 500, 10000]);
    await before.goto("about:blank");
    await before.close();
  }
  const page = await context.newPage();
  if (clicks.length === 0) {
    await page.addInitScript(() => {
      window.__isomuxDemoHoldAtBoot = true;
    });
  }
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url, { waitUntil: "load" });

  if (clicks.length > 0) {
    await page.evaluate(quiet, ["body", 500, 10000]);
    for (const [i, sel] of clicks.entries()) {
      const target = page.locator(sel).first();
      await target
        .waitFor({ timeout: 10000 })
        .catch(() => die(`no element matches click ${i + 1}: ${sel}`));
      if (i === clicks.length - 1)
        await page.evaluate(() => window.__isomuxDemoHold.hold());
      await target.click();
      if (i < clicks.length - 1)
        await page.evaluate(quiet, ["body", 500, 10000]);
    }
  }

  // Held.
  // The root may have no box (the body at phone width), but must be shown.
  const shown = await page
    .waitForFunction(rootShown, rootSel, { timeout: 10000 })
    .then(
      () => true,
      () => false,
    );
  if (!shown) {
    const matches = await page.evaluate(
      (sel) => document.querySelector(sel) !== null,
      rootSel,
    );
    die(
      matches
        ? `--root ${rootSel} is hidden while held: pick an outer --root`
        : `no element matches --root ${rootSel} while held`,
    );
  }
  await sleep(800);
  await page.evaluate(still, 3000);
  const heldSnap = await page.evaluate(snapshot, rootSel);
  const heldShot = join(outDir, `loading-${name}.held.png`);
  await page.screenshot({ path: heldShot });

  // Loaded.
  await page.evaluate(() => window.__isomuxDemoHold.release());
  await page.evaluate(quiet, [rootSel, 500, 10000]);
  await page.evaluate(still, 3000);
  const loadedSnap = await page.evaluate(snapshot, rootSel);
  const loadedShot = join(outDir, `loading-${name}.loaded.png`);
  await page.screenshot({ path: loadedShot });
  await sleep(1000);
  await page.evaluate(still, 3000);
  const loaded2Snap = await page.evaluate(snapshot, rootSel);
  if (!heldSnap || !loadedSnap || !loaded2Snap)
    die(`--root ${rootSel} left the page`);
  // Every comparison hangs off the root, recorded even with no box: a root
  // hidden while held, or one replaced at release, would read as a clean run.
  if (heldSnap.rootId === null)
    die(`--root ${rootSel} is hidden while held: pick an outer --root`);
  if (
    loadedSnap.rootId !== heldSnap.rootId ||
    loaded2Snap.rootId !== heldSnap.rootId
  )
    die(`--root ${rootSel} was replaced at release: pick an outer --root`);
  const held = heldSnap.boxes;
  const loaded = loadedSnap.boxes;
  const loaded2 = loaded2Snap.boxes;

  const unstable = unstableIds(loaded, loaded2);
  const changes = layoutChanges(held, loaded, { ignore: unstable });
  const r = (n) => Math.round(n);
  // Siblings pushed by the same amount (same parent, same dx, dy, dw, dh)
  // read as one line and one red box around them all.
  const groups = [];
  const byKey = new Map();
  for (const c of changes) {
    const key =
      c.kind === "moved"
        ? [c.after.parent, r(c.dx), r(c.dy), r(c.dw), r(c.dh)].join(" ")
        : null;
    const group = key === null ? undefined : byKey.get(key);
    if (group) group.push(c);
    else {
      const fresh = [c];
      groups.push(fresh);
      if (key !== null) byKey.set(key, fresh);
    }
  }
  const union = (boxes) => {
    const x0 = Math.min(...boxes.map((b) => b.x));
    const y0 = Math.min(...boxes.map((b) => b.y));
    const x1 = Math.max(...boxes.map((b) => b.x + b.w));
    const y1 = Math.max(...boxes.map((b) => b.y + b.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
  const describe = (g) => {
    const c = g[0];
    if (c.kind === "appeared")
      return `  appeared ${c.label} at ${r(c.after.x)},${r(c.after.y)} ${r(c.after.w)}x${r(c.after.h)}`;
    const deltas = `dx ${r(c.dx)} dy ${r(c.dy)} dw ${r(c.dw)} dh ${r(c.dh)}`;
    if (g.length === 1) return `  ${c.kind} ${c.label} ${deltas}`;
    return `  moved ${g.length} siblings ${deltas}: ${g[0].label} ... ${g[g.length - 1].label}`;
  };
  const lines = [
    `loading check: ${name} (${phone ? "phone" : "desktop"}, ${theme}), root ${rootSel}`,
    clicks.length
      ? `clicks: ${clicks.join("  >  ")} (held from the last)`
      : "held from boot",
    `elements: ${held.length} held, ${loaded.length} loaded; unstable, ignored: ${unstable.size}`,
    ...errors.map((e) => `page error: ${e}`),
    changes.length ? `${changes.length} jump(s):` : "no jumps",
    ...groups.map(describe),
  ];
  writeFileSync(join(outDir, `report-${name}.txt`), `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));

  // The image: the boxes to mark in each shot, then python3 PIL stitches it.
  const marks = groups.map((g) => ({
    held: union(g.map((c) => c.before ?? c.after)),
    loaded: union(g.map((c) => c.after)),
  }));
  const image = join(outDir, `loading-${name}.png`);
  const py = spawnSync(
    "python3",
    [
      "-I",
      join(repo, "scripts/loading-check-image.py"),
      heldShot,
      loadedShot,
      image,
    ],
    { input: JSON.stringify(marks), encoding: "utf8" },
  );
  if (py.status !== 0) die(`the image failed: ${py.stderr}`);
  console.log(`image: ${image}`);
  rmSync(heldShot);
  rmSync(loadedShot);
  exitCode = changes.length ? 1 : 0;
} catch (err) {
  console.error(
    `loading-check: ${err instanceof CheckError ? err.message : (err?.stack ?? err)}`,
  );
  exitCode = 2;
} finally {
  await browser.close();
  server.stop(true);
  if (existsSync(serveDir)) rmSync(serveDir, { recursive: true, force: true });
}
process.exit(exitCode);
