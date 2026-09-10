import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { boot, rooms, setupLandingTests, loadSavedView } =
  await import("./test-support/lobby-landing-fixture.tsx");
setupLandingTests();

for (const visibleRooms of [[], rooms]) {
  it(`lands on Lobby without a saved view with ${visibleRooms.length} room grants`, async () => {
    expect(loadSavedView("member")).toBeNull();
    const view = await boot(visibleRooms, { decorations: false });
    expect(view.getByText("Members chat", { exact: false })).toBeDefined();
    expect(document.title).toBe("Test Office | Isomux");
    expect(loadSavedView("member")?.lobby).toBe(true);
  });
}
