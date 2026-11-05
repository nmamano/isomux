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

// Task 95ae0c65: Chrome's ARIA snapshot drops every option inside an
// <optgroup> of a combobox <select>, so an agent read a grouped Channel list
// as empty. The snapshot lists them after the tree, per combobox. A select
// that the tree leaves out (aria-hidden, display:none) adds nothing, and a
// listbox select already shows its groups.
test.skipIf(process.env.ISOMUX_TEST_BROWSER_EXTENSION !== "1")(
  "a snapshot lists the options in a combobox select's groups, per select, in scope and frame",
  async () => {
    const browser = await chromium.launch({
      executablePath: "/usr/bin/google-chrome",
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      const root = page.mainFrame();
      const grouped = (name: string, options: string, style = "") =>
        `<label>${name} <select style="${style}"><optgroup label="Group ${name}">${options}</optgroup></select></label>`;
      await page.setContent(`<section id="discord">
          <label>Channel <select id="channel">
            <option value="" disabled>Choose a channel</option>
            <optgroup label="Text Channels"><option>general</option><option>isomux-chat</option></optgroup>
            <optgroup label="Info"><option disabled>rules</option></optgroup>
            <option>loose</option>
          </select></label>
          ${grouped("Zero", "<option>zeta-one</option>", "width:0;height:0;border:0;padding:0")}
        </section>
        <section id="other">
          <label>Plain <select><option>plain-one</option></select></label>
          <label>Multi <select multiple><optgroup label="M"><option>multi-one</option></optgroup></select></label>
        </section>
        <div aria-hidden="true">${grouped("Hidden", "<option>hidden-one</option>")}</div>
        ${grouped("Gone", "<option>gone-one</option>", "display:none")}
        <input type="password" aria-label="Password" id="pw">
        ${grouped("Secrets", "<option>hunter-secret-9</option>")}
        <iframe srcdoc='${grouped("Inner", "<option>frame-one</option>")}'></iframe>`);
      await page.selectOption("#channel", { label: "isomux-chat" });
      await page.fill("#pw", "hunter-secret-9");
      const inner = page.frames()[1];
      await inner.waitForSelector("select");

      // The premise, read straight from Chrome: the tree shows each combobox
      // and its loose options, but no option in a group, while a listbox
      // select shows its groups.
      const tree = await root.locator("body").ariaSnapshot();
      for (const name of ["Channel", "Zero", "Plain", "Secrets"])
        expect(tree).toContain(`- combobox "${name}"`);
      expect(tree).toContain('- option "loose"');
      expect(tree).toContain('- option "multi-one"');
      for (const option of ["general", "isomux-chat", "rules", "zeta-one"])
        expect(tree).not.toContain(`"${option}"`);
      expect(await inner.locator("body").ariaSnapshot()).not.toContain(
        "frame-one",
      );

      const read = await readBrowserFrames(root, "snapshot", 20_000, 5000);
      const [main, child] = read.split("--- Frame framePath=[0] ---");
      expect(child).toBeDefined();
      expect(read).not.toContain("[ref=");
      // The password value is masked, also where it is an option name.
      expect(read).not.toContain("hunter-secret-9");
      // The tree itself is unchanged; what follows lists each combobox select
      // that has groups, with all its options and their states.
      const masked = tree.replace("hunter-secret-9", PASSWORD_MASK);
      expect(main.startsWith(masked.slice(0, masked.indexOf("- iframe")))).toBe(
        true,
      );
      const listed = main.slice(main.indexOf("- iframe"));
      const blocks = new Map(
        listed
          .split(/^(?=- combobox )/m)
          .slice(1)
          .map((block) => [block.slice(0, block.indexOf("\n")), block]),
      );
      const block = (name: string) =>
        [...blocks].find(([head]) =>
          head.startsWith(`- combobox "${name}"`),
        )?.[1] ?? "";
      expect([...blocks.keys()].map((head) => head.split('"')[1])).toEqual([
        "Channel",
        "Zero",
        "Secrets",
      ]);
      const channel = block("Channel");
      expect(channel).toMatch(/- option "Choose a channel" \[disabled\]/);
      expect(channel).toContain('- option "general"\n');
      expect(channel).toMatch(/- option "isomux-chat" \[selected\]/);
      expect(channel).toMatch(/- option "rules" \[disabled\]/);
      expect(channel).toContain('- option "loose"');
      expect(channel).not.toContain("zeta-one");
      expect(block("Zero")).toContain('- option "zeta-one"');
      expect(block("Secrets")).toContain(`- option "${PASSWORD_MASK}"`);
      for (const absent of ["hidden-one", "gone-one", "frame-one"])
        expect(main).not.toContain(absent);
      expect(child).toContain('- option "frame-one"');

      // A scoped read lists the selects in its scope, the scope element too.
      const scoped = (selector: string) =>
        readBrowserFrames(root, "snapshot", 20_000, 5000, { selector });
      expect(await scoped("#other")).toBe(
        await root.locator("#other").ariaSnapshot(),
      );
      expect(await scoped("#channel")).toContain('- option "general"');
      expect(await scoped("#discord")).toContain('- option "zeta-one"');
      expect(
        await readBrowserFrames(root, "snapshot", 20_000, 5000, {
          framePath: [0],
        }),
      ).toContain('- option "frame-one"');
    } finally {
      await browser.close();
    }
  },
  30_000,
);
