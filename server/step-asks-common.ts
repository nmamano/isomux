// What the step-ask families share (server/step-asks.ts): the answers that
// refuse a step, and the family each kind belongs to. A family module
// imports only types from server/step-asks.ts, so no import goes back into
// the core at run time.

import type { ActionStepRequest, AskStep } from "../shared/types.ts";
import type { LogMessage } from "../shared/i18n/log-message.ts";
import type {
  StepFailure,
  StepRoute,
  StepRun,
  StepRunDeps,
} from "./step-asks.ts";

export const invalid = (message: string): StepFailure => ({
  ok: false,
  status: 400,
  code: "invalid_request",
  message,
});

export const notAllowed = (message: string): StepFailure => ({
  ok: false,
  status: 403,
  code: "member_not_allowed",
  message,
});

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Each key of `set` has its value in `now`.
export const allSet = (set: object, now: Record<string, unknown>): boolean =>
  Object.entries(set).every(([key, value]) => now[key] === value);

export const unknownMember = (): StepFailure => ({
  ok: false,
  status: 422,
  code: "unknown_member",
  message: "no member with this username",
});
export const unknownSession = (): StepFailure => ({
  ok: false,
  status: 422,
  code: "unknown_session",
  message: "no live session of this member with this prefix",
});
// No route of the member with this id: the same answer for another
// member's.
export const unknownRoute = (): StepFailure => ({
  ok: false,
  status: 422,
  code: "unknown_route",
  message: "this member has no route with this id",
});
export const unknownRoom = (): StepFailure => ({
  ok: false,
  status: 422,
  code: "unknown_room",
  message: "no room with this id that you can reach",
});

export const ownerHasAllRooms = (): StepFailure => ({
  ok: false,
  status: 422,
  code: "owner_has_all_rooms",
  message: "an office owner reaches every room",
});
// A token that is gone and one the member may not revoke answer alike.
export const unknownToken = (): StepFailure => ({
  ok: false,
  status: 422,
  code: "unknown_token",
  message: "no live API token with this id that this member can revoke",
});
export const ownerHasNoPack = (): StepFailure => ({
  ok: false,
  status: 422,
  code: "owner_has_no_pack",
  message: "an office owner cannot have a permission pack",
});

// The first route of an action step whose target the create found: the
// one the member's authorization is judged on.
export function firstRoute<S extends AskStep>(
  routeOf: (step: S, memberUserId: string) => StepRun | null,
  step: S,
  memberUserId: string,
): StepRoute {
  const run = routeOf(step, memberUserId);
  if (!run?.ok || run.routes.length === 0)
    throw new Error(`step ${step.kind}: no route`);
  return run.routes[0];
}

export type StepFamilyName =
  "links" | "members" | "credentials" | "office" | "messaging";

// The module that holds each kind's checks. A new kind goes here, in
// STEP_KEYS (server/step-asks.ts) and in its family's module: the type
// refuses a kind with no family or with two.
export const STEP_FAMILY = {
  "provider-sign-in": "links",
  "mcp-sign-in": "links",
  "browser-pairing": "links",
  "github-link": "links",
  "agent-access": "members",
  "member-room": "members",
  "member-role": "members",
  "member-pack": "members",
  "member-preferences": "members",
  "member-view": "members",
  "member-avatar": "members",
  "member-os-user": "members",
  "member-remove": "members",
  "member-restore": "members",
  "member-purge": "members",
  "sign-in-link": "credentials",
  "member-sessions": "credentials",
  "sign-in-links-revoke": "credentials",
  "sign-in-link-extend": "credentials",
  "session-revoke": "credentials",
  "api-token": "credentials",
  "api-token-revoke": "credentials",
  "office-settings": "office",
  "backup-settings": "office",
  "office-access": "office",
  "office-update": "office",
  "storage-prune": "office",
  "storage-compress": "office",
  "storage-retention": "office",
  "instructions-line": "office",
  "discord-route": "messaging",
  "whatsapp-route": "messaging",
  "messaging-route": "messaging",
} as const satisfies Record<AskStep["kind"], StepFamilyName>;

// The steps of one family.
export type FamilyStep<F extends StepFamilyName> = Extract<
  AskStep,
  {
    kind: {
      [K in AskStep["kind"]]: (typeof STEP_FAMILY)[K] extends F ? K : never;
    }[AskStep["kind"]];
  }
>;

// What the core's create passes to a family's complete, after it checked
// the kind, the keys and the scope.
export interface CompleteInput {
  agentId?: string;
  roomId: string;
  managerUserId: string | null;
  memberUserId: string;
  // `step.scope`, personal when absent.
  scope: unknown;
  // Whether the member the ask is for is an office owner.
  owner: boolean;
}

// One family's part of each step-ask operation (server/step-asks.ts says
// what each does). An operation a family leaves out answers as the core's
// default: no route, no refusal, no target name, no times.
export interface StepFamily<S extends AskStep> {
  complete(
    body: Record<string, unknown>,
    kind: S["kind"],
    input: CompleteInput,
  ): { ok: true; step: AskStep } | StepFailure;
  isDone(step: S, memberUserId: string, since: number | null): Promise<boolean>;
  doneLine(step: S, target: string): LogMessage;
  targetName?(step: S): string;
  routeOf?(
    step: S,
    memberUserId: string,
    callerSessionIdHash?: string,
    pick?: unknown,
  ): StepRun | null;
  actionRefusal?(
    step: Extract<ActionStepRequest, S>,
    askingAgentId: string | undefined,
    memberUserId: string,
    runs: StepRunDeps,
  ): StepFailure | null;
  stateTimes?(step: S, memberUserId: string, runs: StepRunDeps): number[];
  // The create's checks: right after complete, and after the done check.
  afterComplete?(step: S): StepFailure | null;
  afterDone?(step: S): Promise<StepFailure | null>;
}
