// Shared steps for the page-over-a-chat render tests (task 586b63a5): a chat
// whose focus runs through a real reducer, and the four ways out of a page
// opened over it. Import it with `await import(...)` after
// setUpDomTestFile(), like every DOM module. One file per page, because the
// 5 s cap is per file.
//
// Focus runs through a real reducer: with a fixed StateCtx value a close that
// went to the office would clear focus into a no-op dispatch and still render
// the chat, so a test could not tell the two apart.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { act, render } from "@testing-library/react";
import { createElement, useReducer } from "react";
import { App } from "../App.tsx";
import { StateCtx, DispatchCtx, initialState, reducer } from "../store.tsx";
import { setApiShim } from "../api.ts";
import type { AgentInfo } from "../../shared/types.ts";

export type View = ReturnType<typeof render>;

export async function press(key: string): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

export async function goBack(): Promise<void> {
  await act(async () => {
    window.history.back();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const AGENT = {
  id: "a1",
  name: "Tester",
  desk: 0,
  roomId: "r1",
  cwd: "~",
  state: "idle",
  agentType: "claude",
  modelFamily: "opus",
  topic: null,
  outfit: {
    color: "#4A90D9",
    hair: "#222",
    hairStyle: "short",
    skin: "#FFD5B8",
    beard: "none",
    accessory: "none",
    hat: "none",
  },
} as unknown as AgentInfo;

export const WITH_CHAT = {
  ...initialState,
  agents: [AGENT],
  focusedAgentId: "a1",
  currentRoomId: "r1",
  rooms: [{ id: "r1", name: "Room" }],
} as unknown as typeof initialState;

export function Harness({
  initial = WITH_CHAT,
}: {
  initial?: typeof initialState;
}) {
  const [state, dispatch] = useReducer(reducer, initial);
  const focusOnly: typeof dispatch = (action) => {
    if (action.type === "focus") dispatch(action);
  };
  return createElement(
    StateCtx.Provider,
    { value: state },
    createElement(
      DispatchCtx.Provider,
      { value: focusOnly },
      createElement(App),
    ),
  );
}

export const chatShowing = (view: View) =>
  view.container.querySelector(".log-view-shell") !== null;

/** The shortcut, the marker its page renders, the path it shows at, and
 *  whether the same key closes it again (Settings only opens). */
export interface OverChatPage {
  key: string;
  marker: string;
  path: string;
  toggles: boolean;
}

/** The entry the page loaded on. Back to the office must land on it: a page
 *  or a chat sits on the one entry App pushes above it. */
export const LOAD_ENTRY = { loadEntry: true };

/** The API shim and history reset every file here needs. The settings page
 *  loads the room's memory file; every other call answers {}. */
export function setUpOverChat(): void {
  setApiShim(async (_method, path) =>
    path.startsWith("/api/memory")
      ? { text: "", version: "v1", size: 0, cap: 10_000 }
      : {},
  );
  afterAll(() => setApiShim(null));

  beforeEach(() => {
    window.history.replaceState(LOAD_ENTRY, "", "/");
  });
}

/** The chat shows on App's own entry, which names no page. */
export function expectChatEntry(view: View): void {
  expect(chatShowing(view)).toBe(true);
  expect(window.location.pathname).toBe("/");
  expect(window.history.state).toEqual({ isomux: true, page: null });
}

/** Back from the chat: the office, on the entry the page loaded on. */
export async function expectBackToOffice(view: View): Promise<void> {
  await goBack();
  expect(chatShowing(view)).toBe(false);
  expect(window.location.pathname).toBe("/");
  expect(window.history.state).toEqual(LOAD_ENTRY);
}

export async function clickClose(view: View): Promise<void> {
  const close =
    view.baseElement.querySelector<HTMLButtonElement>("[data-page-close]");
  expect(close).not.toBeNull();
  await act(async () => close!.click());
}

export function describeOverChat({
  key,
  marker,
  path,
  toggles,
}: OverChatPage): void {
  setUpOverChat();

  describe(`${key} opened over a chat`, () => {
    const pageOpen = (view: View) =>
      view.baseElement.querySelector(marker) !== null;

    async function openFromChat(): Promise<View> {
      const view = render(createElement(Harness));
      expect(chatShowing(view)).toBe(true);
      await press(key);
      expect(pageOpen(view)).toBe(true);
      expect(chatShowing(view)).toBe(false);
      expect(window.location.pathname).toBe(path);
      return view;
    }

    async function expectChatThenOffice(view: View): Promise<void> {
      expect(pageOpen(view)).toBe(false);
      expectChatEntry(view);
      await expectBackToOffice(view);
      expect(pageOpen(view)).toBe(false);
    }

    it("Escape returns to the chat, and Back from it to the office", async () => {
      const view = await openFromChat();
      await press("Escape");
      await expectChatThenOffice(view);
    });

    it("Close returns to the chat, and Back from it to the office", async () => {
      const view = await openFromChat();
      await clickClose(view);
      await expectChatThenOffice(view);
    });

    it("Back returns to the chat, and a further Back to the office", async () => {
      const view = await openFromChat();
      await goBack();
      await expectChatThenOffice(view);
    });

    it.if(toggles)(
      "the same key again returns to the chat, and Back to the office",
      async () => {
        const view = await openFromChat();
        await press(key);
        await expectChatThenOffice(view);
      },
    );
  });
}
