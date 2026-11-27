// Action steps on a member's credentials: sign-in links, sessions and
// API tokens. One family of server/step-asks.ts (STEP_FAMILY in
// server/step-asks-common.ts).

import type { ActionStepRequest, AskStep } from "../shared/types.ts";
import { msg, type LogMessage } from "../shared/i18n/log-message.ts";
import { parseApiTokenCreate } from "./routes/handlers/api-tokens.ts";
import type {
  StepAskDeps,
  StepFailure,
  StepRoute,
  StepRun,
  StepRunDeps,
} from "./step-asks.ts";
import {
  firstRoute,
  invalid,
  notAllowed,
  unknownMember,
  unknownSession,
  unknownToken,
  type CompleteInput,
  type FamilyStep,
  type StepFamily,
} from "./step-asks-common.ts";

type S = FamilyStep<"credentials">;

// What the agent reads when the step is done. `target` names the agent or
// member an action step changes.
function doneLine(step: S, target: string): LogMessage {
  switch (step.kind) {
    case "sign-in-link-extend":
      return msg("systemEntries.stepAsk.signInLinkExtended", {
        member: target,
      });
    case "sign-in-link":
      return msg("systemEntries.stepAsk.signInLinkMade", { member: target });
    case "member-sessions":
      return msg("systemEntries.stepAsk.memberSignedOut", { member: target });
    case "sign-in-links-revoke":
      return msg("systemEntries.stepAsk.signInLinksRevoked", {
        member: target,
      });
    case "api-token":
      return msg("systemEntries.stepAsk.apiTokenMade", { name: step.name });
    case "api-token-revoke":
      return msg("systemEntries.stepAsk.apiTokenRevoked");
    case "session-revoke":
      return msg("systemEntries.stepAsk.sessionRevoked", { member: target });
  }
}

export function createCredentialSteps(deps: StepAskDeps): StepFamily<S> {
  // Whether the step is done now, for the member the ask is for (isDone in
  // server/step-asks.ts).
  async function isDone(
    step: S,
    memberUserId: string,
    since: number | null,
  ): Promise<boolean> {
    switch (step.kind) {
      // The link's expiry passed the one stored at the create, by the card or
      // by hand. A link used, replaced or taken back is not extended: the ask
      // stays open, and Apply answers the route's refusal.
      case "sign-in-link-extend":
        return !!deps.runs
          ?.memberInvites(step.userId)
          .some(
            (i) =>
              i.prefix === step.tokenPrefix && i.expiresAt > step.expiresAt,
          );
      // A link or token made since the ask opened, by the card or by hand.
      case "sign-in-link":
        return (
          since !== null &&
          !!deps.runs
            ?.memberInvites(step.userId)
            .some((i) => i.createdAt >= since)
        );
      case "api-token":
        return (
          since !== null &&
          !!deps.runs
            ?.memberApiTokens(memberUserId)
            .some((t) => t.name === step.name && t.createdAt >= since)
        );
      // None of the sessions or links live when the ask opened is left.
      case "member-sessions": {
        const runs = deps.runs;
        return (
          !!runs &&
          !runs
            .memberSessions(step.userId)
            .some((v) => since === null || v.createdAt < since)
        );
      }
      case "sign-in-links-revoke": {
        const runs = deps.runs;
        return (
          !!runs &&
          !runs
            .memberInvites(step.userId)
            .some((i) => since === null || i.createdAt < since)
        );
      }
      case "api-token-revoke":
        return !!deps.runs && deps.runs.apiToken(step.tokenId) === null;
      // That one session of the member is gone, by the card, by hand or by a
      // sign-out on every device.
      case "session-revoke":
        return (
          !!deps.runs &&
          !deps.runs
            .memberSessions(step.userId)
            .some((v) => v.prefix === step.sessionPrefix)
        );
    }
  }

  // The step as the agent sent it, completed, or why it is refused. The
  // core checked its kind, its keys and its scope.
  function complete(
    body: Record<string, unknown>,
    kind: S["kind"],
    input: CompleteInput,
  ): { ok: true; step: AskStep } | StepFailure {
    const { memberUserId, owner } = input;
    switch (kind) {
      // The member's one link an owner can extend, stored with its expiry
      // now. Only an office owner applies it: that refusal comes before any
      // answer about the member's links.
      case "sign-in-link-extend": {
        if (typeof body.username !== "string" || body.username === "")
          return invalid("step.username is a member's username");
        if (!deps.runs) return invalid("this office runs no action steps");
        const userId = deps.runs.memberIdByName(body.username);
        if (!userId) return unknownMember();
        if (!owner)
          return notAllowed("only an office owner can extend a sign-in link");
        const link = deps.runs.memberInvites(userId).find((i) => i.extendable);
        if (!link)
          return {
            ok: false,
            status: 409,
            code: "no_extendable_link",
            message:
              "this member has no sign-in link to extend; a sign-in-link step makes a new one",
          };
        return {
          ok: true,
          step: {
            kind,
            userId,
            tokenPrefix: link.prefix,
            expiresAt: link.expiresAt,
          },
        };
      }
      case "sign-in-link":
      case "member-sessions":
      case "sign-in-links-revoke": {
        if (typeof body.username !== "string" || body.username === "")
          return invalid("step.username is a member's username");
        if (!deps.runs) return invalid("this office runs no action steps");
        const userId = deps.runs.memberIdByName(body.username);
        if (!userId) return unknownMember();
        return { ok: true, step: { kind, userId } };
      }
      // The token as POST /api/me/api-tokens takes it, for the member the ask
      // is for: through the route's own parser.
      case "api-token": {
        if (!deps.runs) return invalid("this office runs no action steps");
        const runs = deps.runs;
        const parsed = parseApiTokenCreate(body, () =>
          runs.tokenLimitableRoomIds(memberUserId),
        );
        if (!parsed.ok) return invalid(`step: ${parsed.message}`);
        return { ok: true, step: { kind, ...parsed.req } };
      }
      // A live session of that member: a prefix of another member's session,
      // or of one that is gone, answers as one that never was.
      case "session-revoke": {
        if (typeof body.username !== "string" || body.username === "")
          return invalid("step.username is a member's username");
        if (typeof body.sessionPrefix !== "string" || body.sessionPrefix === "")
          return invalid("step.sessionPrefix is a session's prefix");
        if (!deps.runs) return invalid("this office runs no action steps");
        const userId = deps.runs.memberIdByName(body.username);
        if (!userId) return unknownMember();
        const prefix = body.sessionPrefix;
        if (!deps.runs.memberSessions(userId).some((v) => v.prefix === prefix))
          return unknownSession();
        return { ok: true, step: { kind, userId, sessionPrefix: prefix } };
      }
      // The token's owner is stored with it. A token that is gone answers as
      // one the member may not revoke (actionRefusal).
      case "api-token-revoke": {
        if (typeof body.tokenId !== "string" || body.tokenId === "")
          return invalid("step.tokenId is an API token id");
        if (!deps.runs) return invalid("this office runs no action steps");
        const token = deps.runs.apiToken(body.tokenId);
        if (!token) return unknownToken();
        return {
          ok: true,
          step: { kind, tokenId: body.tokenId, userId: token.userId },
        };
      }
    }
  }

  // The route an action step runs now (routeOf in server/step-asks.ts).
  function routeOf(
    step: S,
    memberUserId: string,
    callerSessionIdHash?: string,
    _pick?: unknown,
  ): StepRun | null {
    switch (step.kind) {
      case "sign-in-link-extend":
        if (!deps.runs?.member(step.userId)) return unknownMember();
        return {
          ok: true,
          routes: [
            {
              method: "POST",
              path: `/api/invites/${encodeURIComponent(step.tokenPrefix)}/extend`,
            },
          ],
        };
      case "sign-in-link": {
        const member = deps.runs?.member(step.userId);
        if (!member) return unknownMember();
        return {
          ok: true,
          routes: [
            step.userId === memberUserId
              ? { method: "POST", path: "/api/invites/self" }
              : {
                  method: "POST",
                  path: "/api/invites",
                  body: { userId: step.userId },
                },
          ],
        };
      }
      // Every session or link live now, so one made after the ask opened
      // goes too; the member's own session last.
      case "member-sessions": {
        if (!deps.runs?.member(step.userId)) return unknownMember();
        const live = deps.runs.memberSessions(step.userId, callerSessionIdHash);
        const ordered = [
          ...live.filter((v) => !v.current),
          ...live.filter((v) => v.current),
        ];
        return {
          ok: true,
          routes: ordered.map((v) => ({
            method: "DELETE",
            path: `/api/sessions/${encodeURIComponent(v.prefix)}`,
          })),
        };
      }
      case "session-revoke":
        if (!deps.runs?.member(step.userId)) return unknownMember();
        return {
          ok: true,
          routes: [
            {
              method: "DELETE",
              path: `/api/sessions/${encodeURIComponent(step.sessionPrefix)}`,
            },
          ],
        };
      case "sign-in-links-revoke": {
        if (!deps.runs?.member(step.userId)) return unknownMember();
        return {
          ok: true,
          routes: deps.runs.memberInvites(step.userId).map((i) => ({
            method: "DELETE",
            path: `/api/invites/${encodeURIComponent(i.prefix)}`,
          })),
        };
      }
      case "api-token":
        return {
          ok: true,
          routes: [
            {
              method: "POST",
              path: "/api/me/api-tokens",
              body: {
                name: step.name,
                expiresInDays: step.expiresInDays,
                ...(step.limits ? { limits: step.limits } : {}),
              },
            },
          ],
        };
      case "api-token-revoke": {
        const token = deps.runs?.apiToken(step.tokenId);
        if (!token) return unknownToken();
        const id = encodeURIComponent(step.tokenId);
        if (token.userId === memberUserId)
          return {
            ok: true,
            routes: [{ method: "DELETE", path: `/api/me/api-tokens/${id}` }],
          };
        const owner = deps.runs!.member(token.userId);
        if (!owner) return unknownToken();
        return {
          ok: true,
          routes: [
            {
              method: "DELETE",
              path: `/api/users/${encodeURIComponent(owner.name)}/api-tokens/${id}`,
            },
          ],
        };
      }
    }
  }

  // Why the member could not run an action step, or null (actionRefusal
  // in server/step-asks.ts).
  function actionRefusal(
    step: Extract<ActionStepRequest, S>,
    _askingAgentId: string | undefined,
    memberUserId: string,
    runs: StepRunDeps,
  ): StepFailure | null {
    switch (step.kind) {
      case "sign-in-link-extend":
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed("only an office owner can extend a sign-in link")
          : null;
      case "sign-in-link":
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed("only an office owner can make another member's link")
          : null;
      // An owner for anyone, a member for themself: the routes' own
      // preconditions, which authorization alone does not run.
      case "member-sessions":
      case "sign-in-links-revoke": {
        const path =
          step.kind === "member-sessions"
            ? "/api/sessions/-"
            : "/api/invites/-";
        if (
          (step.userId !== memberUserId && !deps.isOfficeOwner(memberUserId)) ||
          runs.authorizeAs(memberUserId, { method: "DELETE", path })
        )
          return notAllowed(
            step.kind === "member-sessions"
              ? "only an office owner can sign out another member"
              : "only an office owner can take back another member's links",
          );
        return step.kind === "member-sessions" &&
          runs.signOutStrandsOffice(step.userId)
          ? {
              ok: false,
              status: 409,
              code: "would_strand_office",
              message:
                "these are the office's last owner sessions: another office owner must be signed in",
            }
          : null;
      }
      case "api-token":
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed("this member cannot make an API token")
          : null;
      // As a sign-out: an owner for anyone, a member for themself, and never
      // the office's last owner session.
      case "session-revoke":
        if (
          (step.userId !== memberUserId && !deps.isOfficeOwner(memberUserId)) ||
          runs.authorizeAs(memberUserId, {
            method: "DELETE",
            path: "/api/sessions/-",
          })
        )
          return notAllowed("only an office owner can sign out another member");
        return runs.sessionRevokeStrandsOffice(step.userId, step.sessionPrefix)
          ? {
              ok: false,
              status: 409,
              code: "would_strand_office",
              message: "this is the office's last owner session",
            }
          : null;
      // A token the member may not revoke answers as a missing one.
      case "api-token-revoke": {
        const token = runs.apiToken(step.tokenId);
        if (
          !token ||
          (token.userId !== memberUserId && !deps.isOfficeOwner(memberUserId))
        )
          return unknownToken();
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? unknownToken()
          : null;
      }
    }
  }

  // The name of the agent or member an action step changes, else "".
  function targetName(step: S): string {
    switch (step.kind) {
      case "sign-in-link":
      case "member-sessions":
      case "session-revoke":
      case "sign-in-links-revoke":
      case "sign-in-link-extend":
        return deps.runs?.member(step.userId)?.name ?? step.userId;
      default:
        return "";
    }
  }

  // When each link, session or token a step's predicate reads by the
  // ask's age was made; none for the other kinds.
  function stateTimes(
    step: S,
    memberUserId: string,
    runs: StepRunDeps,
  ): number[] {
    switch (step.kind) {
      case "sign-in-link":
      case "sign-in-links-revoke":
        return runs.memberInvites(step.userId).map((i) => i.createdAt);
      case "member-sessions":
        return runs.memberSessions(step.userId).map((v) => v.createdAt);
      case "api-token":
        return runs.memberApiTokens(memberUserId).map((t) => t.createdAt);
      default:
        return [];
    }
  }

  const runRoute = (
    step: Extract<ActionStepRequest, S>,
    memberUserId: string,
  ): StepRoute => firstRoute(routeOf, step, memberUserId);

  return {
    doneLine,
    isDone,
    complete,
    routeOf,
    actionRefusal,
    targetName,
    stateTimes,
  };
}
