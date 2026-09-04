import {
  evaluateProposedAction,
  type PolicyDecision,
  type ProposedAction,
} from "../../safety-policy.ts";
import { SAFETY_WARNING } from "../codex/safety-hook.ts";

export interface OpenCodePermissionEnvelope {
  id: string;
  sessionId: string;
  permission: unknown;
  patterns: unknown;
  metadata: unknown;
}

export type OpenCodePermissionDecision =
  | { kind: "policy"; decision: PolicyDecision }
  | { kind: "fail_open"; warning: typeof SAFETY_WARNING };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function openCodePermissionToAction(
  envelope: OpenCodePermissionEnvelope,
): ProposedAction | null {
  if (typeof envelope.permission !== "string" || !envelope.permission)
    return null;
  const metadata = record(envelope.metadata);
  if (envelope.permission === "bash") {
    if (!metadata || typeof metadata.command !== "string") return null;
    return { kind: "shell", command: metadata.command };
  }
  if (envelope.permission === "edit") {
    const filepath = metadata?.filepath;
    if (typeof filepath !== "string") return null;
    return {
      kind: "write-files",
      toolName: "write",
      input: { filepath },
    };
  }
  return {
    kind: "uncovered-tool",
    toolName: envelope.permission,
    input: metadata ?? {},
  };
}

export function evaluateOpenCodePermission(
  envelope: OpenCodePermissionEnvelope,
  cwd: string,
  evaluate: typeof evaluateProposedAction = evaluateProposedAction,
): OpenCodePermissionDecision {
  try {
    const action = openCodePermissionToAction(envelope);
    if (!action) return { kind: "fail_open", warning: SAFETY_WARNING };
    return { kind: "policy", decision: evaluate(action, { cwd }) };
  } catch {
    // One malformed call is local, but an adapter or pin-shape fault can affect
    // every call and stop every OpenCode agent. Keep that larger blast radius
    // working and visible; a real policy deny below still rejects the request.
    return { kind: "fail_open", warning: SAFETY_WARNING };
  }
}
