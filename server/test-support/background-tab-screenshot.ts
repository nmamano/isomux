import { writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { captureKickDelay } from "../browser-extension-bridge";

// An evidence screenshot of a background tab over the test's own CDP session.
// Chrome can leave that capture unanswered, as it can the agent's (task
// c04479de), so this sends the bridge's kicks while the capture waits.
export async function screenshotBackgroundTab(
  page: Page,
  path: string,
): Promise<void> {
  const session = await page.context().newCDPSession(page);
  const params = { format: "png" } as const;
  let kicks = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const kick = () => {
    session.send("Page.captureScreenshot", params).catch(() => {});
    timer = setTimeout(kick, captureKickDelay(++kicks));
  };
  timer = setTimeout(kick, captureKickDelay(0));
  try {
    const { data } = await session.send("Page.captureScreenshot", params);
    writeFileSync(path, Buffer.from(data, "base64"));
  } finally {
    clearTimeout(timer);
    await session.detach().catch(() => {});
  }
}
