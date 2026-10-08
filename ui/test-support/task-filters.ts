// Drives the Tasks page's status and priority checkbox filters in DOM tests.
const { act, fireEvent } = await import("@testing-library/react");

export type TaskFilter = "status" | "priority";

function root(container: HTMLElement, which: TaskFilter): HTMLElement {
  const roots = container.querySelectorAll<HTMLElement>("[data-task-filter]");
  return roots[which === "status" ? 0 : 1];
}

export function filterButton(
  container: HTMLElement,
  which: TaskFilter,
): HTMLButtonElement {
  return root(container, which).querySelector("button")!;
}

// The checkbox values in the open list, in order.
export function filterOptions(
  container: HTMLElement,
  which: TaskFilter,
): string[] {
  return [
    ...root(container, which).querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    ),
  ].map((box) => box.value);
}

// The checked values; opens the list first when it is closed.
export async function checkedFilterValues(
  container: HTMLElement,
  which: TaskFilter,
): Promise<string[]> {
  await openTaskFilter(container, which);
  return [
    ...root(container, which).querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]:checked',
    ),
  ].map((box) => box.value);
}

export async function openTaskFilter(
  container: HTMLElement,
  which: TaskFilter,
) {
  const button = filterButton(container, which);
  if (button.getAttribute("aria-expanded") === "true") return;
  await act(async () => fireEvent.click(button));
}

export async function toggleTaskFilter(
  container: HTMLElement,
  which: TaskFilter,
  value: string,
) {
  await openTaskFilter(container, which);
  const box = root(container, which).querySelector<HTMLInputElement>(
    `input[type="checkbox"][value="${value}"]`,
  )!;
  await act(async () => fireEvent.click(box));
}

// Leaves exactly the given values checked.
export async function setTaskFilter(
  container: HTMLElement,
  which: TaskFilter,
  values: string[],
) {
  await openTaskFilter(container, which);
  for (const value of filterOptions(container, which)) {
    const checked = (await checkedFilterValues(container, which)).includes(
      value,
    );
    if (checked !== values.includes(value)) {
      await toggleTaskFilter(container, which, value);
    }
  }
}
