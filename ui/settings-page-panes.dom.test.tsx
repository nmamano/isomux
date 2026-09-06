import { afterAll, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { UserSettingsView } = await import("./components/UserSettingsView.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

setApiShim(async (_method, path) => {
  if (path.startsWith("/api/memory")) return { text: "", version: "0", size: 0, cap: 4000 };
  // Leave report data unloaded: this test exercises the page layout, including
  // its loading state, without coupling it to usage totals.
  if (path === "/api/usage" || path === "/api/storage/usage" || path === "/api/backup/status")
    return null;
  return {};
});
afterAll(() => setApiShim(null));

describe("Settings report panes", () => {
  for (const isMobile of [false, true]) {
    it(`renders Storage and Usage as page content (${isMobile ? "mobile" : "desktop"})`, async () => {
      const view = render(onLanguage(null, createElement(UserSettingsView, {
        onSwitchUser: () => {}, onClose: () => {},
      }), { isMobile }));
      for (const [label, heading] of [["Storage", "Office Storage"], ["Usage", "Office Usage"]]) {
        const row = view.getAllByRole("button").find((el) => el.textContent?.trim() === label);
        expect(row).toBeDefined();
        await act(async () => { fireEvent.click(row!); });
        const region = view.getByTestId("settings-content");
        const title = view.getByRole("heading", { name: heading, level: 3 });
        expect(region.contains(title)).toBe(true);
        expect(region.style.overflowY).toBe("auto");
        // The old inline card was already contained. This separate oracle
        // rejects that card and a second vertical scroller.
        let ancestor = title.parentElement;
        while (ancestor && ancestor !== region) {
          expect(ancestor.style.backdropFilter, heading).toBe("");
          expect(ancestor.style.boxShadow, heading).toBe("");
          expect(ancestor.style.background, heading).not.toBe("var(--bg-overlay)");
          expect(ancestor.style.width, heading).not.toMatch(/px$/);
          ancestor = ancestor.parentElement;
        }
        for (const node of region.querySelectorAll<HTMLElement>("*")) {
          expect(node.style.overflowY, heading).not.toMatch(/auto|scroll/);
          expect(node.style.maxHeight, heading).not.toMatch(/vh/);
        }
        if (isMobile) {
          const section = region.lastElementChild as HTMLElement;
          expect(section.style.paddingBottom).toBe("24px");
          expect(section.getAttribute("style")).toContain("24px");
          const back = view.getAllByRole("button").find((el) => el.textContent?.trim() === "← Settings");
          expect(back).toBeDefined();
          fireEvent.click(back!);
        }
      }
    });
  }
});
