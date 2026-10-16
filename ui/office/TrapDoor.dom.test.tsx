// The trap door to the back room (tasks 5b503e32 and f0af4677): it is always
// there, what its light and lamp show, and what a dropped desk does.

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
    // No plank light and no text.
    expect(view.container.querySelector("[filter]")).toBeNull();
    expect(view.container.textContent).toBe("");
  });

  it("lights the planks while a back agent works", () => {
    const { view } = show({ attention: { ...NONE, agents: 1, working: 1 } });
    expect(view.container.querySelector("[filter]")).not.toBeNull();
  });

  // The lamp: red while any back agent is in error, else yellow while one
  // waits on a permission prompt, else green while one works, else off; no
  // count (Nil, task 7e325e1b).
  it("lights its lamp red, then yellow, then green, else off", () => {
    const lamp = (attention: typeof NONE) => {
      const { view } = show({ attention });
      const state = view.container
        .querySelector("[data-trap-door-lamp]")
        ?.getAttribute("data-trap-door-lamp");
      cleanup();
      return state;
    };
    expect(lamp(NONE)).toBe("off");
    expect(lamp({ ...NONE, agents: 3 })).toBe("off");
    expect(lamp({ ...NONE, agents: 1, working: 1 })).toBe("working");
    expect(lamp({ ...NONE, agents: 9, working: 7 })).toBe("working");
    expect(lamp({ ...NONE, agents: 2, error: 1 })).toBe("error");
    expect(lamp({ agents: 9, working: 7, asking: 1, error: 1 })).toBe("error");
    expect(lamp({ ...NONE, agents: 2, asking: 1 })).toBe("asking");
    expect(lamp({ ...NONE, agents: 9, working: 7, asking: 1 })).toBe("asking");
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

  it("shows no count chip for working, asking or failed back agents", () => {
    const { view } = show({
      attention: { agents: 5, working: 2, asking: 1, error: 1 },
    });
    expect(view.container.textContent).toBe("");
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
