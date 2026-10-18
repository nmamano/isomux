// Secret requests (secrets loop, slice B4): an agent asks for a credential,
// and the member types the value in a masked form, so the value never enters
// the transcript. The agent gets the placeholder and a confirmation; the
// member can decline.
//
// An open request is an ask (asks.ts, AskEntry.secret): it waits in the
// agent's asks stack for the member who may answer it and survives a
// restart. A save or a decline removes the ask; so does the agent's delete
// of the ask, which withdraws the request.
//
// No function here returns, logs or emits a value. The value goes from the
// save body to the secret store and nowhere else; the ask holds the request
// only.

import type { AskEntry, SecretAskRequest } from "../shared/types.ts";
import {
  askVisibleTo,
  AsksUnavailableError,
  type AskAudienceDeps,
  type AskStore,
} from "./asks.ts";
import {
  checkSecretForm,
  checkSecretHosts,
  checkSecretName,
  SECRET_MIN_VALUE_LENGTH,
  type SecretFieldError,
} from "../shared/secret-hosts.ts";
import { hasCredentialShape } from "./log-redaction.ts";
import type { SecretChange, SecretScope, SecretStore } from "./secret-store.ts";

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
  placeholderOf: (scope: SecretScope, name: string) => string | null;
  // The agent's manager: a user id, null for an unowned agent, undefined
  // when there is no such agent.
  agentUserId: (agentId: string) => string | null | undefined;
  // The system entry that records the outcome in the agent's chat.
  emitSettled: (
    agentId: string,
    requestId: string,
    outcome: "saved" | "declined",
    name: string,
  ) => void;
  // A message to the agent from the member who answered.
  tellAgent: (agentId: string, userId: string, text: string) => void;
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
  if (error.reason === "never_listed")
    return {
      ok: false,
      status: 422,
      code: "host_not_allowed",
      message: `${error.host} never receives a secret: model and package registry hosts are on the never-list`,
      detail: { field: error.field, host: error.host },
    };
  return {
    ok: false,
    status: 400,
    code: "invalid_secret",
    message:
      error.reason === "too_short"
        ? `the value must have at least ${SECRET_MIN_VALUE_LENGTH} characters`
        : `the ${error.field} field is not valid`,
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

export function createSecretRequests(deps: SecretRequestDeps) {
  const openRequests = (): SecretAsk[] =>
    deps.asks.listAll().filter((e): e is SecretAsk => e.secret !== undefined);

  // A personal request is for the agent's manager when it opened, saved in
  // that member's secrets; an office request goes to the office's.
  function scopeOf(entry: SecretAsk): SecretScope | null {
    if (entry.secret.scope === "office") return { kind: "office" };
    return entry.memberUserId
      ? { kind: "user", userId: entry.memberUserId }
      : null;
  }

  // The request, when this member may answer it (askVisibleTo: the manager
  // for a personal secret, an office owner for an office one).
  function answerable(
    userId: string | null,
    agentId: string,
    requestId: string,
  ): SecretRequestResult<{ entry: SecretAsk; scope: SecretScope }> {
    const entry = openRequests().find((e) => e.secret.requestId === requestId);
    if (!entry || entry.agentId !== agentId)
      return { ok: false, status: 404, code: "not_found" };
    const scope = scopeOf(entry);
    if (!scope || !askVisibleTo(entry, userId, deps.audience))
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

  // The agent's ask. Checks what the store would check, so the member never
  // gets a form that cannot be saved as it stands.
  function open(
    agentId: string,
    body: unknown,
  ): SecretRequestResult<{ requestId: string }> {
    if (!isObject(body)) return invalidRequest("the body must be an object");
    const allowed = ["name", "hosts", "form", "reason", "scope"];
    if (!Object.keys(body).every((key) => allowed.includes(key)))
      return invalidRequest(`the body takes only ${allowed.join(", ")}`);
    const userId = deps.agentUserId(agentId);
    if (userId === undefined)
      return { ok: false, status: 404, code: "not_found" };
    const scopeName = body.scope ?? "personal";
    if (scopeName !== "personal" && scopeName !== "office")
      return invalidRequest("scope is personal or office");
    if (scopeName === "personal" && !userId)
      return {
        ok: false,
        status: 409,
        code: "no_member",
        message:
          "this agent has no manager, so ask for an office secret instead",
      };
    const nameError = checkSecretName(body.name);
    if (nameError) return fieldFailure(nameError);
    if (hasCredentialShape(body.name as string))
      return fieldFailure({ field: "name", reason: "invalid" });
    const hosts = checkSecretHosts(body.hosts);
    if (!hosts.ok) return fieldFailure(hosts.error);
    const form = checkSecretForm(body.form ?? { kind: "authorization" });
    if (!form.ok) return fieldFailure(form.error);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason || reason.length > SECRET_REQUEST_REASON_MAX)
      return invalidRequest(
        `reason is required, at most ${SECRET_REQUEST_REASON_MAX} characters`,
      );
    if (hasCredentialShape(reason))
      return invalidRequest("the reason must not hold a credential");
    const scope: SecretScope =
      scopeName === "office"
        ? { kind: "office" }
        : { kind: "user", userId: userId as string };
    const name = body.name as string;
    if (deps.store.list(scope).some((secret) => secret.name === name))
      return changeFailure({ ok: false, kind: "exists" });
    const open = openRequests();
    // One open request per secret: a second ask would put a second form for
    // the same secret in front of the member.
    if (
      open.some(
        (e) =>
          e.secret.name === name &&
          e.secret.scope === scopeName &&
          (scopeName === "office" || e.memberUserId === userId),
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
    const secret: SecretAskRequest = {
      requestId: crypto.randomUUID(),
      scope: scopeName,
      name,
      hosts: hosts.hosts,
      form: form.form,
      reason,
    };
    // The ask's own bound (all of the agent's asks) answers as this one.
    const made = deps.asks.create({
      agentId,
      ...(scopeName === "personal" ? { memberUserId: userId as string } : {}),
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
    ): Promise<SecretRequestResult<{ name: string }>> {
      // From the check to the ask's removal nothing awaits, so a decline,
      // a second save or the agent's withdraw cannot slip in between.
      const found = guarded(() => answerable(userId, agentId, requestId));
      if (!found.ok) return found;
      if (!isObject(body)) return invalidRequest("the body must be an object");
      if (
        !Object.keys(body).every((k) => ["value", "hosts", "form"].includes(k))
      )
        return invalidRequest("the body takes only value, hosts, form");
      const { entry, scope } = found;
      const { name } = entry.secret;
      const change = deps.store.create(scope, {
        name,
        value: body.value,
        hosts: body.hosts ?? entry.secret.hosts,
        form: body.form ?? entry.secret.form,
      });
      if (!change.ok) return changeFailure(change);
      try {
        deps.asks.remove(entry.id);
      } catch {
        // The secret is saved, so the agent still hears it. The ask stays
        // until the store can write; a second save gets secret_exists.
        console.error(
          `[secret-requests] ask ${entry.id} was saved but could not be closed`,
        );
      }
      try {
        await deps.onChanged?.();
      } catch {
        console.error("[secret-requests] the proxy did not take a change");
      }
      deps.emitSettled(agentId, requestId, "saved", name);
      const placeholder = deps.placeholderOf(scope, name);
      const hosts = change.secret.hosts.join(", ");
      deps.tellAgent(
        agentId,
        userId as string,
        `I saved the secret ${name} you asked for. From your next start, $${name} holds its placeholder` +
          (placeholder ? ` (${placeholder})` : "") +
          `. Use it as the value: the proxy puts the real value into requests to ${hosts} only.`,
      );
      return { ok: true, name };
    },

    decline(
      userId: string | null,
      agentId: string,
      requestId: string,
    ): SecretRequestResult<{ name: string }> {
      return guarded(() => {
        const found = answerable(userId, agentId, requestId);
        if (!found.ok) return found;
        const { name } = found.entry.secret;
        try {
          deps.asks.remove(found.entry.id);
        } catch {
          return requestFailed;
        }
        deps.emitSettled(agentId, requestId, "declined", name);
        deps.tellAgent(
          agentId,
          userId as string,
          `I declined your request for the secret ${name}.`,
        );
        return { ok: true, name };
      });
    },
  };
}

export type SecretRequests = ReturnType<typeof createSecretRequests>;
