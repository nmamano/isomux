// One save footer for every Settings part that saves (task f0d50877; AGENTS.md
// UI rules: one look per kind of control). Every part acts the same: on open,
// Cancel and Save are disabled and Save reads Save; an edit enables both; a
// save makes it read Saved; a second edit makes it read Save; Cancel puts the
// form back to what was saved and it reads Saved again.
//
// DOM contract: the footer root is [data-settings-footer], Save in it is
// [data-settings-save], Cancel is the footer's other button. A section that
// saves keeps its fields in [data-settings-form-body]; the footer is never
// inside that box. Imports testing-library, so a test loads it with
// `await import(...)` after setUpDomTestFile(), never statically.

import { act, fireEvent, render } from "@testing-library/react";
import { expect } from "bun:test";
import { translatorFor } from "../../shared/i18n/translate.ts";
import { setApiShim } from "../api.ts";
import type { Selection } from "../components/UserSettingsView.tsx";
import type {
  AgentInfo,
  SessionContext,
  UserRecord,
} from "../../shared/types.ts";
import { onLanguage } from "./language-fixture.tsx";
import { settingsAt } from "./settings-item.tsx";
import { room, viewer } from "./claude-limits-fixture.tsx";

const { t } = translatorFor("en");

export interface Write {
  method: string;
  path: string;
  body: unknown;
}

/** Answers the reads the item pages make on open and records every write.
 *  An instructions PUT answers the stored text and its new version. */
export function shimItemApi(): Write[] {
  const writes: Write[] = [];
  setApiShim(async (method, path, body) => {
    if (path.startsWith("/api/memory"))
      return { text: "", version: "v1", size: 0, cap: 5000 };
    if (path === "/api/me/rooms") return { rooms: [room] };
    if (path === "/api/removed-members") return { members: [] };
    if (path === "/api/validate/cwd") return { ok: true };
    if (path.includes("/sessions"))
      return { sessions: [], currentSessionId: null };
    if (path.startsWith("/api/backends/")) return { models: [] };
    if (path.endsWith("/settings") && method === "GET")
      return { prompt: "", version: "0" };
    if (path.endsWith("/instructions") && method === "GET")
      return { instructions: "", version: "0" };
    if (method === "GET") return {};
    writes.push({ method, path, body });
    if (path.endsWith("/instructions"))
      return {
        instructions:
          (body as { instructions?: string | null }).instructions ?? null,
        version: `v${writes.length}`,
      };
    return {};
  });
  return writes;
}

/** The Settings page on `target` (as the owner unless a session is
 *  given), with a store a test can
 *  change (the record update the server's event brings after a save). */
export function mountSettingsAt(
  target: Selection,
  store: { users: UserRecord[]; agents: AgentInfo[] },
  sessionContext: SessionContext = viewer([]),
) {
  const build = () =>
    onLanguage("en", settingsAt(target), {
      rooms: [{ ...room, type: "office" as const }],
      agents: store.agents,
      users: new Map(store.users.map((u) => [u.name.toLowerCase(), u])),
      hasReceivedInitialState: true,
      sessionContext,
    });
  const view = render(build());
  return {
    view,
    async update(next: Partial<typeof store>): Promise<void> {
      Object.assign(store, next);
      await act(async () => {
        view.rerender(build());
      });
    },
  };
}

/** The page's one footer. Throws on none or more than one. */
export function footer(root: ParentNode): HTMLElement {
  const all = root.querySelectorAll<HTMLElement>("[data-settings-footer]");
  if (all.length !== 1)
    throw new Error(`expected one [data-settings-footer], found ${all.length}`);
  return all[0];
}

export function footerButtons(root: ParentNode): {
  save: HTMLButtonElement;
  cancel: HTMLButtonElement;
} {
  const f = footer(root);
  const saves = f.querySelectorAll<HTMLButtonElement>("[data-settings-save]");
  if (saves.length !== 1)
    throw new Error(`expected one Save in the footer, found ${saves.length}`);
  const others = [...f.querySelectorAll<HTMLButtonElement>("button")].filter(
    (b) => !b.hasAttribute("data-settings-save"),
  );
  if (others.length !== 1)
    throw new Error(
      `expected one Cancel in the footer, found ${others.length}`,
    );
  return { save: saves[0], cancel: others[0] };
}

export type FooterState = {
  save: "enabled" | "disabled";
  cancel: "enabled" | "disabled";
  label: string;
};

export function footerState(root: ParentNode): FooterState {
  const { save, cancel } = footerButtons(root);
  return {
    save: save.disabled ? "disabled" : "enabled",
    cancel: cancel.disabled ? "disabled" : "enabled",
    label: save.textContent ?? "",
  };
}

export const OPENED: FooterState = {
  save: "disabled",
  cancel: "disabled",
  label: t("common.save"),
};
export const EDITED: FooterState = {
  save: "enabled",
  cancel: "enabled",
  label: t("common.save"),
};
export const SAVED: FooterState = {
  save: "disabled",
  cancel: "disabled",
  label: t("common.saved"),
};

/** Exactly one Save on the page, in the footer, and the footer outside the
 *  form's padded box and every max-width column up to the detail pane. */
export function expectFooterPlacement(root: HTMLElement): void {
  expect(root.querySelectorAll("[data-settings-save]").length).toBe(1);
  const f = footer(root);
  expect(f.closest("[data-settings-form-body]")).toBeNull();
  const detail = f.closest('[data-testid="settings-content"]');
  expect(detail).not.toBeNull();
  const boxed: string[] = [];
  for (let el = f.parentElement; el && el !== detail; el = el.parentElement)
    if (el.style.maxWidth) boxed.push(el.style.maxWidth);
  expect(boxed).toEqual([]);
}

export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el);
  });
  await settle();
}

/** A part under test. `edit(1)` and `edit(2)` each set the edited field to
 *  a value unlike the one before; `value()` reads it; `broadcast()` gives
 *  the store the record the server's event carries after the first save. */
export interface SaveFooterCase {
  root: HTMLElement;
  edit: (step: 1 | 2) => Promise<void>;
  value: () => unknown;
  broadcast?: () => Promise<void>;
}

/** The whole cycle: open, edit, save, edit, Cancel. */
export async function expectSaveCycle(c: SaveFooterCase): Promise<void> {
  const opened = c.value();
  expect(footerState(c.root)).toEqual(OPENED);

  await c.edit(1);
  const first = c.value();
  expect(first).not.toEqual(opened);
  expect(footerState(c.root)).toEqual(EDITED);

  await click(footerButtons(c.root).save);
  await c.broadcast?.();
  await settle();
  expect(c.value()).toEqual(first);
  expect(footerState(c.root)).toEqual(SAVED);

  await c.edit(2);
  expect(c.value()).not.toEqual(first);
  expect(footerState(c.root)).toEqual(EDITED);

  // Cancel puts back what was saved, and the page still knows it saved.
  await click(footerButtons(c.root).cancel);
  expect(c.value()).toEqual(first);
  expect(footerState(c.root)).toEqual(SAVED);
}
