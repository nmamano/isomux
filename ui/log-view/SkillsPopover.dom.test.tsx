import { afterAll, expect, it, mock } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render, fireEvent } = await import("@testing-library/react");
const { SkillsPopover } = await import("./SkillsPopover.tsx");
const { setApiShim } = await import("../api.ts");

// Keep usage loading pending: these tests cover menu interaction, and a late
// resolved fetch would schedule setCounts after a standalone test has ended.
setApiShim(() => new Promise(() => {}));
afterAll(() => setApiShim(null));

it("keeps composer focus and picks from the draft-controlled full menu", () => {
  const onPick = mock(() => {});
  const onClose = mock(() => {});
  const view = render(
    <div>
      <textarea autoFocus defaultValue="/" />
      <SkillsPopover
        skills={[
          { name: "verify", origin: "user" },
          { name: "write", origin: "project" },
        ]}
        commands={[{ name: "clear", autoRun: true }]}
        isMobile={false}
        draftFilter=""
        onPick={onPick}
        onClose={onClose}
      />
    </div>,
  );
  expect(view.container.querySelector("input") === null).toBe(true);
  expect(document.activeElement?.tagName).toBe("TEXTAREA");
  expect(view.getByText("Commands") !== null).toBe(true);
  expect(view.getByText("Project") !== null).toBe(true);

  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  expect(onPick).toHaveBeenCalledWith("verify", undefined);
});

it("closes on Escape and lets Enter send an unmatched slash draft", () => {
  const onPick = mock(() => {});
  const onClose = mock(() => {});
  render(
    <SkillsPopover
      skills={[]}
      commands={[]}
      isMobile={false}
      draftFilter="unknown"
      onPick={onPick}
      onClose={onClose}
    />,
  );
  const enter = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(enter);
  expect(enter.defaultPrevented).toBe(false);
  expect(onPick).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});

it("keeps keyboard selection in the Sk button filter path", () => {
  const onPick = mock(() => {});
  const view = render(
    <SkillsPopover
      skills={[{ name: "verify", origin: "user" }]}
      commands={[{ name: "restore", autoRun: true }]}
      isMobile={false}
      onPick={onPick}
      onClose={() => {}}
    />,
  );
  const filter = view.container.querySelector("input")!;
  expect(document.activeElement).toBe(filter);
  fireEvent.change(filter, { target: { value: "verify" } });
  fireEvent.keyDown(filter, { key: "Enter" });
  expect(onPick).toHaveBeenCalledWith("verify", undefined);
});

it("selects an exact name even when it is in a later group", () => {
  const onPick = mock(() => {});
  render(
    <SkillsPopover
      skills={[{ name: "re", origin: "user" }]}
      commands={[{ name: "restore", autoRun: true }]}
      isMobile={false}
      draftFilter="re"
      onPick={onPick}
      onClose={() => {}}
    />,
  );
  fireEvent.keyDown(document.body, { key: "Enter" });
  expect(onPick).toHaveBeenCalledWith("re", undefined);
});
