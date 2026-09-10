import { it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { setupTaskShortcutTests, checkTaskShortcuts } =
  await import("./test-support/task-shortcuts-fixture.tsx");
setupTaskShortcutTests();

it("t selects the room and switches back to Tasks from Apps", async () => {
  await checkTaskShortcuts(false);
});
