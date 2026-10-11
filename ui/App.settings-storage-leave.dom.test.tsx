import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render, within } =
  await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

const { settingsReportsApi: apiShim } =
  await import("./test-support/settings-reports-fixture.ts");
beforeEach(() => setApiShim(apiShim));
afterAll(() => setApiShim(null));

describe("Storage cleanup navigation", () => {
  it("uses the leave prompt while Storage cleanup is applying", async () => {
    window.history.replaceState(null, "", "/settings");
    const view = render(
      onLanguage(null, createElement(App, {}), {
        hasReceivedInitialState: true,
      }),
    );

    // Restrict the lookup to the named button. Computing accessible names
    // for every button in App dominated this test's cost under load.
    const storage = view.getByText("Storage", { selector: "button" });
    fireEvent.click(
      within(storage.parentElement!).getByRole("button", { name: "Storage" }),
    );
    const content = within(view.getByTestId("settings-content"));
    fireEvent.click(
      content.getByRole("button", { name: "Preview what would be deleted" }),
    );
    fireEvent.click(
      await content.findByRole("button", {
        name: /Delete 1 conversation transcripts permanently/,
      }),
    );
    fireEvent.change(content.getByPlaceholderText("Type DELETE to confirm"), {
      target: { value: "DELETE" },
    });
    fireEvent.click(
      content.getByRole("button", { name: "Delete permanently" }),
    );
    const applying = content.getByRole("button", { name: "Deleting…" });
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
});
