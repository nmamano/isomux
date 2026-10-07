// Shared by the EditAgentDialog claude-limits DOM tests: a Claude agent with
// its manager's limitedClaudeFamilies, a viewer session, and dialog helpers.
// Imports the dialog and store, so a test loads it with `await import(...)`
// after setUpDomTestFile(), never statically.
import { act, fireEvent, render } from "@testing-library/react";
import { EditAgentDialog } from "../components/EditAgentDialog.tsx";
import { onLanguage } from "./language-fixture.tsx";
import { setApiShim } from "../api.ts";
import {
  DEFAULT_AGENT_CAPABILITIES,
  type AgentInfo,
  type SessionContext,
} from "../../shared/types.ts";

export const CLOUD = ["sonnet", "haiku"];
export const room = {
  id: "r1",
  name: "Studio",
  prompt: null,
  canCloseWhenEmpty: true,
};

export function claudeAgent(
  modelFamily: string,
  permissionMode: AgentInfo["permissionMode"],
  limitedClaudeFamilies: string[],
): AgentInfo {
  return {
    id: "a1",
    name: "Saved name",
    roomId: room.id,
    desk: 0,
    cwd: "~",
    outfit: {
      color: "#4A90D9",
      hair: "#222",
      hairStyle: "short",
      skin: "#FFD5B8",
      beard: "none",
      accessory: null,
      hat: "none",
    },
    permissionMode,
    modelFamily,
    effort: "high",
    state: "idle",
    topic: null,
    topicStale: false,
    customInstructions: "",
    customInstructionsVersion: "v1",
    agentType: "claude",
    capabilities: DEFAULT_AGENT_CAPABILITIES,
    limitedClaudeFamilies,
    userId: "member",
    username: "Member",
    queue: [],
    sessionSwapping: false,
    turnHadHumanInput: false,
  };
}

export function viewer(limitedClaudeFamilies: string[]): SessionContext {
  return {
    userId: "owner",
    username: "Owner",
    role: "owner",
    currentSessionPrefix: "00000000",
    connectionId: "c1",
    limitedClaudeFamilies,
  };
}

// Records PATCH bodies; answers the few requests the dialog makes on open.
export function shimRequests(): unknown[] {
  const patches: unknown[] = [];
  setApiShim(async (method, path, body) => {
    if (method === "PATCH") patches.push(body);
    if (path === "/api/validate/cwd") return { ok: true };
    if (path.startsWith("/api/memory"))
      return { text: "", version: "v1", size: 0, cap: 5000 };
    if (path.includes("/sessions"))
      return { sessions: [], currentSessionId: null };
    return {};
  });
  return patches;
}

export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export function selectWith(container: HTMLElement, value: string): HTMLSelectElement {
  const select = [...container.querySelectorAll("select")].find((candidate) =>
    [...candidate.options].some((option) => option.value === value),
  );
  if (!select) throw new Error(`no select with ${value}`);
  return select;
}

export function modeSelect(container: HTMLElement): HTMLSelectElement {
  return selectWith(container, "acceptEdits");
}

export function offersAuto(container: HTMLElement): boolean {
  return [...modeSelect(container).options].some((o) => o.value === "auto");
}

export function hasEffort(container: HTMLElement): boolean {
  return [...container.querySelectorAll("select")].some((select) =>
    [...select.options].some((option) => option.value === "medium"),
  );
}

export function renderEdit(agent: AgentInfo, viewerLimited: string[]) {
  const element = (current: AgentInfo) =>
    onLanguage("en", <EditAgentDialog onClose={() => {}} agent={current} />, {
      rooms: [room],
      agents: [current],
      hasReceivedInitialState: true,
      sessionContext: viewer(viewerLimited),
    });
  const view = render(element(agent));
  return { view, rerender: (next: AgentInfo) => view.rerender(element(next)) };
}

export async function renameAndSave(container: HTMLElement): Promise<void> {
  const name = container.querySelector("input") as HTMLInputElement;
  fireEvent.change(name, { target: { value: "Renamed" } });
  fireEvent.click([...container.querySelectorAll("button")].at(-1)!);
  await settle();
  await settle();
}

