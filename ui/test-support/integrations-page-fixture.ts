// Shared steps for the Integrations page render tests: a signed-in state, the
// page on its own, and the clicks every test repeats. Import it with
// `await import(...)` after setUpDomTestFile(), like every DOM module.

import { act, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { StateCtx, initialState } from "../store.tsx";
import { IntegrationsView } from "../integrations/IntegrationsView.tsx";

export type View = ReturnType<typeof render>;

const user = (id: string, name: string, role: string) => ({
  id,
  name,
  role,
  createdAt: 0,
  avatarColor: "#888",
  avatarVariant: 0,
});

export const USERS = new Map<string, unknown>([
  ["ricky", user("u1", "Ricky", "owner")],
  ["stephen", user("u2", "Stephen", "member")],
  ["lena", user("u3", "Lena", "member")],
]);

export function stateFor(
  username: string,
  userId: string,
  role: string,
  users: Map<string, unknown> = USERS,
) {
  return {
    ...initialState,
    hasReceivedInitialState: true,
    sessionContext: { username, userId, role },
    users,
  } as unknown as typeof initialState;
}

export const OWNER = stateFor("Ricky", "u1", "owner");
export const MEMBER = stateFor("Stephen", "u2", "member");

export function page(
  state: typeof initialState,
  props: Record<string, unknown> = {},
) {
  return createElement(
    StateCtx.Provider,
    { value: state },
    createElement(IntegrationsView, { onClose: () => {}, ...props }),
  );
}

export async function open(
  state: typeof initialState = OWNER,
  props: Record<string, unknown> = {},
): Promise<View> {
  const view = render(page(state, props));
  await act(async () => {});
  return view;
}

export async function tab(view: View, id: string) {
  await click(view.container.querySelector(`[data-integrations-tab="${id}"]`));
}

// The selected sidebar row's tab id, or null.
export function selectedTab(view: View): string | null {
  return (
    view.baseElement
      .querySelector('[data-integrations-tab][aria-current="true"]')
      ?.getAttribute("data-integrations-tab") ?? null
  );
}

export function card(view: View, which: "office" | "personal"): HTMLElement {
  return view.container.querySelector<HTMLElement>(
    `[data-integrations-card="${which}"]`,
  )!;
}

export async function pick(view: View, member: string) {
  await act(async () => {
    fireEvent.change(
      view.container.querySelector("[data-integrations-picker]")!,
      { target: { value: member } },
    );
  });
}

export async function click(el: Element | null) {
  if (!el) throw new Error("nothing to click");
  await act(async () => {
    fireEvent.click(el);
  });
}

export async function type(el: Element | null, value: string) {
  if (!el) throw new Error("nothing to type into");
  await act(async () => {
    fireEvent.change(el, { target: { value } });
  });
}
