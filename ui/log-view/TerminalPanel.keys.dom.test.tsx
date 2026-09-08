import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { render, fireEvent } = await import("@testing-library/react");
const { TerminalPanel } = await import("./TerminalPanel.tsx");
const { setShim } = await import("../ws.ts");
afterAll(() => setShim(() => {}));

it("mobile arrow keycaps keep their names and send the same terminal input", () => {
  const sent: import("../../shared/types.ts").ClientCommand[] = [];
  setShim(
    (cmd) => sent.push(cmd),
    () => {},
  );
  const view = render(
    <TerminalPanel agentId="fixture" mobile onClose={() => {}} />,
  );
  for (const [name, data, rotation] of [
    ["▲", "\x1b[A", "rotate(-90deg)"],
    ["▼", "\x1b[B", "rotate(90deg)"],
    ["◀", "\x1b[D", "rotate(180deg)"],
    ["▶", "\x1b[C", "rotate(0deg)"],
  ]) {
    const key = view.getByRole("button", { name });
    expect(key.querySelector("svg") !== null).toBe(true);
    expect(key.querySelector("svg")?.style.transform).toBe(rotation);
    expect(key.textContent).toBe("");
    fireEvent.click(key);
    expect(sent.at(-1)).toEqual({
      type: "terminal_input",
      agentId: "fixture",
      data,
    });
  }
});
