// Reads of the room view level control and its legend (task 16444e9c), for
// the control's own test and the two surfaces that mount them.

import { expect } from "bun:test";

// Each step of the control shows its name as text, the same name its radio
// is announced by, and the control shows nothing else.
export function expectEveryStepNamed(group: HTMLElement) {
  const steps = [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
  expect(steps).toHaveLength(5);
  const names = steps.map((s) => s.getAttribute("aria-label") ?? "");
  expect(steps.map((s) => s.textContent)).toStrictEqual(names);
  expect(names.every((n) => n.length > 0)).toBe(true);
  expect(group.textContent).toBe(names.join(""));
}

// The legend's rows in document order: the level, the highlighted name and
// the text after it.
export function legendRows(legend: HTMLElement) {
  return [...legend.querySelectorAll<HTMLElement>("li")].map((li) => {
    const strong = li.querySelector("strong");
    const name = strong?.textContent ?? "";
    return {
      level: li.dataset.viewLevel,
      name,
      meaning: (li.textContent ?? "").slice(name.length).trim(),
      nameFirst: strong !== null && (li.textContent ?? "").startsWith(name),
    };
  });
}

// The legend lists the five levels in order, each under the name `nameOf`
// gives it (the control's step name), with a meaning of its own.
export function expectLegend(
  legend: HTMLElement | null,
  levels: readonly string[],
  nameOf: (level: string) => string,
) {
  expect(legend).not.toBeNull();
  expect(legend!.tagName).toBe("UL");
  const rows = legendRows(legend!);
  expect(rows.map((r) => r.level)).toStrictEqual([...levels]);
  expect(rows.map((r) => r.name)).toStrictEqual(levels.map(nameOf));
  expect(rows.every((r) => r.nameFirst)).toBe(true);
  const meanings = rows.map((r) => r.meaning);
  expect(meanings.every((m) => m.length > 0)).toBe(true);
  expect(new Set(meanings).size).toBe(levels.length);
}
