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
  for (const [from, to, sent] of [
    ["haiku", "opus", { permissionMode: "default" }],
    ["sonnet", "fable", { permissionMode: "default" }],
    ["haiku", "sonnet", {}],
  ] as const) {
    it(`saves the Ask it shows when a stored Auto moves from ${from} to ${to}`, async () => {
      const patches = shimRequests();
      const { view } = renderEdit(claudeAgent(from, "auto", CLOUD), []);
      try {
        await settle();
        expect(modeSelect(view.container).value).toBe("default");
        fireEvent.change(selectWith(view.container, "haiku"), {
          target: { value: to },
        });
        await settle();
        expect(modeSelect(view.container).value).toBe("default");
        await renameAndSave(view.container);
        expect(patches).toHaveLength(1);
        expect(patches[0]).toMatchObject({ modelFamily: to, ...sent });
        // Moving between limited families keeps the stored Auto, which runs
        // as default there.
        if (!("permissionMode" in sent))
          expect(patches[0]).not.toHaveProperty("permissionMode");
      } finally {
        view.unmount();
      }
    });
  }

  it("keeps a picked Auto when a stored Auto moves to a family with Auto", async () => {
    const patches = shimRequests();
    const { view } = renderEdit(claudeAgent("haiku", "auto", CLOUD), []);
    try {
      await settle();
      fireEvent.change(selectWith(view.container, "haiku"), {
        target: { value: "opus" },
      });
      await settle();
      fireEvent.change(modeSelect(view.container), {
        target: { value: "auto" },
      });
      await settle();
      await renameAndSave(view.container);
      expect(patches).toHaveLength(1);
      expect(patches[0]).toMatchObject({ modelFamily: "opus" });
      expect(patches[0]).not.toHaveProperty("permissionMode");
    } finally {
      view.unmount();
    }
  });

});
