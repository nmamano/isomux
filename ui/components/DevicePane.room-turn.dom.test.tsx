// The room switch animation choice in Settings > Device (task fee198a0): it
// shows the stored choice and applies on change, with no Save.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { render, fireEvent } = await import("@testing-library/react");
const { DevicePane } = await import("./DevicePane.tsx");
const { getRoomTurn, setRoomTurn } = await import("../device-settings.ts");

it("shows the stored choice and stores a new one at once", () => {
  localStorage.clear();
  setRoomTurn("cube-600");
  const view = render(<DevicePane />);
  // The one select whose options are the five choices.
  const select = view.container
    .querySelector('select option[value="turn-350"]')
    ?.closest("select");
  expect(select).toBeInstanceOf(HTMLSelectElement);
  if (!select) return;
  expect(select.value).toBe("cube-600");
  expect([...select.options].map((o) => o.value).sort()).toEqual([
    "cube-350",
    "cube-600",
    "off",
    "turn-350",
    "turn-600",
  ]);
  fireEvent.change(select, { target: { value: "turn-350" } });
  expect(getRoomTurn()).toBe("turn-350");
  fireEvent.change(select, { target: { value: "off" } });
  expect(getRoomTurn()).toBe("off");
  view.unmount();
});
