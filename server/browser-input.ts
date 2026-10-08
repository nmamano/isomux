import type { Frame, Locator, Page, Request } from "playwright-core";

// A navigation that a click starts shows as a request within this window.
export const SETTLE_QUIET_MS = 300;

// The call log of a timed-out Playwright click names the last actionability
// state it saw. Only these fixed strings leave this module; the log never does.
export const CLICK_REASON = {
  hidden: "the element is not visible",
  disabled: "the element is disabled",
  covered: "another element covers it",
  moving: "the element does not stop moving",
  outside: "the element is outside the viewport",
  missing: "no element matches the selector",
  unknown: "the element did not become clickable before the deadline",
} as const;
const CLICK_LOG: [RegExp, string][] = [
  [/^\s*- element is not visible$/, CLICK_REASON.hidden],
  [/^\s*- element is not enabled$/, CLICK_REASON.disabled],
  [/ intercepts pointer events$/, CLICK_REASON.covered],
  [/^\s*- element is not stable$/, CLICK_REASON.moving],
  [/^\s*- element is outside of the viewport$/, CLICK_REASON.outside],
];

// Playwright colors its call log when the process allows color.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;

/** The reason a click never became clickable, for a known no-op. */
export function clickNotPerformedReason(message: string): string {
  const lines = message.replace(ANSI_ESCAPE, "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const found = CLICK_LOG.find(([pattern]) => pattern.test(lines[i]));
    if (found) return found[1];
  }
  if (
    lines.some((line) => /^\s*- waiting for /.test(line)) &&
    !lines.some((line) => /^\s*- locator resolved to /.test(line))
  )
    return CLICK_REASON.missing;
  return CLICK_REASON.unknown;
}

export const SELECT_REASON = {
  missing: CLICK_REASON.missing,
  disabled: "the select is disabled",
  noOption: "no option matches that value or label",
  optionDisabled: "the first matching option is disabled",
} as const;

// option.text in Chrome: ASCII whitespace stripped and collapsed.
const optionText = (text: string) =>
  text
    .replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "")
    .replace(/[\t\n\f\r ]+/g, " ");
// Playwright's normalizeWhiteSpace, which its label match uses.
const normalizeWhiteSpace = (text: string) =>
  text
    .replace(/[\u200b\u00ad]/g, "")
    .trim()
    .replace(/\s+/g, " ");

/**
 * The option that Playwright's selectOption picks for this value or label:
 * the first match in document order. Utility-world reads only. The candidate
 * locator holds every match (it can hold more), in document order.
 * "inconclusive": the first candidate that needs its text has a script
 * descendant, which Chrome leaves out of option.text and textContent keeps;
 * selectOption then decides.
 */
export async function firstMatchingOption(
  select: Locator,
  wanted: { value: string } | { label: string },
  timeout: () => number,
): Promise<Locator | "inconclusive" | undefined> {
  const byValue = "value" in wanted;
  const candidates = byValue
    ? select.locator(
        `option[value=${cssString(wanted.value)}], option:not([value])`,
      )
    : select
        .locator("option[label]")
        .or(
          select
            .locator("option:not([label])")
            .filter({ hasText: normalizeWhiteSpace(wanted.label) }),
        )
        // Playwright's text filter skips style and noscript text, which
        // option.text keeps.
        .or(select.locator("option:not([label]):has(script, style, noscript)"));
  const count = await candidates.count();
  for (let i = 0; i < count; i++) {
    const option = candidates.nth(i);
    let own = await option.getAttribute(byValue ? "value" : "label", {
      timeout: timeout(),
    });
    if (own === null) {
      if (await option.locator("script").count()) return "inconclusive";
      own = optionText((await option.textContent({ timeout: timeout() })) ?? "");
    }
    const matches = byValue
      ? own === wanted.value
      : own === wanted.label ||
        normalizeWhiteSpace(own) === normalizeWhiteSpace(wanted.label);
    if (matches) return option;
  }
  return undefined;
}

// A CSS string token that holds any text: every character outside a small
// safe set becomes a hex escape.
export function cssString(text: string): string {
  let out = '"';
  for (const ch of text)
    out += /[a-zA-Z0-9 _-]/.test(ch)
      ? ch
      : "\\" + ch.codePointAt(0)!.toString(16) + " ";
  return out + '"';
}

/**
 * Watches the frames an input can navigate. Register it before the input is
 * dispatched so that no early request or commit is missed.
 */
export function watchNavigation(page: Page, frames: Frame[]) {
  // Each open navigation request remembers the commit count of its frame when
  // it started; only a later commit, or its own end, closes it.
  const open = new Map<Request, { frame: Frame; commitsAtStart: number }>();
  const commits = new Map<Frame, number>();
  let wake: (() => void) | undefined;
  const poke = () => wake?.();
  const onRequest = (request: Request) => {
    if (!request.isNavigationRequest()) return;
    let frame: Frame;
    try {
      frame = request.frame();
    } catch {
      return;
    }
    if (!frames.includes(frame)) return;
    open.set(request, { frame, commitsAtStart: commits.get(frame) ?? 0 });
    poke();
  };
  const onDone = (request: Request) => {
    if (open.delete(request)) poke();
  };
  const onNavigated = (frame: Frame) => {
    if (!frames.includes(frame)) return;
    commits.set(frame, (commits.get(frame) ?? 0) + 1);
    poke();
  };
  page.on("request", onRequest);
  page.on("requestfinished", onDone);
  page.on("requestfailed", onDone);
  page.on("framenavigated", onNavigated);
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, Math.max(0, ms));
      function done() {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      }
      wake = done;
    });
  const quiet = async (deadline: number) => {
    const until = Math.min(deadline, performance.now() + SETTLE_QUIET_MS);
    while (performance.now() < until) await pause(until - performance.now());
  };
  const waiting = () =>
    [...open.values()].some(
      ({ frame, commitsAtStart }) =>
        (commits.get(frame) ?? 0) <= commitsAtStart,
    );
  const total = () => [...commits.values()].reduce((a, b) => a + b, 0);
  return {
    /**
     * Resolves true once the watched frames are quiet: every navigation
     * request ended or its frame committed after it started, each committed
     * frame fired load, and no new navigation began in a quiet window after
     * that. Resolves false at the deadline, a performance.now() time. It
     * never proves that the page applied the input.
     */
    async settle(deadline: number): Promise<boolean> {
      await quiet(deadline);
      for (;;) {
        while (waiting()) {
          if (performance.now() >= deadline) return false;
          await pause(deadline - performance.now());
        }
        if (!commits.size) return true;
        const seen = total();
        for (const frame of commits.keys()) {
          if (frame.isDetached()) continue;
          const remaining = deadline - performance.now();
          if (remaining <= 0) return false;
          try {
            await frame.waitForLoadState("load", { timeout: remaining });
          } catch {
            if (!frame.isDetached()) return false;
          }
        }
        // A load handler can start the next navigation.
        await quiet(deadline);
        if (!waiting() && total() === seen) return true;
        if (performance.now() >= deadline) return false;
      }
    },
    dispose() {
      wake?.();
      page.off("request", onRequest);
      page.off("requestfinished", onDone);
      page.off("requestfailed", onDone);
      page.off("framenavigated", onNavigated);
    },
  };
}
