// Ordinary-to-embed room-door transition coverage split from
// room-door.dom.test.tsx.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const fixture = await import("./room-door-fixture.tsx");
const { mount, room, act, fullState } = fixture;
fixture.setupRoomDoorTests({ decorations: false });

it("hides room creation in embed, including after the last room disappears", async () => {
  const view = mount([room("first")]);
  await act(async () => {
    view.setEmbed(true);
    fullState([room("first")]);
  });
  expect(
    view.queryByRole("button", { hidden: true, name: "New room" }),
  ).toBeNull();
  await act(async () => fullState([]));
  expect(fixture.snapshot.lobbyOpen).toBe(true);
  expect(
    view.queryByRole("button", { hidden: true, name: "New room" }),
  ).toBeNull();
});
