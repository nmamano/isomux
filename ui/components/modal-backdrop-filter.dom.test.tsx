// A modal blurs the page behind it once, on its overlay; nothing inside the
// overlay has a backdrop-filter of its own (task a09fa236). A blur nested in a
// blur, with a scroller inside, let macOS show the chat over the agent dialog
// for a frame while it scrolled.
import { afterAll, expect, it } from "bun:test";
import type { ReactElement } from "react";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { setApiShim } = await import("../api.ts");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { EditAgentDialog } = await import("./EditAgentDialog.tsx");
const { CronjobDialog } = await import("./CronjobDialog.tsx");
const { CronjobsPromptDialog } = await import("./CronjobsPromptDialog.tsx");
const { WebhookDialog } = await import("./WebhookDialog.tsx");
const { room } = await import("../test-support/claude-limits-fixture.tsx");
const { hookWire } = await import("../test-support/webhook-fixture.ts");

setApiShim(async () => ({}));
afterAll(() => setApiShim(null));

function blurs(el: HTMLElement): boolean {
  return el.style.backdropFilter !== "";
}

function expectOneBlurOnTheOverlay(element: ReactElement, state = {}) {
  const view = render(onLanguage("en", element, state));
  try {
    const overlay = view.container.firstElementChild as HTMLElement;
    // The overlay is the full-screen layer and keeps its blur.
    expect(overlay.style.position).toBe("fixed");
    expect(blurs(overlay)).toBe(true);
    const nested = [...overlay.querySelectorAll<HTMLElement>("[style]")].filter(
      blurs,
    );
    expect(nested.map((el) => el.getAttribute("style"))).toEqual([]);
  } finally {
    view.unmount();
  }
}

// The new-agent dialog; an agent's settings are a page, not a modal (task
// 59538509).
it("the new-agent dialog blurs only on its overlay", () => {
  expectOneBlurOnTheOverlay(
    <EditAgentDialog
      onClose={() => {}}
      deskIndex={0}
      roomId={room.id}
      defaultCwd="/srv/new-agent"
      spawnAgentType="claude"
    />,
    { rooms: [room], agents: [], hasReceivedInitialState: true },
  );
});

it("the schedule dialog blurs only on its overlay", () => {
  expectOneBlurOnTheOverlay(
    createElement(CronjobDialog, { onClose: () => {} }),
    { rooms: [], hasReceivedInitialState: true },
  );
});

it("the schedule instructions dialog blurs only on its overlay", () => {
  expectOneBlurOnTheOverlay(
    createElement(CronjobsPromptDialog, { onClose: () => {} }),
    { cronjobsPrompt: "Stored" },
  );
});

it("the webhook dialog blurs only on its overlay", () => {
  expectOneBlurOnTheOverlay(
    <WebhookDialog webhook={hookWire()} onClose={() => {}} />,
    { agents: [] },
  );
});
