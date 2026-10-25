import { test, expect } from "bun:test";
import { chromium } from "playwright-core";
import { PASSWORD_MASK, readBrowserFrames } from "./browser-frames";
import {
  PASSWORD_FILLS,
  PASSWORD_LEAKS,
  PASSWORD_PAGE,
  PASSWORD_SNAPSHOT,
} from "./test-support/password-snapshot-fixture";

// Real Chrome, real Playwright rendering. Run with ISOMUX_TEST_BROWSER_EXTENSION=1.
test.skipIf(process.env.ISOMUX_TEST_BROWSER_EXTENSION !== "1")(
  "snapshot and text reads mask filled password fields in every frame",
  async () => {
    const browser = await chromium.launch({
      executablePath: "/usr/bin/google-chrome",
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await page.setContent(
        PASSWORD_PAGE +
          `<iframe srcdoc="<input type=password aria-label=Inner id=inner>"></iframe>`,
      );
      for (const [id, value] of PASSWORD_FILLS)
        await page.fill(`#${id}`, value);
      const inner = page.frames()[1];
      await inner.waitForSelector("#inner");
      await inner.fill("#inner", "frame-secret");
      // The page renders what the fake-frame tests feed to the mask.
      expect(await page.locator("body").ariaSnapshot()).toBe(
        PASSWORD_SNAPSHOT + "\n- iframe",
      );
      expect(await inner.locator("body").ariaSnapshot()).toContain(
        "frame-secret",
      );

      const root = page.mainFrame();
      const snapshot = await readBrowserFrames(root, "snapshot", 20_000, 5000);
      const [main, child] = snapshot.split("--- Frame framePath=[0] ---");
      expect(child).toBeDefined();
      for (const leak of [...PASSWORD_LEAKS, "frame-secret"])
        expect(snapshot).not.toContain(leak);
      expect(main).toContain(`- textbox "Password": ${PASSWORD_MASK}`);
      expect(main).toContain(`- textbox "PIN": ${PASSWORD_MASK}`);
      expect(main).toContain("- paragraph: Step 3 of 4");
      expect(child).toContain(`- textbox "Inner": ${PASSWORD_MASK}`);

      const scoped = await readBrowserFrames(root, "snapshot", 20_000, 5000, {
        selector: "#plain",
      });
      expect(scoped).toBe(`- textbox "Password": ${PASSWORD_MASK}`);
      const scopedChild = await readBrowserFrames(
        root,
        "snapshot",
        20_000,
        5000,
        { framePath: [0], selector: "#inner" },
      );
      expect(scopedChild).toBe(`- textbox "Inner": ${PASSWORD_MASK}`);

      const text = await readBrowserFrames(root, "text", 20_000, 5000);
      expect(text).toContain("Step 3 of 4");
      for (const leak of [...PASSWORD_LEAKS, "frame-secret"])
        expect(text).not.toContain(leak);
    } finally {
      await browser.close();
    }
  },
  30_000,
);
