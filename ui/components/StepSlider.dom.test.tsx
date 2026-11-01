// The step bar's keys (task 8c60be00): arrows, Home and End skip a disabled
// step wherever it sits in the row, and focus follows the checked step. The
// access slider's own use of it is in EditAgentDialog.access-slider.dom.test.tsx.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { useState } = await import("react");
const { StepSlider } = await import("./StepSlider.tsx");

const STEPS = ["chat", "office", "folder", "web", "standard", "privileged"];

function Slider({ start }: { start: string }) {
  const [value, setValue] = useState(start);
  return (
    <StepSlider
      steps={STEPS}
      value={value}
      onChange={setValue}
      stepLabel={(step) => step}
      ariaLabel="steps"
      attr="data-step"
      stepDisabled={(step) => step === "folder" || step === "web"}
    />
  );
}

function stepOf(el: Element | null): string {
  return el?.getAttribute("data-step") ?? "";
}

function checked(container: HTMLElement): string[] {
  return [
    ...container.querySelectorAll('[role="radio"][aria-checked="true"]'),
  ].map(stepOf);
}

describe("StepSlider", () => {
  it("arrows, Home and End skip disabled steps in the middle of the row, and focus follows the checked step", async () => {
    const view = render(<Slider start="office" />);
    const { container } = view;
    // The disabled steps the keys must skip.
    expect(
      [...container.querySelectorAll('[role="radio"][data-disabled]')].map(
        stepOf,
      ),
    ).toEqual(["folder", "web"]);
    container
      .querySelector<HTMLButtonElement>('[role="radio"][data-step="office"]')!
      .focus();
    const seen: Array<[string, string[], string]> = [];
    for (const k of [
      "ArrowRight",
      "ArrowLeft",
      "ArrowDown",
      "ArrowLeft",
      "End",
      "ArrowDown",
      "Home",
      "ArrowUp",
      "ArrowUp",
    ]) {
      await act(async () => {
        fireEvent.keyDown(document.activeElement!, { key: k });
      });
      seen.push([k, checked(container), stepOf(document.activeElement)]);
    }
    expect(seen).toEqual([
      // Over folder and web to standard, and back.
      ["ArrowRight", ["standard"], "standard"],
      ["ArrowLeft", ["office"], "office"],
      ["ArrowDown", ["chat"], "chat"],
      // Already at the first step.
      ["ArrowLeft", ["chat"], "chat"],
      ["End", ["privileged"], "privileged"],
      ["ArrowDown", ["standard"], "standard"],
      ["Home", ["chat"], "chat"],
      ["ArrowUp", ["office"], "office"],
      ["ArrowUp", ["standard"], "standard"],
    ]);
  });
});
