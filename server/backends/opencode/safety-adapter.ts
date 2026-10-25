import {
  evaluateProposedAction,
  type PolicyDecision,
  type ProposedAction,
} from "../../safety-policy.ts";
import { resolve } from "node:path";
import { SAFETY_WARNING } from "../codex/safety-hook.ts";

// A permission.asked frame of @opencode/cli 2.1.4: an action and the
// resources it asks for. A shell request names its command; an edit request
// names its files relative to the session's folder, and its metadata holds
// each file's diff.
export interface OpenCodePermissionEnvelope {
  id: string;
  sessionId: string;
  action: unknown;
  resources: unknown;
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

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && !!item)
    : [];
}

// The policy actions of one request, one per file of an edit; null when the
// request names nothing the policy can check.
export function openCodePermissionToActions(
  envelope: OpenCodePermissionEnvelope,
  cwd: string,
): ProposedAction[] | null {
  if (typeof envelope.action !== "string" || !envelope.action) return null;
  const resources = strings(envelope.resources);
  if (envelope.action === "shell") {
    if (resources.length === 0) return null;
    return resources.map((command) => ({ kind: "shell", command }));
  }
  if (envelope.action === "edit") {
    const files =
      resources.length > 0
        ? resources
        : strings(
            (Array.isArray(record(envelope.metadata)?.files)
              ? (record(envelope.metadata)!.files as unknown[])
              : []
            ).map((file) => record(file)?.file),
          );
    if (files.length === 0) return null;
    return files.map((file) => ({
      kind: "write-files",
      toolName: "write",
      input: { filepath: resolve(cwd, file) },
    }));
  }
  return [
    {
      kind: "uncovered-tool",
      toolName: envelope.action,
      input: { resources, metadata: record(envelope.metadata) ?? {} },
    },
  ];
}

export function evaluateOpenCodePermission(
  envelope: OpenCodePermissionEnvelope,
  cwd: string,
  evaluate: typeof evaluateProposedAction = evaluateProposedAction,
): OpenCodePermissionDecision {
  try {
    const actions = openCodePermissionToActions(envelope, cwd);
    if (!actions) return { kind: "fail_open", warning: SAFETY_WARNING };
    // The first deny wins: an edit of several files is denied when one is.
    let decision: PolicyDecision | undefined;
    for (const action of actions) {
      decision = evaluate(action, { cwd });
      if (decision.decision === "deny") break;
    }
    return { kind: "policy", decision: decision! };
  } catch {
    // One malformed call is local, but an adapter or pin-shape fault can affect
    // every call and stop every OpenCode agent. Keep that larger blast radius
    // working and visible; a real policy deny below still rejects the request.
    return { kind: "fail_open", warning: SAFETY_WARNING };
  }
}
