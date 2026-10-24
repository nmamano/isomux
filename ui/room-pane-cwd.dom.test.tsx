// The room's working folder in Room settings (task e871e36f): the field shows
// the stored folder, a change rides the room PATCH as `cwd` alone, an emptied
// field clears it with null, and a refused folder stays in the field to save
// again. The server rules: server/test-support/routes-rooms-rest.test.ts.

import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { RoomPane } = await import("./components/RoomPane.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim, ApiError } = await import("./api.ts");
const { createElement } = await import("react");
type RoomWire = import("../shared/types.ts").RoomWire;

const calls: Array<{ method: string; path: string; body: unknown }> = [];
// The next PATCH fails with this error, once.
let failNextPatch: Error | null = null;
setApiShim(async (method, path, body) => {
  calls.push({ method, path, body });
  if (method === "PATCH" && failNextPatch) {
    const e = failNextPatch;
    failNextPatch = null;
    throw e;
  }
  if (path.endsWith("/settings")) return { prompt: "", version: "0" };
  if (path.endsWith("/instructions")) return { instructions: "", version: "0" };
  if (path.startsWith("/api/memory"))
    return { text: "", version: "0", size: 0, cap: 4000 };
  return {};
});
afterAll(() => setApiShim(null));

function mount(room: RoomWire) {
  return render(
    onLanguage(
      null,
      createElement(RoomPane, { roomId: room.id, onDeleted() {} }),
      { rooms: [room] },
    ),
  );
}

const patches = (id: string) =>
  calls.filter((c) => c.method === "PATCH" && c.path === `/api/rooms/${id}`);

const field = (view: ReturnType<typeof mount>) =>
  view.container.querySelector<HTMLInputElement>('[data-room-setting="cwd"]');

async function type(view: ReturnType<typeof mount>, value: string) {
  await act(async () => fireEvent.change(field(view)!, { target: { value } }));
}

async function save(view: ReturnType<typeof mount>) {
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: /^Save/ })),
  );
}

it("shows the folder, sends a change as cwd alone, clears with null, and keeps a refused folder to save again", async () => {
  calls.length = 0;
  const view = mount({
    id: "r1",
    name: "One",
    type: "office",
    prompt: null,
    canCloseWhenEmpty: true,
    cwd: "~/proj",
  });
  await act(async () => {});
  expect(field(view)?.value).toBe("~/proj");

  await type(view, "/srv/missing");
  failNextPatch = new ApiError(400, "invalid_cwd", "server says no");
  await save(view);
  expect(patches("r1").map((c) => c.body)).toEqual([{ cwd: "/srv/missing" }]);
  expect(view.container.textContent).toContain("server says no");
  expect(field(view)?.value).toBe("/srv/missing");

  await type(view, "/srv/proj");
  await save(view);
  expect(patches("r1")[1]?.body).toEqual({ cwd: "/srv/proj" });

  await type(view, "   ");
  await save(view);
  expect(patches("r1")[2]?.body).toEqual({ cwd: null });
  view.unmount();
});

it("a room with no folder shows an empty field, and the lobby has the field too", async () => {
  calls.length = 0;
  const office = mount({
    id: "r1",
    name: "One",
    type: "office",
    prompt: null,
    canCloseWhenEmpty: true,
  });
  await act(async () => {});
  expect(field(office)?.value).toBe("");
  office.unmount();

  const lobby = mount({
    id: "lobby",
    name: "Lobby",
    type: "lobby",
    prompt: null,
    canCloseWhenEmpty: false,
  });
  await act(async () => {});
  expect(field(lobby)?.value).toBe("");
  await type(lobby, "/srv/front-desk");
  await save(lobby);
  expect(patches("lobby").map((c) => c.body)).toEqual([
    { cwd: "/srv/front-desk" },
  ]);
  lobby.unmount();
});
