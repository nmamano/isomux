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

// The checkbox values in the open list, in order.
export function filterOptions(container: HTMLElement, which: string): string[] {
  return [
    ...root(container, which).querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    ),
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
      'input[type="checkbox"]:checked',
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
    'input[type="checkbox"]',
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
    `input[type="checkbox"][value="${value}"]`,
  )!;
  await act(async () => fireEvent.click(box));
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
