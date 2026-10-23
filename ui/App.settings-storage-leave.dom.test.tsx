import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render, within } =
  await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");
const { en } = await import("../shared/i18n/en.ts");

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
    const storage = view.getByText(en["settings.sidebar.storage"], {
      selector: "button",
    });
    fireEvent.click(
      within(storage.parentElement!).getByRole("button", {
        name: en["settings.sidebar.storage"],
      }),
    );
    const content = within(view.getByTestId("settings-content"));
    fireEvent.click(
      content.getByRole("button", { name: en["settings.storage.preview"] }),
    );
    fireEvent.click(
      await content.findByRole("button", {
        // "Delete 1 <target> permanently": the count is the plan's.
        name: (name) =>
          name.startsWith(
            en["settings.storage.deleteCount"]
              .replace("{count}", "1")
              .split("{target}")[0],
          ),
      }),
    );
    fireEvent.change(
      content.getByPlaceholderText(en["settings.storage.confirmPlaceholder"]),
      {
        target: { value: "DELETE" },
      },
    );
    fireEvent.click(
      content.getByRole("button", {
        name: en["settings.storage.deletePermanently"],
      }),
    );
    const applying = content.getByRole("button", {
      name: en["settings.storage.deleting"],
    });
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

    expect(view.queryByText(en["settings.storage.leaveConfirm"]) !== null).toBe(
      true,
    );
    expect(
      view.getByRole("button", { name: en["settings.storage.leave"] }),
    ).toBeDefined();
    expect(window.location.pathname).toBe("/settings");
  });
});
