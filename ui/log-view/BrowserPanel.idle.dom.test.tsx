import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { setShim, shimEmit } = await import("../ws.ts");
const { BrowserPanel } = await import("./BrowserPanel.tsx");
import type { ClientCommand } from "../../shared/types.ts";

afterAll(() =>
  setShim(
    () => {},
    () => {},
  ),
);

it("offers an explicit reopen after idle closure, including after remount", () => {
  const sent: ClientCommand[] = [];
  setShim((command) => sent.push(command));
  const url = "https://example.test/previous";
  for (let mount = 0; mount < 2; mount++) {
    const view = render(
      <BrowserPanel agentId="idle" canDrive onClose={() => {}} />,
    );
    act(() =>
      shimEmit({
        type: "browser_status",
        agentId: "idle",
        available: false,
        idleClosed: true,
        url,
        busy: false,
      }),
    );
    const go = () =>
      sent.filter(
        (c) =>
          c.type === "browser_input" &&
          c.input.kind === "navigate" &&
          c.input.action === "goto",
      );
    expect(go()).toHaveLength(mount);
    const address = view.container.querySelector("input")!;
    expect(address.value).toBe(url);
    expect(view.container.querySelector("canvas")!.style.display).toBe("none");
    // The empty-state action lives in the same viewport as the canvas.
    const reopen = view.container
      .querySelector("canvas")!
      .parentElement!.querySelector("button")!;
    expect(reopen).not.toBeNull();
    expect(reopen.parentElement!.textContent.length).toBeGreaterThan(0);
    fireEvent.click(reopen);
    expect(go().at(-1)).toMatchObject({
      type: "browser_input",
      agentId: "idle",
      input: { kind: "navigate", action: "goto", url },
    });
    act(() =>
      shimEmit({
        type: "browser_status",
        agentId: "idle",
        available: true,
        url,
        busy: false,
      }),
    );
    expect(
      view.container
        .querySelector("canvas")!
        .parentElement!.querySelector("button"),
    ).toBeNull();
    view.unmount();
  }
});
