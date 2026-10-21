// The room switch animation choice in Settings > Device (task ada9af7b): it
// shows the stored choice, offers off and the two turn times, and applies on
// change, with no Save.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { render, fireEvent } = await import("@testing-library/react");
const { DevicePane } = await import("./DevicePane.tsx");
const { getRoomTurn, setRoomTurn } = await import("../device-settings.ts");

it("shows the stored choice, lists the three choices and stores a change at once", () => {
  localStorage.clear();
  setRoomTurn("turn-600");
  const view = render(<DevicePane />);
  // The one select whose options are the room turn choices.
  const select = view.container
    .querySelector('select option[value="turn-350"]')
    ?.closest("select");
  expect(select).toBeInstanceOf(HTMLSelectElement);
  if (!select) return;
  expect(select.value).toBe("turn-600");
  expect([...select.options].map((o) => o.value)).toEqual([
    "off",
    "turn-350",
    "turn-600",
  ]);
  // Each choice has its own visible name.
  const names = [...select.options].map((o) => o.textContent?.trim() ?? "");
  expect(names.every((n) => n.length > 0)).toBe(true);
  expect(new Set(names).size).toBe(3);
  fireEvent.change(select, { target: { value: "turn-350" } });
  expect(getRoomTurn()).toBe("turn-350");
  expect(select.value).toBe("turn-350");
  fireEvent.change(select, { target: { value: "off" } });
  expect(getRoomTurn()).toBe("off");
  expect(select.value).toBe("off");
  view.unmount();
  localStorage.clear();
});
