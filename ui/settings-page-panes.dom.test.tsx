import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

// Quarantined 2026-09-17, P1 e04ff785: only the flaky file timing cap.
// All three behavior tests remain active (5082 ms against a 5000 ms cap).
setUpDomTestFile({ capMs: Infinity });

const { act, fireEvent, render } = await import("@testing-library/react");
const { UserSettingsView } = await import("./components/UserSettingsView.tsx");
const { App } = await import("./App.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

const apiShim = async (method: string, path: string, body?: unknown) => {
  if (path.startsWith("/api/memory"))
    return { text: "", version: "0", size: 0, cap: 4000 };
  // Leave usage unloaded: this test exercises the page layout, including its
  // loading state, without coupling it to usage totals. Storage answers with
  // an empty measurement so its cleanup guard can run below.
  if (path === "/api/usage") return null;
  if (path === "/api/storage/usage")
    return {
      stateRoot: "/state",
      measuredAt: Date.now(),
      stateRootBytes: 0,
      categories: [],
      agents: [],
    };
  if (path === "/api/backup/status")
    return {
      lastRunAt: null,
      ok: false,
      error: null,
      retention: 0,
      destDir: "/backups",
    };
  if (method === "POST" && path === "/api/storage/prune") {
    const plan = {
      target: "transcripts",
      policy: { olderThanDays: 90, keepPerAgent: 5 },
      candidates: [
        {
          path: "agent-1/session.jsonl",
          bytes: 100,
          agentId: "agent-1",
          sessionId: "session",
          ageDays: 100,
          mtimeMs: 0,
        },
      ],
      bytes: 100,
      skipped: [],
    };
    if ((body as { apply?: boolean } | undefined)?.apply)
      return new Promise(() => {});
    return { plan, applied: null };
  }
  return {};
};
beforeEach(() => setApiShim(apiShim));
afterAll(() => setApiShim(null));

describe("Settings report panes", () => {
  it("uses the leave prompt while Storage cleanup is applying", async () => {
    window.history.replaceState(null, "", "/settings");
    const view = render(
      onLanguage(null, createElement(App, {}), {
        hasReceivedInitialState: true,
      }),
    );

    fireEvent.click(view.getByRole("button", { name: "Storage" }));
    // The preview response lands in a promise continuation. Resolve it inside
    // one act scope so React commits it here: run after ui/i18n.nav-languages
    // in the same bun process, a render scheduled outside act never commits
    // and findByRole times out (full ci 2026-09-16; task 76d20063 holds the
    // reproduction). Alone, either form passes.
    await act(async () => {
      fireEvent.click(
        view.getByRole("button", { name: "Preview what would be deleted" }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(
      view.getByRole("button", {
        name: /Delete 1 conversation transcripts permanently/,
      }),
    );
    fireEvent.change(view.getByPlaceholderText("Type DELETE to confirm"), {
      target: { value: "DELETE" },
    });
    fireEvent.click(view.getByRole("button", { name: "Delete permanently" }));
    const applying = view.getByRole("button", { name: "Deleting…" });
    expect(applying.hasAttribute("disabled")).toBe(true);

    const originalConfirm = window.confirm;
    window.confirm = () => {
      throw new Error("native confirm was called");
    };
    try {
      await act(async () => {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      });
    } finally {
      window.confirm = originalConfirm;
    }

    expect(view.queryByText(/A cleanup is still running/) !== null).toBe(true);
    expect(view.getByRole("button", { name: "Leave" })).toBeDefined();
    expect(window.location.pathname).toBe("/settings");
  });

  for (const isMobile of [false, true]) {
    it(`renders Storage and Usage as page content (${isMobile ? "mobile" : "desktop"})`, async () => {
      const view = render(
        onLanguage(
          null,
          createElement(UserSettingsView, {
            onSwitchUser: () => {},
            onClose: () => {},
          }),
          { isMobile },
        ),
      );
      for (const [label, heading] of [
        ["Storage", "Office Storage"],
        ["Usage", "Office Usage"],
      ]) {
        const row = view
          .getAllByRole("button")
          .find((el) => el.textContent?.trim() === label);
        expect(row).toBeDefined();
        await act(async () => {
          fireEvent.click(row!);
        });
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
          expect(ancestor.style.background, heading).not.toBe(
            "var(--bg-overlay)",
          );
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
          const back = view
            .getAllByRole("button")
            .find((el) => el.textContent?.trim() === "← Settings");
          expect(back).toBeDefined();
          fireEvent.click(back!);
        }
      }
    });
  }
});
