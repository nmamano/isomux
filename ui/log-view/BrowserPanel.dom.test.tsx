import { afterAll, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { setShim, shimEmit } = await import("../ws.ts");
const { BrowserPanel } = await import("./BrowserPanel.tsx");
import type { ClientCommand } from "../../shared/types.ts";

afterAll(() => setShim(() => {}, () => {}));

describe("BrowserPanel", () => {
  it("subscribes, paints frames, and forwards pointer and keyboard input", () => {
    const sent: ClientCommand[] = [];
    setShim((command) => sent.push(command), () => {});
    const view = render(<BrowserPanel agentId="agent-1" onClose={() => {}} />);
    expect(sent[0]).toEqual({ type: "browser_watch", agentId: "agent-1", watching: true });
    expect(view.getByText("Waiting for the agent to open a page") !== null).toBe(true);

    act(() => {
      shimEmit({ type: "browser_frame", agentId: "agent-1", data: "jpeg", width: 800, height: 600 });
    });
    const surface = view.getByRole("application");
    Object.defineProperty(surface, "getBoundingClientRect", {
      value: () => ({ left: 10, top: 20, width: 400, height: 300, right: 410, bottom: 320, x: 10, y: 20, toJSON() {} }),
    });
    fireEvent.mouseDown(surface, { clientX: 210, clientY: 170 });
    fireEvent.keyDown(surface, { key: "a", code: "KeyA" });

    expect(sent.some((command) => command.type === "browser_input" && command.input.kind === "mouse" && command.input.x === 400 && command.input.y === 300)).toBe(true);
    expect(sent.some((command) => command.type === "browser_input" && command.input.kind === "key" && command.input.text === "a")).toBe(true);
    view.unmount();
    expect(sent.at(-1)).toEqual({ type: "browser_watch", agentId: "agent-1", watching: false });
  });
});
