// Screenshots of the Lobby tab with the members chat, through the demo bundle.
// Evidence artifacts for a human to look at, never assertions.
//
//   bun scripts/members-chat-shots.mjs http://localhost:9878/demo/ /tmp/mchat-shots/slice-4
//
// playwright-core is not an isomux dependency; it is imported from the wallgame
// checkout as internal-docs/ui-verification.md describes, and the system Chrome
// is driven through channel "chrome".

import { mkdirSync } from "node:fs";
import { chromium } from "/home/nil/nil/wallgame/node_modules/playwright-core/index.mjs";

const [url, outDir] = process.argv.slice(2);
if (!url || !outDir) {
  console.error("usage: members-chat-shots.mjs <demo-url> <out-dir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const shots = [
  { name: "lobby-dark", mode: "dark", viewport: { width: 1280, height: 800 } },
  {
    name: "lobby-light",
    mode: "light",
    viewport: { width: 1280, height: 800 },
  },
  {
    name: "lobby-mobile-dark",
    mode: "dark",
    viewport: { width: 390, height: 844 },
    mobileList: true,
  },
];

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const shot of shots) {
    const context = await browser.newContext({
      viewport: shot.viewport,
      deviceScaleFactor: 1,
      hasTouch: !!shot.mobileList,
      isMobile: !!shot.mobileList,
    });
    if (shot.mobileList) {
      await context.addInitScript(() => {
        localStorage.setItem("isomux-mobile-view", "list");
      });
    }
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(url, { waitUntil: "networkidle" });
    await page.evaluate((mode) => {
      document.documentElement.setAttribute("data-theme", mode);
      document.documentElement.setAttribute("data-theme-mode", mode);
    }, shot.mode);
    const tab = page.locator("[data-lobby-tab] button");
    await tab.waitFor({ timeout: 15000 });
    await tab.click();
    await page.locator("[data-members-chat-list]").waitFor({ timeout: 15000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${outDir}/${shot.name}.png` });
    console.log(`${shot.name}: ${errors.length} page errors`);
    for (const e of errors) console.log("  " + e);
    await context.close();
  }
} finally {
  await browser.close();
}
