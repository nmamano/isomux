import { test, expect } from "bun:test";
import { chromium, type Frame } from "playwright-core";
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

// Task 1be94be4: a page that hides its content with aria-hidden (a modal
// library marks a dialog's siblings, and may leave them so) has an empty
// accessibility tree while its text still reads. The snapshot section says so,
// without page content, so the agent turns to text and CSS selectors. A blank
// section, or content that is not rendered, still reads as empty.
test.skipIf(process.env.ISOMUX_TEST_BROWSER_EXTENSION !== "1")(
  "a snapshot of rendered content hidden by aria-hidden says so; blank or unrendered content stays empty",
  async () => {
    const browser = await chromium.launch({
      executablePath: "/usr/bin/google-chrome",
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      const root = page.mainFrame();
      const words = "Zephyrine Quillwort";
      const hidden = `<main aria-hidden="true"><h1>${words}</h1><button>Persist</button><div id="panel"><p>${words}</p></div></main>`;
      // The premise of each case, read straight from Chrome.
      const premise = async (frame: Frame, selector: string) => ({
        snapshot: await frame.locator(selector).ariaSnapshot(),
        text: (await frame.locator(selector).innerText()).trim() !== "",
        visible: await frame.locator(selector).isVisible(),
      });
      const snapshot = (scope?: { selector?: string; framePath?: number[] }) =>
        readBrowserFrames(root, "snapshot", 20_000, 5000, scope);

      // The report: the dialog closed, its siblings stayed aria-hidden.
      await page.setContent(
        hidden + `<div class="cdk-overlay-container"></div>`,
      );
      expect(await premise(root, "body")).toEqual({
        snapshot: "",
        text: true,
        visible: true,
      });
      const marker = await snapshot();
      expect(marker).toMatch(/^\[[^\n]*aria-hidden[^\n]*\]$/);
      expect(marker).not.toMatch(/Zephyrine|Quillwort|Persist/);
      expect(await snapshot({ selector: "#panel" })).toBe(marker);

      // aria-hidden on the read element, on an ancestor of it, and in the
      // other case spelling Chrome honours.
      for (const html of [
        `<body aria-hidden="true">${hidden}</body>`,
        `<html aria-hidden="true"><body><p>${words}</p></body></html>`,
        `<p aria-hidden="TRUE">${words}</p>`,
      ]) {
        await page.setContent(html);
        expect(await premise(root, "body")).toEqual({
          snapshot: "",
          text: true,
          visible: true,
        });
        expect(await snapshot()).toBe(marker);
      }

      // In a child frame the marker fills that frame's section only.
      await page.setContent(
        `<p>Visible top</p><iframe srcdoc='${hidden}'></iframe>`,
      );
      expect(await premise(page.frames()[1], "body")).toEqual({
        snapshot: "",
        text: true,
        visible: true,
      });
      expect(await snapshot()).toBe(
        `- paragraph: Visible top\n- iframe\n\n--- Frame framePath=[0] ---\n${marker}`,
      );
      expect(await snapshot({ framePath: [0] })).toBe(marker);

      // Rendered and aria-hidden, but no text: a blank section stays blank.
      await page.setContent(
        `<div aria-hidden="true" style="height:80px;background:#ccc"></div>`,
      );
      expect(await premise(root, "body")).toEqual({
        snapshot: "",
        text: false,
        visible: true,
      });
      expect(await snapshot()).toBe("");

      // aria-hidden content with text that is not rendered: innerText reads
      // textContent there, so text alone would claim a hidden tree.
      await page.setContent(`<body style="display:none">${hidden}</body>`);
      expect(await premise(root, "body")).toEqual({
        snapshot: "",
        text: true,
        visible: false,
      });
      expect(await snapshot()).toBe("");
      await page.setContent(
        `<p>Visible top</p><div id="off" style="display:none">${hidden}</div><iframe style="display:none" srcdoc='${hidden}'></iframe>`,
      );
      expect(await premise(root, "#off")).toEqual({
        snapshot: "",
        text: true,
        visible: false,
      });
      expect(await premise(page.frames()[1], "body")).toEqual({
        snapshot: "",
        text: true,
        visible: false,
      });
      expect(await snapshot({ selector: "#off" })).toBe("");
      expect(await snapshot()).toBe(
        `- paragraph: Visible top\n\n--- Frame framePath=[0] ---\n`,
      );
    } finally {
      await browser.close();
    }
  },
  30_000,
);
