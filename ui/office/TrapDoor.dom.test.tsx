// The trap door to the back room (tasks 5b503e32 and f0af4677): it is always
// there, what its light and badges show, and what a dropped desk does.

import { afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, cleanup, render, fireEvent } =
  await import("@testing-library/react");
const { TrapDoor } = await import("./TrapDoor.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setDraggedDesk } = await import("./drag-state.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");

const EN = translatorFor("en");
const NONE = { agents: 0, working: 0, asking: 0, error: 0 };

afterEach(() => {
  cleanup();
  setDraggedDesk(null);
});

function show(
  props: Partial<Parameters<typeof TrapDoor>[0]> = {},
  dropped: number[] = [],
) {
  const view = render(
    onLanguage(
      "en",
      <TrapDoor
        attention={NONE}
        backFull={false}
        onOpen={() => {}}
        onDropDesk={(desk) => dropped.push(desk)}
        {...props}
      />,
    ),
  );
  const hatch = () => view.container.querySelector("[data-trap-door]");
  return { view, hatch };
}

describe("TrapDoor", () => {
  it("shows with an empty back room, closed and quiet", () => {
    const { view, hatch } = show();
    expect(hatch()).not.toBeNull();
    // No plank light and no badges.
    expect(view.container.querySelector("[filter]")).toBeNull();
    expect(view.container.textContent).toBe("");
  });

  it("lights the planks while a back agent works", () => {
    const { view } = show({ attention: { ...NONE, agents: 1, working: 1 } });
    expect(view.container.querySelector("[filter]")).not.toBeNull();
  });

  it("marks itself as the drop target while a desk is dragged", () => {
    const { view } = show();
    act(() => {
      setDraggedDesk(3);
      document.dispatchEvent(new Event("dragstart"));
    });
    expect(view.container.textContent).toContain(
      EN.t("office.backRoom.dropBadge"),
    );
    act(() => {
      setDraggedDesk(null);
      document.dispatchEvent(new Event("dragend"));
    });
    expect(view.container.textContent).toBe("");
  });

  it("counts asking and error back agents, and hides a zero", () => {
    const { view } = show({
      attention: { agents: 5, working: 2, asking: 1, error: 1 },
    });
    const text = view.container.textContent ?? "";
    expect(text).toContain(EN.t("office.backRoom.asking", { count: 1 }));
    expect(text).toContain(EN.t("office.backRoom.error", { count: 1 }));
    cleanup();
    const quiet = show({
      attention: { agents: 5, working: 2, asking: 1, error: 0 },
    });
    const rest = quiet.view.container.textContent ?? "";
    expect(rest).not.toContain(EN.t("office.backRoom.error", { count: 0 }));
  });

  it("moves a dropped desk to the back room, unless the back room is full", () => {
    const dropped: number[] = [];
    const drop = (hatch: Element) =>
      fireEvent.drop(hatch, {
        dataTransfer: { getData: () => "4", dropEffect: "move" },
      });
    const open = show({}, dropped);
    drop(open.hatch()!);
    expect(dropped).toEqual([4]);
    cleanup();
    const full = show({ backFull: true }, dropped);
    drop(full.hatch()!);
    expect(dropped).toEqual([4]);
  });

  it("opens the back room on click", () => {
    let opened = 0;
    const { hatch } = show({
      attention: { ...NONE, agents: 1 },
      onOpen: () => opened++,
    });
    fireEvent.click(hatch()!);
    expect(opened).toBe(1);
  });
});
