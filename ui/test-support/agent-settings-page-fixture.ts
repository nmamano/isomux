// Shared by the App tests of the Agent settings page (task 59538509):
// ui/App.agent-settings-page.dom.test.tsx and
// ui/App.agent-settings-page-guards.dom.test.tsx. Built on
// ui/test-support/chat-sidebar-fixture.tsx; a test loads it with
// `await import(...)` after setUpDomTestFile(), never statically.
import { act, fireEvent } from "@testing-library/react";
import { expect } from "bun:test";
import { en } from "../../shared/i18n/en.ts";
import {
  chatOpen,
  click,
  roomHeader,
  sidebar,
  type View,
} from "./chat-sidebar-fixture.tsx";

/** The agent settings page's agent id, or null when no page shows. */
export const pageAgent = (view: View) =>
  view.baseElement
    .querySelector("[data-agent-settings-page]")
    ?.getAttribute("data-agent-settings-page") ?? null;
export const currentSection = (view: View) =>
  view.baseElement
    .querySelector('button[data-agent-settings-section][aria-current="true"]')
    ?.getAttribute("data-agent-settings-section") ?? null;
export const nameInput = (view: View) =>
  view.baseElement.querySelector<HTMLInputElement>(
    "[data-agent-settings-page] .agent-identity-section input",
  );
export const settingsOpen = (view: View) =>
  view.baseElement.querySelector('[data-testid="settings-content"]') !== null;
export const tasksOpen = (view: View) =>
  view.container.querySelector("[data-tasks-page]") !== null;
/** The discard prompt's box, or null. Its first button discards. */
export function prompt(view: View): HTMLElement | null {
  const text = [...view.baseElement.querySelectorAll("span")].find(
    (span) => span.textContent === en["common.discardPrompt"],
  );
  return text?.parentElement ?? null;
}
export async function discard(view: View): Promise<void> {
  const box = prompt(view);
  expect(box).not.toBeNull();
  await click(box!.querySelector("button"));
}
/** The chat header's agent name: the generic door. */
export const headerName = (view: View) =>
  view.container.querySelector(
    `.log-view-shell [title="${en["logView.editAgent"]}"]`,
  );
export async function openRoom(view: View, roomId: string): Promise<void> {
  if (roomHeader(view, roomId)?.getAttribute("aria-expanded") !== "true")
    await click(roomHeader(view, roomId));
  expect(roomHeader(view, roomId)?.getAttribute("aria-expanded")).toBe("true");
}
export const settingsButton = (view: View, agentId: string) =>
  view.container.querySelector(
    `nav[data-chat-sidebar] button[data-sidebar-agent-settings="${agentId}"]`,
  );
export async function typeName(view: View, value: string): Promise<void> {
  const input = nameInput(view);
  expect(input).not.toBeNull();
  await act(async () => fireEvent.change(input!, { target: { value } }));
}
/** What shows: the page's agent, the chat, the sidebar. */
export const shows = (view: View) => ({
  page: pageAgent(view),
  chat: chatOpen(view),
  sidebar: sidebar(view) !== null,
});
