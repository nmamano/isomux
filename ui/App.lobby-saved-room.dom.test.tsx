import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { boot, rooms, setupLandingTests, loadSavedView, saveView } =
  await import("./test-support/lobby-landing-fixture.tsx");
setupLandingTests();

it("restores the saved room instead of opening Lobby", async () => {
  saveView("member", {
    roomId: "r2",
    agentId: null,
    panel: null,
    lobby: false,
  });
  const view = await boot(rooms, { decorations: false, stageHydration: true });
  expect(view.queryByText("Members chat", { exact: false })).toBeNull();
  expect(document.title).toBe("Saved room | Isomux");
  expect(loadSavedView("member")?.roomId).toBe("r2");
  expect(loadSavedView("member")?.lobby).toBe(false);
});
