// Drives the checkbox filters (ui/components/CheckboxFilter.tsx) of the Tasks
// page and the Inbox's Asks tab in DOM tests. A filter is named by the value
// of its data-checkbox-filter marker ("status", "priority", "room").
const { act, fireEvent } = await import("@testing-library/react");

function root(container: HTMLElement, which: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(
    `[data-checkbox-filter="${which}"]`,
  );
  if (!el) throw new Error(`no checkbox filter named "${which}"`);
  return el;
}

export function filterButton(
  container: HTMLElement,
  which: string,
): HTMLButtonElement {
  return root(container, which).querySelector("button")!;
}

// An option's checkbox; the list's All box (data-checkbox-all) is not one.
const OPTION = 'input[type="checkbox"]:not([data-checkbox-all])';

// The option values in the open list, in order.
export function filterOptions(container: HTMLElement, which: string): string[] {
  return [
    ...root(container, which).querySelectorAll<HTMLInputElement>(OPTION),
  ].map((box) => box.value);
}

// The checked values; opens the list first when it is closed.
export async function checkedFilterValues(
  container: HTMLElement,
  which: string,
): Promise<string[]> {
  await openCheckboxFilter(container, which);
  return [
    ...root(container, which).querySelectorAll<HTMLInputElement>(
      `${OPTION}:checked`,
    ),
  ].map((box) => box.value);
}

// Each checkbox's count, read from its row; opens the list first.
export async function filterCounts(
  container: HTMLElement,
  which: string,
): Promise<Record<string, number>> {
  await openCheckboxFilter(container, which);
  const counts: Record<string, number> = {};
  for (const box of root(container, which).querySelectorAll<HTMLInputElement>(
    OPTION,
  ))
    counts[box.value] = Number(
      box.closest("label")!.lastElementChild!.textContent,
    );
  return counts;
}

export async function openCheckboxFilter(
  container: HTMLElement,
  which: string,
) {
  const button = filterButton(container, which);
  if (button.getAttribute("aria-expanded") === "true") return;
  await act(async () => fireEvent.click(button));
}

export async function toggleCheckboxFilter(
  container: HTMLElement,
  which: string,
  value: string,
) {
  await openCheckboxFilter(container, which);
  const box = root(container, which).querySelector<HTMLInputElement>(
    `${OPTION}[value="${value}"]`,
  )!;
  await act(async () => fireEvent.click(box));
}

// The All box at the top of the list (task 286eaa5d); opens the list first.
export async function allFilterBox(
  container: HTMLElement,
  which: string,
): Promise<HTMLInputElement> {
  await openCheckboxFilter(container, which);
  const box = root(container, which).querySelector<HTMLInputElement>(
    "input[data-checkbox-all]",
  );
  if (!box) throw new Error(`no All box in checkbox filter "${which}"`);
  return box;
}

// The All box as one word: "all", "some" (indeterminate) or "none".
export async function allFilterState(
  container: HTMLElement,
  which: string,
): Promise<string> {
  const box = await allFilterBox(container, which);
  if (box.indeterminate) return box.checked ? "some+checked" : "some";
  return box.checked ? "all" : "none";
}

// The Only button of one option (data-checkbox-only, task 286eaa5d); opens
// the list first.
export async function onlyFilterButton(
  container: HTMLElement,
  which: string,
  value: string,
): Promise<HTMLButtonElement> {
  await openCheckboxFilter(container, which);
  const button = root(container, which).querySelector<HTMLButtonElement>(
    `button[data-checkbox-only="${value}"]`,
  );
  if (!button) throw new Error(`no Only button for "${value}" in "${which}"`);
  return button;
}

// Leaves exactly the given values checked.
export async function setCheckboxFilter(
  container: HTMLElement,
  which: string,
  values: string[],
) {
  await openCheckboxFilter(container, which);
  for (const value of filterOptions(container, which)) {
    const checked = (await checkedFilterValues(container, which)).includes(
      value,
    );
    if (checked !== values.includes(value)) {
      await toggleCheckboxFilter(container, which, value);
    }
  }
}
