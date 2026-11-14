// Shared by the access slider DOM tests (task e77304b1): a shim that records
// what a save writes, agents at a stop, and helpers for the slider's DOM
// (data-access-stop). The slider has no pack picker (task 82da687b).
// Imports the dialog, so a test loads it with `await import(...)` after
// setUpDomTestFile(), never statically.
import { act, fireEvent, render } from "@testing-library/react";
import {
  EditAgentDialog,
  type AgentSettingsSection,
} from "../components/EditAgentDialog.tsx";
import { ApiError, setApiShim } from "../api.ts";
import { onLanguage, selfUserRecord } from "./language-fixture.tsx";
import {
  claudeAgent,
  openSection,
  room,
  settle,
  viewer,
} from "./claude-limits-fixture.tsx";
import type { AgentInfo, UserRecord } from "../../shared/types.ts";
import type { AgentAccess } from "../../shared/agent-access.ts";

export { openSection, settle, viewer };

export const STOPS: AgentAccess[] = [
  "chat",
  "office",
  "folder",
  "web",
  "standard",
  "privileged",
];
export const BELOW: AgentAccess[] = ["chat", "office", "folder", "web"];
export const MEMBER_ROOMS = [
  { id: "r1", name: "Studio" },
  { id: "r2", name: "Lab" },
];
export const REFUSAL = "fixture refusal from the server";

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

// Records every write a save makes. rooms: how GET /api/me/rooms answers
// (never: it stays pending). refuseAccess: PUT /access answers 422.
// refuse: the write whose route (see `route`) is `route` answers 422 with
// `code` and REFUSAL; read at each call, so a test can lift it mid-way.
export function shim(
  opts: {
    rooms?: "ok" | "never" | "fail";
    refuseAccess?: boolean;
    refuse?: { route: string; code: string };
  } = {},
): Call[] {
  const calls: Call[] = [];
  setApiShim(async (method, path, body) => {
    if (path === "/api/me/rooms") {
      if (opts.rooms === "never") return new Promise(() => {});
      if (opts.rooms === "fail") throw new ApiError(500, "boom", "boom");
      return { rooms: MEMBER_ROOMS };
    }
    if (path === "/api/validate/cwd") return { ok: true };
    if (path.startsWith("/api/memory"))
      return { text: "", version: "v1", size: 0, cap: 5000 };
    if (path.includes("/sessions"))
      return { sessions: [], currentSessionId: null };
    // The engine's model list, fetched when the engine changes: not a save.
    if (path.startsWith("/api/backends/")) return { models: [] };
    if (method === "GET" || path === "/api/agents/system-prompt-preview")
      return {};
    calls.push({ method, path, body });
    if (opts.refuseAccess && path.endsWith("/access"))
      throw new ApiError(422, "folder_not_allowed", REFUSAL);
    if (opts.refuse && route({ method, path, body }) === opts.refuse.route)
      throw new ApiError(422, opts.refuse.code, REFUSAL);
    if (method === "POST" && path === "/api/agents")
      return { agent: { ...claudeAgent("opus", "default", []), id: "new" } };
    return {};
  });
  return calls;
}

export function agentAt(
  access: AgentAccess | undefined,
  agentType: AgentInfo["agentType"] = "claude",
): AgentInfo {
  const base = claudeAgent("opus", "default", []);
  return {
    ...base,
    agentType,
    ...(access ? { access } : {}),
    ...(access === "privileged" ? { privileged: true } : {}),
  };
}

export function user(id: string, name: string, role: "owner" | "member") {
  return { ...selfUserRecord(null), id, name, role, allowedRooms: [room.id] };
}
const users = new Map(
  [
    user("owner", "Owner", "owner"),
    user("member", "Member", "member"),
    user("peer", "Peer", "member"),
  ].map((u) => [u.name.toLowerCase(), u]),
);

// On the Agent settings page's Access section unless a test names another
// (task 59538509); openSection (claude-limits-fixture) opens one more.
export function renderEdit(
  agent: AgentInfo,
  onClose: () => void = () => {},
  sessionContext = viewer([]),
  section: AgentSettingsSection = "access",
) {
  return render(
    onLanguage(
      "en",
      <EditAgentDialog
        onClose={onClose}
        agent={agent}
        initialSection={section}
      />,
      {
        rooms: [room],
        agents: [agent],
        users,
        hasReceivedInitialState: true,
        sessionContext,
      },
    ),
  );
}

// A spawn as the viewer `sessionContext` (the owner by default), with
// `spawner` (a full user record) added to the users the dialog reads, into
// `spawnRoom` (the fixture's room, with no folder, by default).
export function renderSpawn(
  sessionContext = viewer([]),
  spawner?: UserRecord,
  spawnRoom: typeof room & { cwd?: string | null } = room,
) {
  const spawnUsers = spawner
    ? new Map([...users, [spawner.name.toLowerCase(), spawner]])
    : users;
  return render(
    onLanguage(
      "en",
      <EditAgentDialog
        onClose={() => {}}
        deskIndex={0}
        roomId={spawnRoom.id}
        defaultCwd={spawnRoom.cwd ?? "/srv/new-agent"}
        spawnAgentType="claude"
      />,
      {
        rooms: [spawnRoom],
        agents: [],
        users: spawnUsers,
        hasReceivedInitialState: true,
        sessionContext,
      },
    ),
  );
}

// A stop is a step of the slider (StepSlider): a button with role radio.
// The group carries data-access-stop too, so the role is in the selector.
export function stopRadio(container: HTMLElement, stop: AgentAccess) {
  const radio = container.querySelector<HTMLButtonElement>(
    `button[role="radio"][data-access-stop="${stop}"]`,
  );
  if (!radio) throw new Error(`no ${stop} stop`);
  return radio;
}

export function stopChecked(container: HTMLElement, stop: AgentAccess) {
  return stopRadio(container, stop).getAttribute("aria-checked") === "true";
}

// A stop the engine cannot run is aria-disabled, not disabled, so its
// tooltip still shows on hover.
export function stopDisabled(container: HTMLElement, stop: AgentAccess) {
  const radio = stopRadio(container, stop);
  if (radio.disabled) throw new Error(`${stop} stop is natively disabled`);
  return radio.getAttribute("aria-disabled") === "true";
}

export async function pick(container: HTMLElement, stop: AgentAccess) {
  await act(async () => {
    fireEvent.click(stopRadio(container, stop));
  });
}

// The controls of the slider's field other than its stops: none below
// Standard since task 82da687b (no pack, area or room picker).
export function accessFieldControls(container: HTMLElement): number {
  const field = container.querySelector(".agent-access-field");
  if (!field) throw new Error("no access field");
  return field.querySelectorAll("select, input, textarea").length;
}

export async function change(select: HTMLElement, value: string) {
  await act(async () => {
    fireEvent.change(select, { target: { value } });
  });
}

// The page's Save, or the spawn dialog's last button (Spawn).
export async function save(container: HTMLElement) {
  const button =
    container.querySelector("[data-agent-settings-save]") ??
    [...container.querySelectorAll("button")].at(-1)!;
  await act(async () => {
    fireEvent.click(button);
  });
  await settle();
  await settle();
}

export const route = (c: Call) =>
  `${c.method} ${c.path.replace(/^\/api\/agents\/(a1|new)/, ":id")}`;

export function cleanup(view: { unmount(): void }) {
  view.unmount();
  setApiShim(null);
}
