import { it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { setupTaskShortcutTests, checkTaskShortcuts } =
  await import("./test-support/task-shortcuts-fixture.tsx");
setupTaskShortcutTests();

it("t opens Tasks with All rooms selected from Lobby", async () => {
  await checkTaskShortcuts(true);
});
