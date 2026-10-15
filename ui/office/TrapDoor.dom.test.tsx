// The trap door to the back room (task 5b503e32): when it shows, what its
// badges count, and what a dropped desk does.

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
const NONE = { agents: 0, working: 0, unread: 0, asking: 0, error: 0 };

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
        frontFull={false}
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
  it("is hidden with an empty back room and a free front desk", () => {
    expect(show().hatch()).toBeNull();
  });

  it("shows when the back room has agents, or the front is full", () => {
    expect(show({ attention: { ...NONE, agents: 1 } }).hatch()).not.toBeNull();
    cleanup();
    expect(show({ frontFull: true }).hatch()).not.toBeNull();
  });

  it("shows while a desk is dragged, as the drop target", () => {
    const { hatch } = show();
    expect(hatch()).toBeNull();
    act(() => {
      setDraggedDesk(3);
      document.dispatchEvent(new Event("dragstart"));
    });
    expect(hatch()).not.toBeNull();
    act(() => {
      setDraggedDesk(null);
      document.dispatchEvent(new Event("dragend"));
    });
    expect(hatch()).toBeNull();
  });

  it("counts unread, asking and error back agents, and hides a zero", () => {
    const { view } = show({
      attention: { agents: 5, working: 2, unread: 2, asking: 1, error: 1 },
    });
    const text = view.container.textContent ?? "";
    expect(text).toContain(EN.t("office.backRoom.unread", { count: 2 }));
    expect(text).toContain(EN.t("office.backRoom.asking", { count: 1 }));
    expect(text).toContain(EN.t("office.backRoom.error", { count: 1 }));
    cleanup();
    const quiet = show({
      attention: { agents: 5, working: 2, unread: 0, asking: 1, error: 0 },
    });
    const rest = quiet.view.container.textContent ?? "";
    expect(rest).not.toContain(EN.t("office.backRoom.unread", { count: 0 }));
    expect(rest).not.toContain(EN.t("office.backRoom.error", { count: 0 }));
  });

  it("moves a dropped desk to the back room, unless the back room is full", () => {
    const dropped: number[] = [];
    const drop = (hatch: Element) =>
      fireEvent.drop(hatch, {
        dataTransfer: { getData: () => "4", dropEffect: "move" },
      });
    const open = show({ frontFull: true }, dropped);
    drop(open.hatch()!);
    expect(dropped).toEqual([4]);
    cleanup();
    const full = show({ frontFull: true, backFull: true }, dropped);
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
