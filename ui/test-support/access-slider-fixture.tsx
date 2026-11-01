// Shared by the access slider DOM tests (task e77304b1): a shim that records
// what a save writes, agents at a stop, and helpers for the slider's DOM
// (data-access-stop, data-pack-preset, data-pack-area).
// Imports the dialog, so a test loads it with `await import(...)` after
// setUpDomTestFile(), never statically.
import { act, fireEvent, render } from "@testing-library/react";
import { EditAgentDialog } from "../components/EditAgentDialog.tsx";
import { ApiError, setApiShim } from "../api.ts";
import { onLanguage, selfUserRecord } from "./language-fixture.tsx";
import { claudeAgent, room, settle, viewer } from "./claude-limits-fixture.tsx";
import type { AgentInfo } from "../../shared/types.ts";
import type { AgentAccess } from "../../shared/agent-access.ts";
import type { ApiTokenLimits } from "../../shared/api-token-limits.ts";

export { settle, viewer };

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
export function shim(
  opts: { rooms?: "ok" | "never" | "fail"; refuseAccess?: boolean } = {},
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
    if (method === "POST" && path === "/api/agents")
      return { agent: { ...claudeAgent("opus", "default", []), id: "new" } };
    return {};
  });
  return calls;
}

export function agentAt(
  access: AgentAccess | undefined,
  pack?: ApiTokenLimits,
  agentType: AgentInfo["agentType"] = "claude",
): AgentInfo {
  const base = claudeAgent("opus", "default", []);
  return {
    ...base,
    agentType,
    ...(access ? { access } : {}),
    ...(access === "privileged" ? { privileged: true } : {}),
    ...(pack ? { pack } : {}),
  };
}

function user(id: string, name: string, role: "owner" | "member") {
  return { ...selfUserRecord(null), id, name, role, allowedRooms: [room.id] };
}
const users = new Map(
  [
    user("owner", "Owner", "owner"),
    user("member", "Member", "member"),
    user("peer", "Peer", "member"),
  ].map((u) => [u.name.toLowerCase(), u]),
);

export function renderEdit(
  agent: AgentInfo,
  onClose: () => void = () => {},
  sessionContext = viewer([]),
) {
  return render(
    onLanguage("en", <EditAgentDialog onClose={onClose} agent={agent} />, {
      rooms: [room],
      agents: [agent],
      users,
      hasReceivedInitialState: true,
      sessionContext,
    }),
  );
}

export function renderSpawn() {
  return render(
    onLanguage(
      "en",
      <EditAgentDialog
        onClose={() => {}}
        deskIndex={0}
        roomId={room.id}
        defaultCwd="/srv/new-agent"
        spawnAgentType="claude"
      />,
      {
        rooms: [room],
        agents: [],
        users,
        hasReceivedInitialState: true,
        sessionContext: viewer([]),
      },
    ),
  );
}

export function stopRadio(container: HTMLElement, stop: AgentAccess) {
  const radio = container.querySelector<HTMLInputElement>(
    `input[data-access-stop="${stop}"]`,
  );
  if (!radio) throw new Error(`no ${stop} stop`);
  return radio;
}

export async function pick(container: HTMLElement, stop: AgentAccess) {
  await act(async () => {
    fireEvent.click(stopRadio(container, stop));
  });
}

export function presetSelect(container: HTMLElement) {
  const select = container.querySelector<HTMLSelectElement>(
    "select[data-pack-preset]",
  );
  if (!select) throw new Error("no pack preset select");
  return select;
}

export function areaSelect(container: HTMLElement, area: string) {
  const select = container.querySelector<HTMLSelectElement>(
    `select[data-pack-area="${area}"]`,
  );
  if (!select) throw new Error(`no ${area} area select`);
  return select;
}

export async function change(select: HTMLElement, value: string) {
  await act(async () => {
    fireEvent.change(select, { target: { value } });
  });
}

export async function save(container: HTMLElement) {
  await act(async () => {
    fireEvent.click([...container.querySelectorAll("button")].at(-1)!);
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
