// Step asks of the link kinds (task c71cb60f): the member does the step
// on the Integrations tab the ask links to. One family of
// server/step-asks.ts (STEP_FAMILY in server/step-asks-common.ts).

import type { AskStep } from "../shared/types.ts";
import { msg, type LogMessage } from "../shared/i18n/log-message.ts";
import type { SecretScope } from "./secret-store.ts";
import type { StepAskDeps, StepFailure } from "./step-asks.ts";
import {
  invalid,
  notAllowed,
  type CompleteInput,
  type FamilyStep,
  type StepFamily,
} from "./step-asks-common.ts";

type S = FamilyStep<"links">;

const PROVIDER_LABELS = { claude: "Claude", codex: "Codex" } as const;

// The secrets scope of an MCP sign-in step.
function mcpScope(
  step: Extract<AskStep, { kind: "mcp-sign-in" }>,
): SecretScope | null {
  if (step.scope === "office") return { kind: "office" };
  return step.ownerUserId ? { kind: "user", userId: step.ownerUserId } : null;
}

// What the agent reads when the step is done. `target` names the agent or
// member an action step changes.
function doneLine(step: S, _target: string): LogMessage {
  switch (step.kind) {
    case "provider-sign-in":
      return step.scope === "office"
        ? msg("systemEntries.stepAsk.providerSignedInOffice", {
            provider: PROVIDER_LABELS[step.provider],
          })
        : msg("systemEntries.stepAsk.providerSignedIn", {
            provider: PROVIDER_LABELS[step.provider],
          });
    case "mcp-sign-in":
      return msg("systemEntries.stepAsk.mcpSignedIn", { name: step.name });
    case "browser-pairing":
      return msg("systemEntries.stepAsk.browserPaired");
    case "github-link":
      return msg("systemEntries.stepAsk.githubLinked");
  }
}

export function createLinkSteps(deps: StepAskDeps): StepFamily<S> {
  // Whether the step is done now, for the member the ask is for (isDone in
  // server/step-asks.ts).
  async function isDone(
    step: S,
    memberUserId: string,
    _since: number | null,
  ): Promise<boolean> {
    switch (step.kind) {
      case "provider-sign-in":
        return deps.providerConnected(memberUserId, step.provider, step.scope);
      case "mcp-sign-in": {
        const scope = mcpScope(step);
        return !!scope && !!deps.mcpServer(scope, step.name)?.signedIn;
      }
      case "browser-pairing":
        return deps.browserPaired(memberUserId);
      case "github-link":
        return deps.roomLinked(step.roomId);
    }
  }

  // The step as the agent sent it, completed, or why it is refused. The
  // core checked its kind, its keys and its scope.
  function complete(
    body: Record<string, unknown>,
    kind: S["kind"],
    input: CompleteInput,
  ): { ok: true; step: AskStep } | StepFailure {
    const { memberUserId, managerUserId, scope, owner } = input;
    switch (kind) {
      case "provider-sign-in": {
        const provider = body.provider;
        if (provider !== "claude" && provider !== "codex")
          return invalid("step.provider is claude or codex");
        if (scope === "personal") {
          // The agent runs on its manager's own sign-in.
          if (memberUserId !== managerUserId)
            return invalid(
              "a personal sign-in is the manager's own: ask your manager",
            );
        } else if (!owner)
          return notAllowed("only an office owner can sign in the office");
        return {
          ok: true,
          step: { kind, provider, scope: scope as "personal" | "office" },
        };
      }
      case "mcp-sign-in": {
        if (typeof body.name !== "string" || body.name === "")
          return invalid("step.name is an MCP server name");
        if (scope === "office") {
          if (!owner)
            return notAllowed(
              "only an office owner can sign in to an office MCP server",
            );
          return {
            ok: true,
            step: { kind, name: body.name, scope: "office" },
          };
        }
        if (!managerUserId)
          return {
            ok: false,
            status: 409,
            code: "no_manager",
            message:
              "this agent has no manager, so it has no personal MCP servers",
          };
        if (memberUserId !== managerUserId && !owner)
          return notAllowed(
            "only the manager or an office owner can sign in to the manager's MCP server",
          );
        return {
          ok: true,
          step: {
            kind,
            name: body.name,
            scope: "personal",
            ownerUserId: managerUserId,
          },
        };
      }
      case "browser-pairing":
        // The agent uses its manager's paired Chrome.
        if (memberUserId !== managerUserId)
          return invalid("the browser is the manager's: ask your manager");
        return { ok: true, step: { kind } };
      case "github-link":
        if (!owner)
          return notAllowed("only an office owner can link a room to GitHub");
        return { ok: true, step: { kind, roomId: input.roomId } };
    }
  }

  // The create's check right after the step is completed: an MCP
  // sign-in names a server of the scope that signs in with OAuth.
  function afterComplete(step: S): StepFailure | null {
    if (step.kind === "mcp-sign-in") {
      const scope = mcpScope(step);
      const server = scope ? deps.mcpServer(scope, step.name) : null;
      if (!server)
        return {
          ok: false,
          status: 422,
          code: "unknown_mcp_server",
          message: "no MCP server of this name in that scope",
        };
      if (!server.oauth)
        return {
          ok: false,
          status: 409,
          code: "not_oauth",
          message: "this MCP server does not sign in with OAuth",
        };
    }
    return null;
  }

  return { doneLine, isDone, complete, afterComplete };
}
