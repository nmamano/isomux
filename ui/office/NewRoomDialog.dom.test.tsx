import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render, fireEvent } = await import("@testing-library/react");
const { NewRoomDialog } = await import("./NewRoomDialog.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");

afterAll(() => setApiShim(null));

it("translates the confirmation and failure in English, Spanish and Catalan", async () => {
  setApiShim(async () => { throw new Error("offline"); });
  for (const [language, title, confirm, cancel, failure] of [
    ["en", "Open new room?", "Open room", "Cancel", "Could not open the room. Try again."],
    ["es", "¿Abrir una nueva sala?", "Abrir sala", "Cancelar", "No se ha podido abrir la sala. Inténtalo de nuevo."],
    ["ca", "Obrir una sala nova?", "Obrir sala", "Cancel·la", "No s'ha pogut obrir la sala. Torna-ho a provar."],
  ] as const) {
    const view = render(onLanguage(language, <NewRoomDialog onClose={() => {}} />));
    expect(view.getByRole("dialog", { name: title })).toBeTruthy();
    expect(document.activeElement).toBe(view.getByRole("button", { name: cancel }));
    await act(async () => fireEvent.click(view.getByRole("button", { name: confirm })));
    expect(view.getByRole("alert").textContent).toBe(failure);
    view.unmount();
  }
});

it("supports keyboard cancellation and blocks repeated confirmation while pending", async () => {
  let closeCount = 0;
  let calls = 0;
  let reject!: (error: Error) => void;
  setApiShim(() => {
    calls++;
    return new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });
  });
  const view = render(<NewRoomDialog onClose={() => { closeCount++; }} />);
  const cancel = view.getByRole("button", { name: "Cancel" });
  const confirm = view.getByRole("button", { name: "Open room" });
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
