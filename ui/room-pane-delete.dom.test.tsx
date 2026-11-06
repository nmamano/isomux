// "Delete empty room" in room settings (task c6589760): the room and its
// settings go, with no Undo, so the button asks first.
import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { RoomPane } = await import("./components/RoomPane.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { translatorFor } = await import("../shared/i18n/translate.ts");
const { createElement } = await import("react");

const calls: string[] = [];
setApiShim(async (method, path) => {
  calls.push(`${method} ${path}`);
  if (path.endsWith("/settings")) return { prompt: "", version: "0" };
  if (path.endsWith("/instructions")) return { instructions: "", version: "0" };
  if (path.startsWith("/api/memory"))
    return { text: "", version: "0", size: 0, cap: 4000 };
  return undefined;
});
afterAll(() => setApiShim(null));

it("Delete empty room arms on the first click and sends nothing; the second deletes the room once and closes the pane", async () => {
  const room = {
    id: "r9",
    name: "Spare",
    prompt: null,
    canCloseWhenEmpty: true,
  };
  let deletedCalls = 0;
  const view = render(
    onLanguage(
      "en",
      createElement(RoomPane, {
        roomId: room.id,
        onDeleted() {
          deletedCalls++;
        },
      }),
      { rooms: [room], agents: [] },
    ),
  );
  await act(async () => {});
  const label = translatorFor("en").t("settings.room.deleteEmpty");
  const del = [...view.container.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  )!;
  expect(del).toBeTruthy();
  const deletes = () => calls.filter((c) => c.startsWith("DELETE "));
  await act(async () => fireEvent.click(del));
  expect([deletes(), deletedCalls]).toEqual([[], 0]);
  expect(del.hasAttribute("data-confirm-armed")).toBe(true);
  await act(async () => fireEvent.click(del));
  expect([deletes(), deletedCalls]).toEqual([["DELETE /api/rooms/r9"], 1]);
  view.unmount();
});
