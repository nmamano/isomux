import { it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { setupTaskShortcutTests, checkTaskShortcuts } =
  await import("./test-support/task-shortcuts-fixture.tsx");
setupTaskShortcutTests();

it("t, a and s open pages; t selects the selected room from its tab", async () => {
  await checkTaskShortcuts(false);
});
