// The edit dialog gates effort and Auto on the edited agent's own
// limitedClaudeFamilies (its manager's env), not on the viewer's, in both
// directions. Spawn reads the viewer's SessionContext list.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { fireEvent, render } = await import("@testing-library/react");
const { EditAgentDialog } = await import("./EditAgentDialog.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { familyPickerLabel } = await import("../../shared/types.ts");
const {
  CLOUD,
  claudeAgent,
  hasEffort,
  modeSelect,
  offersAuto,
  renameAndSave,
  renderEdit,
  room,
  selectWith,
  settle,
  shimRequests,
  viewer,
} = await import("../test-support/claude-limits-fixture.tsx");

describe("edit dialog on another member's agent", () => {
  it("shows a first-party viewer the Ask a cloud haiku agent runs with, and keeps its stored Auto on an unrelated save", async () => {
    const patches = shimRequests();
    const { view } = renderEdit(claudeAgent("haiku", "auto", CLOUD), []);
    try {
      await settle();
      expect(modeSelect(view.container).value).toBe("default");
      expect(offersAuto(view.container)).toBe(false);
      expect(hasEffort(view.container)).toBe(false);
      await renameAndSave(view.container);
      expect(patches).toHaveLength(1);
      expect(patches[0]).toMatchObject({ name: "Renamed" });
      expect(patches[0]).not.toHaveProperty("permissionMode");
    } finally {
      view.unmount();
    }
  });

  it("offers a cloud viewer Auto and effort on a first-party haiku agent, and keeps its Auto on an unrelated save", async () => {
    const patches = shimRequests();
    const { view } = renderEdit(claudeAgent("haiku", "auto", []), CLOUD);
    try {
      await settle();
      expect(modeSelect(view.container).value).toBe("auto");
      expect(offersAuto(view.container)).toBe(true);
      expect(hasEffort(view.container)).toBe(true);
      await renameAndSave(view.container);
      expect(patches).toHaveLength(1);
      expect(patches[0]).not.toHaveProperty("permissionMode");
    } finally {
      view.unmount();
    }
  });

  it("follows the selected model inside edit", async () => {
    shimRequests();
    const { view } = renderEdit(claudeAgent("opus", "auto", CLOUD), []);
    try {
      await settle();
      expect(modeSelect(view.container).value).toBe("auto");
      const model = selectWith(view.container, "haiku");
      fireEvent.change(model, { target: { value: "sonnet" } });
      await settle();
      expect(modeSelect(view.container).value).toBe("default");
      expect(offersAuto(view.container)).toBe(false);
      expect(hasEffort(view.container)).toBe(false);
      fireEvent.change(model, { target: { value: "fable" } });
      await settle();
      expect(offersAuto(view.container)).toBe(true);
      expect(hasEffort(view.container)).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it("follows a limits change the server sends while the dialog is open", async () => {
    shimRequests();
    const agent = claudeAgent("haiku", "auto", []);
    const { view, rerender } = renderEdit(agent, []);
    try {
      await settle();
      expect(modeSelect(view.container).value).toBe("auto");
      rerender({ ...agent, limitedClaudeFamilies: CLOUD });
      await settle();
      expect(modeSelect(view.container).value).toBe("default");
      expect(offersAuto(view.container)).toBe(false);
      rerender({ ...agent, limitedClaudeFamilies: [] });
      await settle();
      expect(modeSelect(view.container).value).toBe("auto");
    } finally {
      view.unmount();
    }
  });
});

// The model picker names the version each family runs: the edited agent's
// claudeFamilyModels at edit, the viewer's at spawn.
describe("model picker labels", () => {
  const optionText = (container: HTMLElement, family: string) =>
    [...selectWith(container, "haiku").options].find((o) => o.value === family)!
      .text;
  const cloudModels = {
    sonnet: "us.anthropic.claude-sonnet-4-6",
    haiku: "claude-haiku-4-5",
  };

  it("reads the edited agent's models, not the viewer's", async () => {
    shimRequests();
    const { view } = renderEdit(
      { ...claudeAgent("opus", "auto", CLOUD), claudeFamilyModels: cloudModels },
      [],
    );
    try {
      await settle();
      for (const family of ["sonnet", "haiku"] as const) {
        expect(optionText(view.container, family)).toBe(
          familyPickerLabel(family, cloudModels),
        );
        expect(optionText(view.container, family)).not.toBe(
          familyPickerLabel(family),
        );
      }
      expect(optionText(view.container, "opus")).toBe(
        familyPickerLabel("opus"),
      );
    } finally {
      view.unmount();
    }
  });

  it("reads the viewer's models at spawn", async () => {
    shimRequests();
    const view = render(
      onLanguage(
        "en",
        <EditAgentDialog
          onClose={() => {}}
          deskIndex={0}
          roomId={room.id}
          defaultCwd="~"
          spawnAgentType="claude"
        />,
        {
          rooms: [room],
          agents: [],
          hasReceivedInitialState: true,
          sessionContext: { ...viewer(CLOUD), claudeFamilyModels: cloudModels },
        },
      ),
    );
    try {
      await settle();
      expect(optionText(view.container, "haiku")).toBe(
        familyPickerLabel("haiku", cloudModels),
      );
    } finally {
      view.unmount();
    }
  });
});

describe("spawn dialog", () => {
  it("reads the viewer's own list", async () => {
    shimRequests();
    const element = (limited: string[]) =>
      onLanguage(
        "en",
        <EditAgentDialog
          onClose={() => {}}
          deskIndex={0}
          roomId={room.id}
          defaultCwd="~"
          spawnAgentType="claude"
        />,
        {
          rooms: [room],
          agents: [],
          hasReceivedInitialState: true,
          sessionContext: viewer(limited),
        },
      );
    const view = render(element(CLOUD));
    try {
      await settle();
      fireEvent.change(selectWith(view.container, "haiku"), {
        target: { value: "haiku" },
      });
      await settle();
      expect(offersAuto(view.container)).toBe(false);
      expect(hasEffort(view.container)).toBe(false);
      view.rerender(element([]));
      await settle();
      expect(offersAuto(view.container)).toBe(true);
      expect(hasEffort(view.container)).toBe(true);
    } finally {
      view.unmount();
    }
  });
});
