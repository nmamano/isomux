import { writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { CAPTURE_KICK_MS } from "../browser-extension-bridge";
import { SCREENCAST_KICK_PARAMS } from "../../shared/browser-extension-protocol";

// An evidence screenshot of a background tab over the test's own CDP session.
// Chrome can leave that capture unanswered, as it can the agent's (task
// c04479de), so this sends the bridge's screencast kick while the capture
// waits, never a second capture (task f6dc01e6).
export async function screenshotBackgroundTab(
  page: Page,
  path: string,
): Promise<void> {
  const session = await page.context().newCDPSession(page);
  let kicked = false;
  const timer = setTimeout(() => {
    kicked = true;
    session
      .send("Page.startScreencast", { ...SCREENCAST_KICK_PARAMS })
      .catch(() => {});
  }, CAPTURE_KICK_MS);
  try {
    const { data } = await session.send("Page.captureScreenshot", {
      format: "png",
    });
    writeFileSync(path, Buffer.from(data, "base64"));
  } finally {
    clearTimeout(timer);
    if (kicked) await session.send("Page.stopScreencast").catch(() => {});
    await session.detach().catch(() => {});
  }
}
