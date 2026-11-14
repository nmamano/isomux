// Secret requests (secrets loop, slice B4): an agent asks for a credential,
// and the member types the value in a masked form, so the value never enters
// the transcript. The agent gets the placeholder from its next start, and an
// office notice of the outcome; the member can decline.
//
// An open request is an ask (asks.ts, AskEntry.secret): it waits in the
// agent's asks stack for the member who may answer it and survives a
// restart. A save or a decline removes the ask; so does the agent's delete
// of the ask, which withdraws the request.
//
// A request can name an app (task 315a62c0): the value then goes to that
// app's environment, saved with its grant in the app owner's secrets (or
// the office's), and takes no hosts. A request can also name the member who
// answers. That member must be allowed to write the secrets the value goes
// to: their own, or any as an office owner. The rule is checked when the
// request opens and again, live, by askVisibleTo.
//
// No function here returns, logs or emits a value. The value goes from the
// save body to the secret store and nowhere else; the ask holds the request
// only.

import {
  knownValueRequest,
  type AskEntry,
  type SecretAskRequest,
} from "../shared/types.ts";
import { msg, type LogMessage } from "../shared/i18n/log-message.ts";
import {
  askVisibleTo,
  AsksUnavailableError,
  type AskAudienceDeps,
  type AskStore,
} from "./asks.ts";
import {
  isAppReservedSecretName,
  checkSecretExchange,
  checkSecretForm,
  checkSecretHosts,
  checkModelKeyHosts,
  checkSecretName,
  checkSecretValue,
  secretFieldErrorMessage,
  type ExchangeSpec,
  type SecretFieldError,
} from "../shared/secret-hosts.ts";
import { hasCredentialShape } from "./log-redaction.ts";
import { outsideLinkFor } from "../shared/office-links.ts";
import {
  mcpServerFailure,
  type ConnectionWrites,
  type McpServerRefusal,
} from "./connection-writes.ts";
import { isManagedEnvKey, ManagedEnvValidationError } from "./user-env.ts";
import {
  checkMcpServerName,
  checkMcpServerUrl,
} from "../shared/mcp-servers.ts";
import {
  SecretStoreUnreadableError,
  type SecretChange,
  type SecretScope,
  type SecretStore,
} from "./secret-store.ts";
import type { DiscordConnectResult } from "./discord/supervisor.ts";

export const SECRET_REQUEST_REASON_MAX = 500;
// A sanity bound, not a quota: one agent rarely has more than one open.
export const SECRET_REQUESTS_OPEN_MAX = 10;

export interface SecretRequestDeps {
  store: SecretStore;
  // The open requests.
  asks: AskStore;
  // Who sees and answers an ask (askVisibleTo).
  audience: AskAudienceDeps;
  // The secrets runtime's change hook (secrets.ts): pushes the new secret to
  // the proxy and releases the agents in scope, so their next start has it.
  onChanged?: () => Promise<void>;
  // The agent's manager: a user id, null for an unowned agent, undefined
  // when there is no such agent.
  agentUserId: (agentId: string) => string | null | undefined;
  // A live app by name (task 315a62c0): its registration binds the grant,
  // its owner is the scope of a personal request. Null when no live app has
  // the name.
  appFor: (
    name: string,
  ) => { name: string; createdAt: number; userId: string | null } | null;
  // A member by username (case-insensitive), or null.
  memberByName: (name: string) => { id: string; name: string } | null;
  // A member's name by id, or null when the member is gone.
  memberName: (userId: string) => string | null;
  // The variable and MCP server writes, as the Integrations routes make them
  // (task c71cb60f).
  writes: Pick<ConnectionWrites, "setVariable" | "createMcpServer">;
  // Whether the scope has a variable, or an MCP server, with this name.
  variableExists: (scope: SecretScope, name: string) => boolean;
  mcpServerExists: (scope: SecretScope, name: string) => boolean;
  // Connects a Discord bot for the member (supervisor.connect).
  connectDiscordBot: (
    userId: string,
    token: string,
  ) => Promise<DiscordConnectResult>;
  // The outcome: a system line in the agent's chat, and the same line to the
  // agent as an office notice from the member who answered.
  settled: (
    agentId: string,
    requestId: string,
    outcome: "saved" | "declined",
    line: LogMessage,
    answeredBy: string,
  ) => void;
}

export type SecretRequestFailure = {
  ok: false;
  status: 400 | 403 | 404 | 409 | 422 | 500;
  code: string;
  message?: string;
  detail?: Record<string, unknown>;
};

export type SecretRequestResult<T> = ({ ok: true } & T) | SecretRequestFailure;

type SecretAsk = AskEntry & { secret: SecretAskRequest };

function fieldFailure(error: SecretFieldError): SecretRequestFailure {
  const message = secretFieldErrorMessage(error);
  if (error.reason === "never_listed")
    return {
      ok: false,
      status: 422,
      code: "host_not_allowed",
      message,
      detail: { field: error.field, host: error.host },
    };
  return {
    ok: false,
    status: 400,
    code: "invalid_secret",
    message,
    detail: { field: error.field, reason: error.reason },
  };
}

function changeFailure(
  change: Exclude<SecretChange, { ok: true }>,
): SecretRequestFailure {
  if (change.kind === "invalid") return fieldFailure(change.error);
  if (change.kind === "exists")
    return {
      ok: false,
      status: 409,
      code: "secret_exists",
      message: "a secret with this name exists",
    };
  return { ok: false, status: 404, code: "not_found" };
}

function isObject(body: unknown): body is Record<string, unknown> {
  return !!body && typeof body === "object" && !Array.isArray(body);
}

const requestFailed: SecretRequestFailure = {
  ok: false,
  status: 500,
  code: "request_failed",
};

const invalidRequest = (message: string): SecretRequestFailure => ({
  ok: false,
  status: 400,
  code: "invalid_request",
  message,
});

function mcpFailure(change: McpServerRefusal): SecretRequestFailure {
  const { status, code, message, detail } = mcpServerFailure(change);
  return {
    ok: false,
    status: status as SecretRequestFailure["status"],
    code,
    ...(message !== undefined ? { message } : {}),
    ...(detail !== undefined ? { detail } : {}),
  };
}

const variableExists: SecretRequestFailure = {
  ok: false,
  status: 409,
  code: "variable_exists",
  message: "a variable with this name exists",
};

// The outcome line of a save, per kind: an office one, a member's (named),
// and a member's without a name. A save into a removed member's scope is
// refused (task 321e7b8e), so a save never writes the last one now; it stays
// for the log entries that hold it.
const SAVED_LINES = {
  secret: {
    office: "systemEntries.secretRequest.savedOffice",
    personal: "systemEntries.secretRequest.savedPersonal",
    plain: "systemEntries.secretRequest.saved",
  },
  variable: {
    office: "systemEntries.secretRequest.variableSavedOffice",
    personal: "systemEntries.secretRequest.variableSavedPersonal",
    plain: "systemEntries.secretRequest.variableSaved",
  },
  "mcp-server": {
    office: "systemEntries.secretRequest.mcpServerSavedOffice",
    personal: "systemEntries.secretRequest.mcpServerSavedPersonal",
    plain: "systemEntries.secretRequest.mcpServerSaved",
  },
} as const;

// What a refusal calls the kind, for the agent.
const KIND_NOUN = {
  secret: "secret",
  variable: "variable",
  "mcp-server": "MCP server",
  "discord-bot": "Discord bot",
} as const;

// The body keys an open takes, per kind.
const OPEN_KEYS = {
  secret: [
    "kind",
    "name",
    "hosts",
    "form",
    "exchange",
    "reason",
    "scope",
    "app",
    "member",
    "link",
  ],
  variable: ["kind", "name", "reason", "scope", "member", "link"],
  "mcp-server": [
    "kind",
    "name",
    "url",
    "secret",
    "oauth",
    "reason",
    "scope",
    "member",
    "link",
  ],
  // The manager's own bot: only the manager answers (task c92d60f4).
  // applicationId: the application the agent made in the member's browser
  // (task f242899f).
  "discord-bot": ["kind", "reason", "link", "applicationId"],
} as const satisfies Record<string, readonly string[]>;

// A Discord bot request's fixed name: one open request per member.
const DISCORD_BOT_NAME = "Discord bot";

// A Discord id (a snowflake): 17 to 20 digits.
const DISCORD_ID = /^\d{17,20}$/;

// What an older server's load check requires of every request, on the kinds
// it does not know (shared/types.ts).
const OLDER_LOADER_FIELDS = {
  hosts: [] as [],
  form: { kind: "authorization" as const },
};

export function createSecretRequests(deps: SecretRequestDeps) {
  // The save of a request for a secret that has no value: the request's
  // hosts, form and app, then the value. The value is checked first, so a
  // refused one changes nothing.
  function fillValue(
    scope: SecretScope,
    name: string,
    value: unknown,
    fields: Record<string, unknown>,
  ): SecretChange {
    const valueError = checkSecretValue(value);
    if (valueError) return { ok: false, kind: "invalid", error: valueError };
    const updated = deps.store.update(scope, name, fields);
    if (!updated.ok)
      return updated.kind === "host_added" ||
        updated.kind === "app_added" ||
        updated.kind === "exchange_changed"
        ? {
            ok: false,
            kind: "invalid",
            error: { field: "hosts", reason: "invalid" },
          }
        : updated;
    return deps.store.rotate(scope, name, value);
  }

  // The Discord bot requests whose connect runs now: a second save or a
  // decline waits for it (request_busy).
  const connecting = new Set<string>();

  const openRequests = (): SecretAsk[] =>
    deps.asks.listAll().filter((e): e is SecretAsk => e.secret !== undefined);

  // A personal request saves into the secrets of its owner (the manager,
  // or the app's owner); a request from before owners existed, into its
  // answerer's. An office request goes to the office's.
  function scopeOf(entry: SecretAsk): SecretScope | null {
    if (entry.secret.scope === "office") return { kind: "office" };
    const userId = entry.secret.ownerUserId ?? entry.memberUserId;
    return userId ? { kind: "user", userId } : null;
  }

  // Whether `name` in another scope already goes to `app`: the store
  // refuses such a grant (one app, one value per name). A scope that
  // cannot be read holds no grant that the check sees, as in the store.
  function clashes(scope: SecretScope, name: string, app: string): boolean {
    const key = (s: SecretScope) => (s.kind === "office" ? "" : s.userId);
    return deps.store.scopes().some((other) => {
      if (key(other) === key(scope)) return false;
      try {
        return deps.store
          .list(other)
          .some((s) => s.name === name && s.apps.includes(app));
      } catch (error) {
        if (error instanceof SecretStoreUnreadableError) return false;
        throw error;
      }
    });
  }

  // The request, when this member may answer it (askVisibleTo: the manager
  // for a personal secret, an office owner for an office one).
  function answerable(
    userId: string | null,
    agentId: string,
    requestId: string,
    audience: AskAudienceDeps = deps.audience,
  ): SecretRequestResult<{ entry: SecretAsk; scope: SecretScope }> {
    const entry = openRequests().find((e) => e.secret.requestId === requestId);
    if (!entry || entry.agentId !== agentId)
      return { ok: false, status: 404, code: "not_found" };
    const scope = scopeOf(entry);
    if (!scope || !askVisibleTo(entry, userId, audience))
      return { ok: false, status: 403, code: "forbidden" };
    return { ok: true, entry, scope };
  }

  // An unavailable asks store is the request's failure, never a throw.
  function guarded<T>(
    run: () => SecretRequestResult<T>,
  ): SecretRequestResult<T> {
    try {
      return run();
    } catch (err) {
      if (err instanceof AsksUnavailableError) return requestFailed;
      throw err;
    }
  }

  // What a save says, by kind: its scope, and the member for a personal
  // one. An app secret's line names the app instead (save).
  function savedLine(
    kind: "secret" | "variable" | "mcp-server",
    scope: SecretScope,
    name: string,
  ): LogMessage {
    const keys = SAVED_LINES[kind];
    if (scope.kind === "office") return msg(keys.office, { name });
    const member = deps.memberName(scope.userId);
    return member
      ? msg(keys.personal, { name, member })
      : msg(keys.plain, { name });
  }

  // The saved value's ask goes. If the removal fails, the value is saved,
  // so the agent still hears it; the ask stays until the store can write,
  // and a second save gets the kind's exists code.
  function closeSaved(entry: SecretAsk, userId: string): void {
    try {
      deps.asks.remove(entry.id, { outcome: "saved", byUserId: userId });
    } catch {
      console.error(
        `[secret-requests] ask ${entry.id} was saved but could not be closed`,
      );
    }
  }

  // A Discord bot request's save: the token goes to the connect only. The
  // connect awaits Discord, so the request is busy until it ends. On a
  // refusal the ask stays for the member to type again. The ask may be gone
  // when the connect ends (the agent withdrew it): the bot is connected, and
  // the agent still hears of it.
  async function connectBot(
    entry: SecretAsk,
    userId: string,
    ownerId: string,
    body: Record<string, unknown>,
  ): Promise<SecretRequestResult<{ name: string }>> {
    if (!Object.keys(body).every((k) => k === "value"))
      return invalidRequest("the body takes only value");
    if (typeof body.value !== "string" || body.value.trim() === "")
      return invalidRequest("value is required");
    const { requestId, name } = entry.secret;
    connecting.add(requestId);
    let result: DiscordConnectResult;
    try {
      result = await deps.connectDiscordBot(ownerId, body.value);
    } catch {
      console.error("[secret-requests] a Discord bot connect failed");
      result = {
        ok: false,
        status: 400,
        code: "check_failed",
        error: "Discord could not check this token; try again",
      };
    } finally {
      connecting.delete(requestId);
    }
    if (!result.ok)
      return {
        ok: false,
        status: result.status,
        code: result.code,
        message: result.error,
      };
    closeSaved(entry, userId);
    deps.settled(
      entry.agentId,
      requestId,
      "saved",
      msg("systemEntries.secretRequest.discordBotConnected", {
        bot: result.bot.name,
        member: deps.memberName(ownerId) ?? ownerId,
      }),
      userId,
    );
    return { ok: true, name };
  }

  const busy: SecretRequestFailure = {
    ok: false,
    status: 409,
    code: "request_busy",
    message: "a save of this request is running; wait for its answer",
  };

  // A variable request's save: the value alone, never over a variable set
  // since the open. No answer or log holds the value.
  function writeVariable(
    scope: SecretScope,
    name: string,
    body: Record<string, unknown>,
  ): SecretRequestResult<object> {
    if (!Object.keys(body).every((k) => k === "value"))
      return invalidRequest("the body takes only value");
    if (typeof body.value !== "string" || body.value === "")
      return invalidRequest("value is required");
    if (deps.variableExists(scope, name)) return variableExists;
    try {
      const outcome = deps.writes.setVariable(scope, name, body.value);
      if (!outcome.ok)
        return {
          ok: false,
          status: outcome.status as SecretRequestFailure["status"],
          code: outcome.code,
          ...(outcome.message !== undefined
            ? { message: outcome.message }
            : {}),
        };
    } catch (error) {
      if (error instanceof ManagedEnvValidationError)
        return {
          ok: false,
          status: 400,
          code: "invalid_env",
          message: "the value is not valid",
        };
      throw error;
    }
    return { ok: true };
  }

  // An MCP server request's save: the URL and the sign-in (a secret, OAuth
  // or none) as the member set them, checked as the Integrations page checks
  // them. No answer or log holds the URL, which can carry a token.
  function writeMcpServer(
    scope: SecretScope,
    name: string,
    body: Record<string, unknown>,
  ): SecretRequestResult<object> {
    if (
      !Object.keys(body).every(
        (k) => k === "url" || k === "secret" || k === "oauth",
      )
    )
      return invalidRequest("the body takes only url, secret, oauth");
    if (typeof body.url !== "string") return invalidRequest("url is required");
    const secret = body.secret ?? null;
    if (secret !== null && typeof secret !== "string")
      return invalidRequest("secret must be a secret name or null");
    if (body.oauth !== undefined && body.oauth !== true)
      return invalidRequest("oauth must be true");
    const oauth = body.oauth === true;
    if (oauth && secret !== null)
      return invalidRequest("an OAuth server takes no secret");
    const result = deps.writes.createMcpServer(scope, {
      name,
      url: body.url,
      secret,
      // No pasted client: the server registers one at the sign-in.
      ...(oauth ? { oauth: {} } : {}),
    });
    if (!result.ok) return invalidRequest("the request has the wrong shape");
    if (!result.change.ok) return mcpFailure(result.change);
    return { ok: true };
  }

  // The agent's ask. Checks what the store would check, so the member never
  // gets a form that cannot be saved as it stands.
  function open(
    agentId: string,
    body: unknown,
  ): SecretRequestResult<{ requestId: string }> {
    if (!isObject(body)) return invalidRequest("the body must be an object");
    const kind = body.kind === undefined ? "secret" : body.kind;
    if (
      kind !== "secret" &&
      kind !== "variable" &&
      kind !== "mcp-server" &&
      kind !== "discord-bot"
    )
      return invalidRequest(
        "kind is secret, variable, mcp-server or discord-bot",
      );
    const allowed: readonly string[] = OPEN_KEYS[kind];
    if (!Object.keys(body).every((key) => allowed.includes(key)))
      return invalidRequest(`the body takes only ${allowed.join(", ")}`);
    const managerId = deps.agentUserId(agentId);
    if (managerId === undefined)
      return { ok: false, status: 404, code: "not_found" };
    if (kind === "discord-bot" && !managerId)
      return {
        ok: false,
        status: 409,
        code: "no_manager",
        message: "this agent has no manager to connect a Discord bot for",
      };
    const scopeName = body.scope ?? "personal";
    if (scopeName !== "personal" && scopeName !== "office")
      return invalidRequest("scope is personal or office");
    if (body.app !== undefined && typeof body.app !== "string")
      return invalidRequest("app must be an app name");
    if (body.member !== undefined && typeof body.member !== "string")
      return invalidRequest("member must be a username");
    if (
      body.app !== undefined &&
      body.hosts !== undefined &&
      !(Array.isArray(body.hosts) && body.hosts.length === 0)
    )
      return invalidRequest(
        "a request for an app takes no hosts: the app reads the value from its environment",
      );
    const app = body.app === undefined ? null : deps.appFor(body.app);
    if (body.app !== undefined && !app)
      return {
        ok: false,
        status: 422,
        code: "unknown_app",
        message: "no app has this name",
      };
    // The member whose secrets get the value: the app's owner for an app,
    // else the manager.
    let ownerId: string | undefined;
    if (scopeName === "personal") {
      if (app) {
        if (!app.userId)
          return {
            ok: false,
            status: 409,
            code: "no_app_owner",
            message:
              "this app has no owner, so ask for an office secret instead",
          };
        ownerId = app.userId;
      } else if (!managerId)
        return {
          ok: false,
          status: 409,
          code: "no_member",
          message:
            "this agent has no manager, so ask for an office secret instead",
        };
      else ownerId = managerId;
    }
    // The member who answers: the one named, else the manager for a
    // personal request and every office owner for an office one.
    let answerId: string | undefined;
    if (body.member !== undefined) {
      const member = deps.memberByName(body.member);
      if (!member)
        return {
          ok: false,
          status: 422,
          code: "unknown_member",
          message: "no member has this username",
        };
      const roomId = deps.audience.agentRoomId(agentId);
      if (roomId === null || !deps.audience.canSeeRoom(member.id, roomId))
        return {
          ok: false,
          status: 422,
          code: "member_no_access",
          message: "that member cannot reach this agent's room",
        };
      answerId = member.id;
    } else if (scopeName === "personal") {
      if (!managerId)
        return {
          ok: false,
          status: 409,
          code: "no_manager",
          message: "this agent has no manager, so name a member",
        };
      answerId = managerId;
    }
    if (
      answerId !== undefined &&
      answerId !== ownerId &&
      !deps.audience.isOfficeOwner(answerId)
    )
      return {
        ok: false,
        status: 403,
        code: "member_not_allowed",
        message:
          scopeName === "office"
            ? `only an office owner can save an office ${KIND_NOUN[kind]}`
            : `only the member whose ${KIND_NOUN[kind]}s get the value, or an office owner, can save it`,
      };
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason || reason.length > SECRET_REQUEST_REASON_MAX)
      return invalidRequest(
        `reason is required, at most ${SECRET_REQUEST_REASON_MAX} characters`,
      );
    if (hasCredentialShape(reason))
      return invalidRequest("the reason must not hold a credential");
    // The page where the member gets the value (task 0355f4b7).
    if (
      body.link !== undefined &&
      (!outsideLinkFor(body.link) || hasCredentialShape(body.link as string))
    )
      return invalidRequest(
        "link must be an https URL of the page where the member gets the value, with no credential in it",
      );
    const scope: SecretScope =
      ownerId === undefined
        ? { kind: "office" }
        : { kind: "user", userId: ownerId };
    const base = {
      requestId: crypto.randomUUID(),
      scope:
        scopeName === "office" ? ("office" as const) : ("personal" as const),
      reason,
      ...(body.link !== undefined ? { link: body.link as string } : {}),
      ...(ownerId !== undefined ? { ownerUserId: ownerId } : {}),
      // An office request for one owner names them here, never in
      // memberUserId: an older server refuses an office ask with a member,
      // and would set its whole asks file aside after a rollback.
      ...(scopeName === "office" && answerId !== undefined
        ? { answerUserId: answerId }
        : {}),
    };
    let secret: SecretAskRequest;
    if (kind === "secret") {
      const nameError = checkSecretName(body.name);
      if (nameError) return fieldFailure(nameError);
      const name = body.name as string;
      if (hasCredentialShape(name))
        return fieldFailure({ field: "name", reason: "invalid" });
      if (app && isAppReservedSecretName(name))
        return fieldFailure({ field: "name", reason: "reserved" });
      // An app request has no hosts (refused above).
      const hosts = app
        ? { ok: true as const, hosts: [] }
        : checkSecretHosts(body.hosts);
      if (!hosts.ok) return fieldFailure(hosts.error);
      const modelKey = checkModelKeyHosts(name, hosts.hosts);
      if (modelKey) return fieldFailure(modelKey);
      // A proposed token exchange, checked as the store checks it.
      let exchange: ExchangeSpec | undefined;
      if (body.exchange !== undefined) {
        const checked = checkSecretExchange(body.exchange, hosts.hosts);
        if (!checked.ok) return fieldFailure(checked.error);
        exchange = checked.exchange;
      }
      const form = checkSecretForm(body.form ?? { kind: "authorization" }, {
        exchange: exchange !== undefined,
      });
      if (!form.ok) return fieldFailure(form.error);
      // A restored member's secret without a value (task 321e7b8e) is the
      // one name a request may fill.
      if (
        deps.store
          .list(scope)
          .some((secret) => secret.name === name && !secret.needsValue)
      )
        return changeFailure({ ok: false, kind: "exists" });
      if (app && clashes(scope, name, app.name))
        return fieldFailure({ field: "apps", reason: "clash" });
      secret = {
        ...base,
        name,
        hosts: hosts.hosts,
        form: form.form,
        ...(exchange ? { exchange } : {}),
        ...(app ? { app: { name: app.name, createdAt: app.createdAt } } : {}),
      };
    } else if (kind === "variable") {
      const name = body.name;
      if (
        typeof name !== "string" ||
        !isManagedEnvKey(name) ||
        hasCredentialShape(name)
      )
        return invalidRequest("name must be a variable name");
      if (deps.variableExists(scope, name)) return variableExists;
      secret = { ...base, kind, name, ...OLDER_LOADER_FIELDS };
    } else if (kind === "discord-bot") {
      const applicationId = body.applicationId;
      if (
        applicationId !== undefined &&
        (typeof applicationId !== "string" || !DISCORD_ID.test(applicationId))
      )
        return invalidRequest("applicationId must be a Discord id");
      secret = {
        ...base,
        kind,
        name: DISCORD_BOT_NAME,
        ...(applicationId !== undefined ? { applicationId } : {}),
        ...OLDER_LOADER_FIELDS,
      };
    } else {
      const nameError = checkMcpServerName(body.name);
      if (nameError)
        return mcpFailure({ ok: false, kind: "invalid", error: nameError });
      const name = body.name as string;
      if (hasCredentialShape(name))
        return invalidRequest("name must be an MCP server name");
      if (body.secret !== undefined && typeof body.secret !== "string")
        return invalidRequest("secret must be a secret name");
      if (body.oauth !== undefined && body.oauth !== true)
        return invalidRequest("oauth must be true");
      const oauth = body.oauth === true;
      const proposedSecret = body.secret;
      if (oauth && proposedSecret !== undefined)
        return invalidRequest("an OAuth server takes no secret");
      if (body.url !== undefined) {
        // A server that signs in sends a credential: a secret's URL rules.
        const url = checkMcpServerUrl(
          body.url,
          proposedSecret !== undefined || oauth,
        );
        if (!url.ok)
          return mcpFailure({ ok: false, kind: "invalid", error: url.error });
      }
      // The host need not match yet: the member can change the URL.
      if (
        proposedSecret !== undefined &&
        !deps.store.list(scope).some((s) => s.name === proposedSecret)
      )
        return mcpFailure({ ok: false, kind: "secret_not_found" });
      if (deps.mcpServerExists(scope, name))
        return mcpFailure({ ok: false, kind: "exists" });
      secret = {
        ...base,
        kind,
        name,
        ...(body.url !== undefined ? { url: body.url as string } : {}),
        ...(proposedSecret !== undefined ? { secret: proposedSecret } : {}),
        ...(oauth ? { oauth: true as const } : {}),
        ...OLDER_LOADER_FIELDS,
      };
    }
    const { name } = secret;
    const open = openRequests();
    // One open request per secret, variable or server, whichever agent
    // asks: a second ask would put a second form for the same value in front
    // of a member.
    if (
      open.some(
        (e) =>
          e.secret.kind === secret.kind &&
          e.secret.name === name &&
          e.secret.scope === scopeName &&
          (scopeName === "office" ||
            (e.secret.ownerUserId ?? e.memberUserId) === ownerId),
      )
    )
      return {
        ok: false,
        status: 409,
        code: "request_open",
        message: "a request for this secret is open",
      };
    const tooMany: SecretRequestFailure = {
      ok: false,
      status: 409,
      code: "too_many_requests",
      message: `at most ${SECRET_REQUESTS_OPEN_MAX} open requests per agent`,
    };
    if (
      open.filter((e) => e.agentId === agentId).length >=
      SECRET_REQUESTS_OPEN_MAX
    )
      return tooMany;
    // The ask's own bound (all of the agent's asks) answers as this one.
    const made = deps.asks.create({
      agentId,
      ...(scopeName === "personal" ? { memberUserId: answerId } : {}),
      prompt: reason,
      secret,
    });
    if (!made.ok) return tooMany;
    return { ok: true, requestId: secret.requestId };
  }

  return {
    open: (agentId: string, body: unknown) =>
      guarded(() => open(agentId, body)),

    // The member's save: the value, and the hosts and form as the member
    // edited them.
    async save(
      userId: string | null,
      agentId: string,
      requestId: string,
      body: unknown,
      // The caller's audience (askAudienceFor), when it differs from the
      // member's.
      audience?: AskAudienceDeps,
    ): Promise<SecretRequestResult<{ name: string }>> {
      // From the check to the ask's removal nothing awaits, so a decline,
      // a second save or the agent's withdraw cannot slip in between. The
      // one exception is a Discord bot's connect, which marks the request
      // busy until it ends (connectBot).
      const found = guarded(() =>
        answerable(userId, agentId, requestId, audience),
      );
      if (!found.ok) return found;
      if (!isObject(body)) return invalidRequest("the body must be an object");
      const { entry, scope } = found;
      if (connecting.has(requestId)) return busy;
      // A removed member's request waits for their restore (task
      // 321e7b8e): a value saved now would come back with them, set by
      // someone else.
      if (scope.kind === "user" && deps.memberName(scope.userId) === null)
        return {
          ok: false,
          status: 409,
          code: "member_removed",
          message: "the member was removed; restore them before you save",
        };
      const request = entry.secret;
      if (!knownValueRequest(request))
        return {
          ok: false,
          status: 409,
          code: "request_unsupported",
          message: "this server cannot save this request; decline it",
        };
      if (request.kind === "discord-bot")
        return scope.kind === "user"
          ? connectBot(entry, userId as string, scope.userId, body)
          : invalidRequest("a Discord bot request is personal");
      if (request.kind !== undefined) {
        const written =
          request.kind === "variable"
            ? writeVariable(scope, request.name, body)
            : writeMcpServer(scope, request.name, body);
        if (!written.ok) return written;
        closeSaved(entry, userId as string);
        deps.settled(
          agentId,
          requestId,
          "saved",
          savedLine(request.kind, scope, request.name),
          userId as string,
        );
        return { ok: true, name: request.name };
      }
      if (
        !Object.keys(body).every((k) =>
          ["value", "hosts", "form", "exchange"].includes(k),
        )
      )
        return invalidRequest(
          "the body takes only value, hosts, form, exchange",
        );
      const { name, app } = request;
      if (
        app &&
        body.hosts !== undefined &&
        !(Array.isArray(body.hosts) && body.hosts.length === 0)
      )
        return invalidRequest("a request for an app takes no hosts");
      // The app the request named, still the same registration, and for a
      // member secret still that member's (a member secret goes only to an
      // app its member owns).
      if (app) {
        const live = deps.appFor(app.name);
        if (
          !live ||
          live.createdAt !== app.createdAt ||
          (scope.kind === "user" && live.userId !== scope.userId)
        )
          return {
            ok: false,
            status: 409,
            code: "app_gone",
            message:
              "the app was removed or replaced since the request; decline it",
          };
      }
      // The exchange as the member left it in the form: null removes the
      // proposed one.
      const exchange =
        body.exchange === undefined ? request.exchange : body.exchange;
      const fields = {
        hosts: app ? [] : (body.hosts ?? entry.secret.hosts),
        form: body.form ?? entry.secret.form,
        ...(exchange ? { exchange } : {}),
        ...(app
          ? { apps: [{ name: app.name, createdAt: app.createdAt }] }
          : {}),
      };
      const needsValue = deps.store
        .list(scope)
        .some((secret) => secret.name === name && secret.needsValue);
      const change = needsValue
        ? fillValue(scope, name, body.value, {
            ...fields,
            exchange: exchange ?? null,
          })
        : deps.store.create(scope, { name, value: body.value, ...fields });
      if (!change.ok) return changeFailure(change);
      closeSaved(entry, userId as string);
      try {
        await deps.onChanged?.();
      } catch {
        console.error("[secret-requests] the proxy did not take a change");
      }
      deps.settled(
        agentId,
        requestId,
        "saved",
        app
          ? msg("systemEntries.secretRequest.savedForApp", {
              name,
              app: app.name,
            })
          : savedLine("secret", scope, name),
        userId as string,
      );
      return { ok: true, name };
    },

    decline(
      userId: string | null,
      agentId: string,
      requestId: string,
      audience?: AskAudienceDeps,
    ): SecretRequestResult<{ name: string }> {
      return guarded(() => {
        const found = answerable(userId, agentId, requestId, audience);
        if (!found.ok) return found;
        if (connecting.has(requestId)) return busy;
        const { name } = found.entry.secret;
        try {
          deps.asks.remove(found.entry.id, {
            outcome: "declined",
            byUserId: userId as string,
          });
        } catch {
          return requestFailed;
        }
        deps.settled(
          agentId,
          requestId,
          "declined",
          msg("systemEntries.secretRequest.declined", { name }),
          userId as string,
        );
        return { ok: true, name };
      });
    },
  };
}

export type SecretRequests = ReturnType<typeof createSecretRequests>;
