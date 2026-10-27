import { afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { HeaderBackgroundPill, SceneBackgroundMark } =
  await import("./BackgroundWork.tsx");
const { Character } = await import("../office/Character.tsx");
import type { AgentState, BackgroundTask } from "../../shared/types.ts";

// Background work an agent's session still runs (task daa9dbef). In the idle
// pose a ring with the count takes the zZ's place; in the waiting pose the
// same ring sits above and to the right of the raised hand; every other pose
// stays as it is. The chat header's pill shows the count and lists what runs.

afterEach(() => cleanup());

const OUTFIT = {
  color: "#4A90D9",
  hair: "#222",
  hairStyle: "short" as const,
  skin: "#FFD5B8",
  beard: "none" as const,
  accessory: "headphones" as const,
  hat: "beanie" as const,
};

const TASKS: BackgroundTask[] = [
  { id: "a1", kind: "agent", label: "Review the diff" },
  { id: "b1", kind: "command", label: "npm run dev" },
  { id: "w1", kind: "workflow", label: "Ship it" },
];

// Static markup: ids from useId repeat across renders, so two draws compare.
const markup = (state: AgentState, backgroundCount: number, portrait = false) =>
  renderToStaticMarkup(
    createElement(Character, {
      state,
      outfit: OUTFIT,
      backgroundCount,
      portrait,
    }),
  );
const draw = (state: AgentState, backgroundCount: number, portrait = false) => {
  const root = document.createElement("div");
  root.innerHTML = markup(state, backgroundCount, portrait);
  return root;
};
// The zZ: the idle pose's z glyphs.
const zz = (root: Element) =>
  [...root.querySelectorAll("text")].filter((t) =>
    /^[zZ]$/.test(t.textContent?.trim() ?? ""),
  ).length;
const mark = (root: Element) => root.querySelector("[data-background-mark]");

describe("the idle pose", () => {
  it("shows the ring with the count where the zZ was", () => {
    const plain = draw("idle", 0);
    expect(zz(plain)).toBeGreaterThan(0);
    expect(mark(plain)).toBeNull();
    const busy = draw("idle", 2);
    expect(zz(busy)).toBe(0);
    expect(mark(busy)?.textContent?.trim()).toBe("2");
    // The zZ's place, which the waiting pose's ring does not share.
    expect(ringCentre(mark(busy)!)).toEqual({ x: 46, y: 16 });
  });

  it("leaves the working and error poses, and the portrait, as they are", () => {
    for (const state of [
      "thinking",
      "tool_executing",
      "error",
    ] as AgentState[]) {
      expect(markup(state, 3)).toBe(markup(state, 0));
    }
    for (const state of ["idle", "waiting_for_response"] as AgentState[]) {
      expect(markup(state, 3, true)).toBe(markup(state, 0, true));
    }
  });

  it("writes 9+ above nine, where two digits would not read", () => {
    const ring = (count: number) =>
      render(
        createElement(
          "svg",
          null,
          createElement(SceneBackgroundMark, { count }),
        ),
      ).container.querySelector("[data-background-mark]")?.textContent;
    expect(ring(9)?.trim()).toBe("9");
    cleanup();
    expect(ring(12)?.trim()).toBe("9+");
  });
});

// The ring's centre in the character's SVG units: its first circle's centre
// plus every translate() between the ring and the character's svg. Any other
// transform on that path fails the test, so the number cannot lie.
const ringCentre = (ring: Element) => {
  const circle = ring.querySelector("circle");
  let x = Number(circle?.getAttribute("cx"));
  let y = Number(circle?.getAttribute("cy"));
  for (
    let el: Element | null = ring;
    el && el.tagName.toLowerCase() !== "svg";
    el = el.parentElement
  ) {
    const t = el.getAttribute("transform");
    if (!t) continue;
    const m = /^translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)$/.exec(t);
    if (!m) throw new Error(`unexpected transform on the ring's path: ${t}`);
    x += Number(m[1]);
    y += Number(m[2]);
  }
  return { x, y };
};

describe("the waiting pose", () => {
  it("shows the ring with the count above and to the right of the raised hand, and keeps its own drawing", () => {
    const plain = draw("waiting_for_response", 0);
    expect(mark(plain)).toBeNull();
    const busy = draw("waiting_for_response", 3);
    const ring = mark(busy);
    expect(ring?.textContent?.trim()).toBe("3");
    // Nil's placement (Character units 52,10): clear of the waving arm, and
    // not the idle pose's zZ place.
    expect(ringCentre(ring!)).toEqual({ x: 52, y: 10 });
    // Without the ring, the pose is the one drawn with no background work.
    ring!.remove();
    expect(busy.innerHTML).toBe(plain.innerHTML);
  });
});

describe("the chat header pill", () => {
  const pill = (tasks: BackgroundTask[], phone = false) =>
    render(
      onLanguage(null, createElement(HeaderBackgroundPill, { tasks, phone })),
    );

  it("shows nothing without background work", () => {
    expect(pill([]).container.innerHTML).toBe("");
  });

  it("lists what runs on a click, one row per task with its kind, and closes on Escape and on an outside click", async () => {
    const view = pill(TASKS);
    const button = view.getByRole("button");
    expect(button.textContent).toContain("3");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(view.queryAllByRole("listitem")).toHaveLength(0);

    await act(async () => fireEvent.click(button));
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const rows = view.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    // Each row names its task, after a prefix that says its kind.
    const prefixes = rows.map((row, i) => {
      const text = row.textContent ?? "";
      expect(text).toContain(TASKS[i].label);
      return text.replace(TASKS[i].label, "").trim();
    });
    expect(prefixes.every((p) => p.length > 0)).toBe(true);
    expect(new Set(prefixes).size).toBe(3);

    await act(async () =>
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "Escape",
      }),
    );
    expect(view.queryAllByRole("listitem")).toHaveLength(0);
    expect(button.getAttribute("aria-expanded")).toBe("false");

    await act(async () => fireEvent.click(button));
    expect(view.getAllByRole("listitem")).toHaveLength(3);
    await act(async () => {
      fireEvent.pointerDown(document.body);
      fireEvent.mouseDown(document.body);
      fireEvent.click(document.body);
    });
    expect(view.queryAllByRole("listitem")).toHaveLength(0);
  });

  // Nil, sign-off of daa9dbef: the words took too much header width. The
  // pill shows the count alone on every layout, and still names it for a
  // screen reader and on hover.
  for (const phone of [false, true]) {
    it(`shows only the count ${phone ? "on a phone" : "on a desktop"}, and names it for a screen reader and on hover`, () => {
      const button = pill(TASKS.slice(0, 2), phone).getByRole("button");
      expect(button.textContent?.trim()).toBe("2");
      const name = button.getAttribute("aria-label") ?? "";
      expect(name).toContain("2");
      expect(name.trim()).not.toBe("2");
      expect(button.getAttribute("title")).toBe(name);
    });
  }
});
