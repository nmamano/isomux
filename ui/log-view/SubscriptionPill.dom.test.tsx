// The usage pill names the limit its number belongs to (task e96d2cff): the
// tracked window's shortLabel shows on the pill itself, so a member does not
// open the popover to learn which window the percent is from. The tag is
// backend data (shortLabel), so these assertions take it from the fixture.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render, within } = await import("@testing-library/react");
const { createElement } = await import("react");
const { SubscriptionPill } = await import("./SubscriptionPill.tsx");
const { setUsagePin } = await import("../device-settings.ts");
type SubscriptionUsageWire =
  import("../../shared/types.ts").SubscriptionUsageWire;

// Two windows whose tags are not substrings of each other, with the server's
// pick on the second one.
const USAGE: SubscriptionUsageWire = {
  plan: "max",
  windows: [
    { label: "Weekly", shortLabel: "WK", usedPercent: 30, resetsAtMs: null },
    { label: "5-hour", shortLabel: "5h", usedPercent: 80, resetsAtMs: null },
  ],
  primaryIndex: 1,
  sampledAtMs: 1_785_000_000_000,
  observedAtMs: 1_785_000_000_000,
};
const [WEEKLY, FIVE_HOUR] = USAGE.windows;

let agents = 0;
function pill(usage: SubscriptionUsageWire | null, agentId?: string) {
  const view = render(
    createElement(SubscriptionPill, {
      usage,
      agentId: agentId ?? `pill-agent-${++agents}`,
      provider: "claude",
    }),
  );
  return within(view.container).getByTestId("subscription-pill");
}

function withTag(index: number, shortLabel: string | null | undefined) {
  const windows = USAGE.windows.map((w, i) => {
    if (i !== index) return w;
    const { shortLabel: _drop, ...rest } = w;
    return shortLabel === undefined ? rest : { ...rest, shortLabel };
  });
  return { ...USAGE, windows };
}

describe("SubscriptionPill window tag", () => {
  it("shows the tag of the window the server picked, and not the other one", () => {
    const text = pill(USAGE).textContent ?? "";
    expect({
      tracked: text.includes(FIVE_HOUR.shortLabel!),
      other: text.includes(WEEKLY.shortLabel!),
    }).toEqual({ tracked: true, other: false });
  });

  it("follows a pin to the pinned window's tag", () => {
    const agentId = "pill-agent-pinned";
    setUsagePin(agentId, "claude", { label: WEEKLY.label, index: 0 });
    try {
      const text = pill(USAGE, agentId).textContent ?? "";
      expect({
        tracked: text.includes(WEEKLY.shortLabel!),
        other: text.includes(FIVE_HOUR.shortLabel!),
      }).toEqual({ tracked: true, other: false });
    } finally {
      setUsagePin(agentId, "claude", null);
    }
  });

  // No tag is the pill as it was before tags: the same text minus the tag,
  // and the same accessible name with or without one.
  it("shows no tag when the tracked window has a null or missing shortLabel", () => {
    const tagged = pill(USAGE);
    const taggedText = tagged.textContent ?? "";
    const taggedName = tagged.getAttribute("aria-label");
    const nullTag = pill(withTag(1, null));
    // A server from before the field sends none (the UI build goes live
    // before the restart that sends it).
    const missing = pill(withTag(1, undefined));
    expect({
      enabled: taggedText.includes(FIVE_HOUR.shortLabel!),
      nullText: nullTag.textContent,
      missingText: missing.textContent,
      nullName: nullTag.getAttribute("aria-label"),
      missingName: missing.getAttribute("aria-label"),
    }).toEqual({
      enabled: true,
      nullText: taggedText.replace(FIVE_HOUR.shortLabel!, ""),
      missingText: taggedText.replace(FIVE_HOUR.shortLabel!, ""),
      nullName: taggedName,
      missingName: taggedName,
    });
  });
});
