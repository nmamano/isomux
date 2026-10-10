import type { Identity } from "./identity/index.ts";
import type { AuditActor } from "../shared/audit.ts";
export function auditActor(identity: Identity, name: string, appRegistrationId?: string): AuditActor {
  const ownerId = identity.userId ?? undefined;
  switch (identity.scope) {
    case "user": return { kind: "member", id: identity.userId!, name };
    case "agent": return { kind: "agent", id: identity.agentId!, name, ownerId };
    case "api": return { kind: "api_token", id: identity.apiTokenId!, name: identity.apiTokenName ?? name, ownerId };
    case "cron-run": return { kind: "cronjob", id: identity.cronjobId!, name, ownerId, runId: identity.runId };
    case "app":
      // A missing registration fails the write before its handler: no actor identity can be recorded.
      if (!appRegistrationId) throw new Error("Missing app registration for audit actor");
      return { kind: "app", id: appRegistrationId, name: identity.appName!, ownerId };
  }
}
