// Step asks (task c71cb60f): an agent asks the member to do a step on the
// Integrations page that is not a typed value (a provider sign-in, an MCP
// OAuth sign-in, a browser pairing, a room's GitHub link). The ask is a
// plain ask with a `step` and a link the server sets, so the member can
// still reply, dismiss or file it. It closes itself when the step is done.
//
// One predicate per kind (isStepDone) reads the current state. The create
// refuses a step that is done (409 step_done), and every hook that may have
// done one calls reconcile, which closes each open step ask whose predicate
// holds. A hook says only that something changed.

import type {
  AskEntry,
  ProviderAccountProvider,
  ProviderAccountScope,
  StepAskRequest,
} from "../shared/types.ts";
import { msg, type LogMessage } from "../shared/i18n/log-message.ts";
import type { AskStore } from "./asks.ts";
import type { SecretScope } from "./secret-store.ts";

export interface StepAskDeps {
  asks: AskStore;
  isOfficeOwner: (userId: string) => boolean;
  // The current state each predicate reads.
  providerConnected: (
    userId: string,
    provider: ProviderAccountProvider,
    scope: ProviderAccountScope,
  ) => Promise<boolean>;
  // An MCP server of the scope: whether it signs in with OAuth, and whether
  // it holds a sign-in. Null when the scope has no server of this name.
  mcpServer: (
    scope: SecretScope,
    name: string,
  ) => { oauth: boolean; signedIn: boolean } | null;
  browserPaired: (userId: string) => boolean;
  roomLinked: (roomId: string) => boolean;
  // The step is done: a system line in the agent's chat, and the same line
  // to the agent as an office notice from the member the ask is for.
  settled: (
    agentId: string,
    askId: string,
    line: LogMessage,
    memberUserId: string,
  ) => void;
}

export type StepCheck =
  | { ok: true; step: StepAskRequest; link: string }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 422;
      code: string;
      message: string;
    };

type StepFailure = Extract<StepCheck, { ok: false }>;

const STEP_LINKS: Record<StepAskRequest["kind"], string> = {
  "provider-sign-in": "/integrations/providers",
  "mcp-sign-in": "/integrations/mcp",
  "browser-pairing": "/integrations/browser",
  "github-link": "/integrations/github",
};

// The Integrations tab a step's link opens (one of OFFICE_LINK_PATHS).
export function stepLink(step: StepAskRequest): string {
  return STEP_LINKS[step.kind];
}

// The fields an agent may send, per kind. The server fills ownerUserId and
// roomId.
const STEP_KEYS: Record<StepAskRequest["kind"], readonly string[]> = {
  "provider-sign-in": ["kind", "provider", "scope"],
  "mcp-sign-in": ["kind", "name", "scope"],
  "browser-pairing": ["kind"],
  "github-link": ["kind"],
};

const PROVIDER_LABELS = { claude: "Claude", codex: "Codex" } as const;

const invalid = (message: string): StepFailure => ({
  ok: false,
  status: 400,
  code: "invalid_request",
  message,
});

const notAllowed = (message: string): StepFailure => ({
  ok: false,
  status: 403,
  code: "member_not_allowed",
  message,
});

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isKnownKind = (kind: unknown): kind is StepAskRequest["kind"] =>
  typeof kind === "string" && Object.hasOwn(STEP_KEYS, kind);

type StepEntry = AskEntry & { step: StepAskRequest };

// The secrets scope of an MCP sign-in step.
function mcpScope(
  step: Extract<StepAskRequest, { kind: "mcp-sign-in" }>,
): SecretScope | null {
  if (step.scope === "office") return { kind: "office" };
  return step.ownerUserId ? { kind: "user", userId: step.ownerUserId } : null;
}

// What the agent reads when the step is done.
function doneLine(step: StepAskRequest): LogMessage {
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

export function createStepAsks(deps: StepAskDeps) {
  // Whether the step is done now, for the member the ask is for. A kind
  // from a later release is never done here.
  async function isDone(
    step: StepAskRequest,
    memberUserId: string,
  ): Promise<boolean> {
    if (!isKnownKind(step.kind)) return false;
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

  // The step as the agent sent it, completed, or why it is refused.
  function complete(input: {
    step: unknown;
    roomId: string;
    managerUserId: string | null;
    memberUserId: string;
  }): { ok: true; step: StepAskRequest } | StepFailure {
    const { step: body, memberUserId, managerUserId } = input;
    if (!isObject(body)) return invalid("step must be an object");
    if (!isKnownKind(body.kind))
      return invalid(
        `step.kind is one of ${Object.keys(STEP_KEYS).join(", ")}`,
      );
    const kind = body.kind;
    const allowed = STEP_KEYS[kind];
    if (!Object.keys(body).every((key) => allowed.includes(key)))
      return invalid(`a ${kind} step takes only ${allowed.join(", ")}`);
    const scope = body.scope ?? "personal";
    if (kind !== "browser-pairing" && kind !== "github-link")
      if (scope !== "personal" && scope !== "office")
        return invalid("step.scope is personal or office");
    const owner = deps.isOfficeOwner(memberUserId);
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

  // Closes one ask whose step is done: the first close settles it, and an
  // ask that went meanwhile (an answer, the agent's delete, another
  // reconcile) is not settled again.
  function close(entry: StepEntry): void {
    let removed: AskEntry | null;
    try {
      removed = deps.asks.remove(entry.id);
    } catch {
      console.error(`[step-asks] ask ${entry.id} could not be closed`);
      return;
    }
    if (!removed || !removed.memberUserId) return;
    deps.settled(
      entry.agentId,
      entry.id,
      doneLine(entry.step),
      removed.memberUserId,
    );
  }

  return {
    // The `step` of an ask create, checked and completed. `memberUserId` is
    // the member the ask is for (the one named, else the manager);
    // `memberNamed` whether the agent named one. Naming the manager is the
    // same as naming no one, so only memberUserId is read.
    async check(input: {
      step: unknown;
      roomId: string;
      managerUserId: string | null;
      memberUserId: string;
      memberNamed: boolean;
    }): Promise<StepCheck> {
      const completed = complete(input);
      if (!completed.ok) return completed;
      const { step } = completed;
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
      if (await isDone(step, input.memberUserId))
        return {
          ok: false,
          status: 409,
          code: "step_done",
          message: "this step is done",
        };
      return { ok: true, step, link: stepLink(step) };
    },

    // Whether the step of an open ask is done now.
    isStepDone(entry: StepEntry): Promise<boolean> {
      return entry.memberUserId
        ? isDone(entry.step, entry.memberUserId)
        : Promise.resolve(false);
    },

    // Closes every open step ask whose step is done. Never throws: a
    // predicate that fails leaves its ask open.
    async reconcile(): Promise<void> {
      let open: StepEntry[];
      try {
        open = deps.asks
          .listAll()
          .filter((e): e is StepEntry => e.step !== undefined);
      } catch {
        return;
      }
      await Promise.all(
        open.map(async (entry) => {
          try {
            if (!entry.memberUserId) return;
            if (await isDone(entry.step, entry.memberUserId)) close(entry);
          } catch {
            console.error(
              `[step-asks] ask ${entry.id}: the step could not be read`,
            );
          }
        }),
      );
    },
  };
}

export type StepAsks = ReturnType<typeof createStepAsks>;
