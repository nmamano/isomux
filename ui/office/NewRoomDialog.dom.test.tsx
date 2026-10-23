import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render, fireEvent } = await import("@testing-library/react");
const { NewRoomDialog } = await import("./NewRoomDialog.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");

const { t } = translatorFor("en");

afterAll(() => setApiShim(null));

// The title's translations are ui/dialogs.secondary.i18n.dom.test.tsx's.
it("opens on Cancel, and says a failure in the member's language", async () => {
  setApiShim(async () => {
    throw new Error("offline");
  });
  const failure = async (language: "en" | "es" | "ca") => {
    const view = render(
      onLanguage(language, <NewRoomDialog onClose={() => {}} />),
    );
    // Cancel, then the confirmation, in DOM order.
    const buttons = view.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(document.activeElement).toBe(buttons[0]);
    await act(async () => fireEvent.click(buttons[1]));
    const text = view.getByRole("alert").textContent ?? "";
    view.unmount();
    return text;
  };
  const en = await failure("en");
  expect(en.trim()).not.toBe("");
  for (const language of ["es", "ca"] as const)
    expect(await failure(language)).not.toBe(en);
});

it("supports keyboard cancellation and blocks repeated confirmation while pending", async () => {
  let closeCount = 0;
  let calls = 0;
  let reject!: (error: Error) => void;
  setApiShim(() => {
    calls++;
    return new Promise((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
  });
  const view = render(
    <NewRoomDialog
      onClose={() => {
        closeCount++;
      }}
    />,
  );
  const cancel = view.getByRole("button", { name: t("common.cancel") });
  const confirm = view.getByRole("button", {
    name: t("office.newRoom.confirm"),
  });
  fireEvent.keyDown(cancel, { key: "Tab", bubbles: true });
  expect(document.activeElement).toBe(confirm);
  fireEvent.keyDown(confirm, { key: "Tab", shiftKey: true, bubbles: true });
  expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(cancel, { key: "Escape", bubbles: true });
  expect(closeCount).toBe(1);
  await act(async () => {
    fireEvent.click(confirm);
    fireEvent.click(confirm);
  });
  expect(calls).toBe(1);
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(document.body, { key: "Escape", bubbles: true });
  expect(closeCount).toBe(1);
  await act(async () => reject(new Error("offline")));
  expect((confirm as HTMLButtonElement).disabled).toBe(false);
});

it("restores opener focus on cancel but leaves it behind after creating a room", async () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  const room = {
    id: "created",
    name: "Room 2",
    prompt: null,
    canCloseWhenEmpty: true,
  };
  setApiShim(async () => ({ room }));
  try {
    opener.focus();
    const cancelled = render(
      <NewRoomDialog onClose={() => cancelled.unmount()} />,
    );
    fireEvent.click(
      cancelled.getByRole("button", { name: t("common.cancel") }),
    );
    expect(document.activeElement).toBe(opener);
    const created = render(<NewRoomDialog onClose={() => created.unmount()} />);
    await act(async () =>
      fireEvent.click(
        created.getByRole("button", { name: t("office.newRoom.confirm") }),
      ),
    );
    expect(document.activeElement).not.toBe(opener);
    expect(document.activeElement).toBe(document.body);
  } finally {
    opener.remove();
  }
});
