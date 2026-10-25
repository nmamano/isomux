import { afterAll, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { RoomPane } = await import("./components/RoomPane.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

const calls: string[] = [];
setApiShim(async (method, path) => {
  calls.push(`${method} ${path}`);
  if (path.endsWith("/settings")) return { prompt: "", version: "0" };
  if (path.endsWith("/instructions")) return { instructions: "", version: "0" };
  if (path.startsWith("/api/memory"))
    return { text: "", version: "0", size: 0, cap: 4000 };
  throw new Error(`Unexpected route ${path}`);
});
afterAll(() => setApiShim(null));

describe("room settings memory scopes", () => {
  for (const type of ["lobby", "office"] as const) {
    it(`${type} exposes only supported memory and saves settings`, async () => {
      calls.length = 0;
      const room = {
        id: type,
        name: type,
        type,
        prompt: null,
        canCloseWhenEmpty: false,
      };
      const view = render(
        onLanguage(
          null,
          createElement(RoomPane, { roomId: type, onDeleted() {} }),
          { rooms: [room] },
        ),
      );
      await act(async () => {});
      expect(calls.some((call) => call.startsWith("GET /api/memory"))).toBe(
        type === "office",
      );
      // The working folder field is in both (task e871e36f). An owner's
      // office pane also has the GitHub link's fields (task 7fc83592), which
      // save on their own.
      const ownFields = view
        .queryAllByRole("textbox")
        .filter((box) => !box.closest("[data-github-link]"));
      expect(ownFields.length).toBe(type === "office" ? 4 : 2);
      await act(async () =>
        fireEvent.click(view.getByRole("button", { name: "Save" })),
      );
      expect(calls).toContain(`PUT /api/rooms/${type}/instructions`);
      expect(calls).not.toContain(`PUT /api/rooms/${type}/settings`);
      expect(view.getByRole("button", { name: "Saved" })).toBeTruthy();
      view.unmount();
    });
  }
});
