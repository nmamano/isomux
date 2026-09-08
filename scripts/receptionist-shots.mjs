// Screenshots of the lobby with the receptionist, through the demo bundle.
// Evidence artifacts for a human to look at, never assertions.
//
//   bun scripts/receptionist-shots.mjs http://localhost:9878/demo/ /tmp/recep-shots/slice-3
//
// playwright-core is not an isomux dependency; it is imported from the wallgame
// checkout as internal-docs/ui-verification.md describes, and the system Chrome
// is driven through channel "chrome".

import { mkdirSync } from "node:fs";
import { chromium } from "/home/nil/nil/wallgame/node_modules/playwright-core/index.mjs";

const [url, outDir] = process.argv.slice(2);
if (!url || !outDir) {
  console.error("usage: receptionist-shots.mjs <demo-url> <out-dir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const desktop = { width: 1280, height: 800 };
const shots = [
  { name: "lobby-dark", mode: "dark", viewport: desktop },
  { name: "lobby-light", mode: "light", viewport: desktop },
  { name: "chat-dark", mode: "dark", viewport: desktop, chat: true },
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
    const figure = page.locator(
      shot.mobileList ? "[data-receptionist-row]" : "[data-receptionist]",
    );
    await figure.waitFor({ timeout: 15000 });
    if (shot.chat) {
      await figure.click();
      await page.locator("textarea").first().waitFor({ timeout: 15000 });
      await page.locator("textarea").first().fill("Where do I get room access?");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${outDir}/${shot.name}.png` });
    console.log(`${shot.name}: ${errors.length} page errors`);
    for (const e of errors) console.log("  " + e);
    await context.close();
  }
} finally {
  await browser.close();
}
