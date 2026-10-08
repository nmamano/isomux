import { expect, test } from "bun:test";
import { CLICK_REASON, clickNotPerformedReason } from "./browser-input";

// Call logs as Playwright 1.62.1 reports them for a click that timed out
// before it dispatched input (recorded 2026-10-08 against real Chrome).
const log = (...lines: string[]) =>
  ["TimeoutError: click: Timeout 3500ms exceeded.", "Call log:", ...lines].join(
    "\n",
  );
const resolved = [
  "  - waiting for locator('#x')",
  '    - locator resolved to <button id="x">X</button>',
  "  - attempting click action",
  "    2 × waiting for element to be visible, enabled and stable",
];

test("a click that never became clickable names the last state it saw", () => {
  expect(clickNotPerformedReason(log("  - waiting for locator('#x')"))).toBe(
    CLICK_REASON.missing,
  );
  expect(
    clickNotPerformedReason(log(...resolved, "      - element is not visible")),
  ).toBe(CLICK_REASON.hidden);
  expect(
    clickNotPerformedReason(log(...resolved, "      - element is not enabled")),
  ).toBe(CLICK_REASON.disabled);
  expect(
    clickNotPerformedReason(
      log(
        ...resolved,
        "      - element is visible, enabled and stable",
        "      - scrolling into view if needed",
        "      - done scrolling",
        "      - <div></div> intercepts pointer events",
      ),
    ),
  ).toBe(CLICK_REASON.covered);
  expect(
    clickNotPerformedReason(log(...resolved, "      - element is not stable")),
  ).toBe(CLICK_REASON.moving);
  expect(
    clickNotPerformedReason(
      log(...resolved, "      - element is outside of the viewport"),
    ),
  ).toBe(CLICK_REASON.outside);
  // The latest retry wins over an earlier state.
  expect(
    clickNotPerformedReason(
      log(
        ...resolved,
        "      - element is not visible",
        "    - retrying click action",
        "      - element is not enabled",
      ),
    ),
  ).toBe(CLICK_REASON.disabled);
  // An unknown or cut log gives the generic reason, never log text.
  for (const message of [log(...resolved), "TimeoutError", ""])
    expect(clickNotPerformedReason(message)).toBe(CLICK_REASON.unknown);
});

test("a colored call log gives the same reasons as a plain one", () => {
  // Playwright wraps each call-log line in dim escapes when color is allowed
  // (shape captured 2026-10-08 from a real run).
  const dim = (line: string) => "\u001b[2m" + line + "\u001b[22m";
  const colored = (...lines: string[]) =>
    [
      "TimeoutError: click: Timeout 3500ms exceeded.",
      "Call log:",
      ...lines.map(dim),
    ].join("\n");
  expect(
    clickNotPerformedReason(
      colored(
        ...resolved,
        "      - element is visible, enabled and stable",
        "      - <span></span> intercepts pointer events",
      ),
    ),
  ).toBe(CLICK_REASON.covered);
  expect(
    clickNotPerformedReason(colored("  - waiting for locator('#x')")),
  ).toBe(CLICK_REASON.missing);
  expect(
    clickNotPerformedReason(
      colored(...resolved, "      - element is not enabled"),
    ),
  ).toBe(CLICK_REASON.disabled);
  expect(clickNotPerformedReason(colored(...resolved))).toBe(
    CLICK_REASON.unknown,
  );
});
