// Save after a model change inside edit: the dialog sends the mode it shows
// for the selected family, so a stored Auto shown as Ask is not kept by
// omission on a family that has Auto.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { fireEvent } = await import("@testing-library/react");
const {
  CLOUD,
  claudeAgent,
  modeSelect,
  renameAndSave,
  renderEdit,
  selectWith,
  settle,
  shimRequests,
} = await import("../test-support/claude-limits-fixture.tsx");

describe("edit dialog save after a model change", () => {
  it("saves the Ask it shows when a stored Auto moves from haiku to opus", async () => {
    const patches = shimRequests();
    const { view } = renderEdit(claudeAgent("haiku", "auto", CLOUD), []);
    try {
      await settle();
      fireEvent.change(selectWith(view.container, "haiku"), {
        target: { value: "opus" },
      });
      await settle();
      expect(modeSelect(view.container).value).toBe("default");
      await renameAndSave(view.container);
      expect(patches).toEqual([
        { name: "Renamed", modelFamily: "opus", permissionMode: "default" },
      ]);
    } finally {
      view.unmount();
    }
  });

  // Moving between limited families keeps the stored Auto, which runs as
  // Ask there.
  it("keeps a stored Auto when it moves between limited families", async () => {
    const patches = shimRequests();
    const { view } = renderEdit(claudeAgent("haiku", "auto", CLOUD), []);
    try {
      await settle();
      fireEvent.change(selectWith(view.container, "haiku"), {
        target: { value: "sonnet" },
      });
      await settle();
      await renameAndSave(view.container);
      expect(patches).toEqual([{ name: "Renamed", modelFamily: "sonnet" }]);
    } finally {
      view.unmount();
    }
  });
});
