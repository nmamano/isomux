// Secret requests (secrets loop, slice B4): an agent asks for a credential,
// and the member types the value in a masked form on a card in the chat, so
// the value never enters the transcript. The agent gets the placeholder and a
// confirmation; the member can decline.
//
// Open requests live in memory. After a server restart a card's save answers
// 404 and the card says the request is closed; the agent can ask again.
//
// No function here returns, logs or emits a value. The value goes from the
// save body to the store and nowhere else.

import type { SecretRequestPayload } from "../shared/types.ts";
import {
  checkSecretForm,
  checkSecretHosts,
  checkSecretName,
  type SecretFieldError,
} from "../shared/secret-hosts.ts";
import { hasCredentialShape } from "./log-redaction.ts";
import type { SecretChange, SecretScope, SecretStore } from "./secret-store.ts";

export const SECRET_REQUEST_REASON_MAX = 500;
// This server process. A request's card carries the boot it was opened in,
// and full_state carries the current one: a card from an earlier boot shows
// closed, because the open requests did not survive the restart.
export const SERVER_BOOT_ID = crypto.randomUUID();
// A sanity bound, not a quota: one agent rarely has more than one open.
export const SECRET_REQUESTS_OPEN_MAX = 10;

export interface SecretRequestDeps {
  store: SecretStore;
  // The secrets runtime's change hook (secrets.ts): pushes the new secret to
  // the proxy and releases the agents in scope, so their next start has it.
  onChanged?: () => Promise<void>;
  placeholderOf: (scope: SecretScope, name: string) => string | null;
  // The agent's manager: a user id, null for an unowned agent, undefined
  // when there is no such agent.
  agentUserId: (agentId: string) => string | null | undefined;
  isOfficeOwnerUserId: (userId: string) => boolean;
  // The card in the agent's chat. False when the entry was not added.
  emitRequest: (agentId: string, payload: SecretRequestPayload) => boolean;
  // The entry that closes the card, seen by the member.
  emitSettled: (
    agentId: string,
    requestId: string,
    outcome: "saved" | "declined",
    name: string,
  ) => void;
  // A message to the agent from the member who answered.
  tellAgent: (agentId: string, userId: string, text: string) => void;
  // Tests only: another boot id.
  bootId?: string;
}

export type SecretRequestFailure = {
  ok: false;
  status: 400 | 403 | 404 | 409 | 422 | 500;
  code: string;
  message?: string;
  detail?: Record<string, unknown>;
};

export type SecretRequestResult<T> = ({ ok: true } & T) | SecretRequestFailure;

interface OpenRequest {
  agentId: string;
  // The agent's manager when the request opened (personal scope).
  userId: string | null;
  payload: SecretRequestPayload;
}

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
    message: `the ${error.field} field is not valid`,
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

const invalidRequest = (message: string): SecretRequestFailure => ({
  ok: false,
  status: 400,
  code: "invalid_request",
  message,
});

export function createSecretRequests(deps: SecretRequestDeps) {
  const open = new Map<string, OpenRequest>();

  function scopeOf(request: OpenRequest): SecretScope | null {
    if (request.payload.scope === "office") return { kind: "office" };
    return request.userId ? { kind: "user", userId: request.userId } : null;
  }

  // The request, when this member may answer it: the agent's manager for a
  // personal secret, an office owner for an office secret.
  function answerable(
    userId: string | null,
    agentId: string,
    requestId: string,
  ): SecretRequestResult<{ request: OpenRequest; scope: SecretScope }> {
    const request = open.get(requestId);
    if (!request || request.agentId !== agentId)
      return { ok: false, status: 404, code: "not_found" };
    const scope = scopeOf(request);
    const allowed =
      userId !== null &&
      scope !== null &&
      (scope.kind === "office"
        ? deps.isOfficeOwnerUserId(userId)
        : scope.userId === userId);
    if (!allowed) return { ok: false, status: 403, code: "forbidden" };
    return { ok: true, request, scope };
  }

  return {
    // The agent's ask. Checks what the store would check, so the member never
    // gets a card that cannot be saved as it stands.
    open(
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
      const pending = [...open.values()].filter((r) => r.agentId === agentId);
      // One open request per secret: a second ask would put a second card
      // for the same secret in the chat.
      if (
        [...open.values()].some(
          (r) =>
            r.payload.name === name &&
            r.payload.scope === scopeName &&
            (scopeName === "office" || r.userId === userId),
        )
      )
        return {
          ok: false,
          status: 409,
          code: "request_open",
          message: "a request for this secret is open",
        };
      if (pending.length >= SECRET_REQUESTS_OPEN_MAX)
        return {
          ok: false,
          status: 409,
          code: "too_many_requests",
          message: `at most ${SECRET_REQUESTS_OPEN_MAX} open requests per agent`,
        };
      const payload: SecretRequestPayload = {
        requestId: crypto.randomUUID(),
        scope: scopeName,
        name,
        hosts: hosts.hosts,
        form: form.form,
        reason,
        bootId: deps.bootId ?? SERVER_BOOT_ID,
      };
      if (!deps.emitRequest(agentId, payload))
        return { ok: false, status: 500, code: "request_failed" };
      open.set(payload.requestId, { agentId, userId, payload });
      return { ok: true, requestId: payload.requestId };
    },

    // The member's save: the value, and the hosts and form as the member
    // edited them.
    async save(
      userId: string | null,
      agentId: string,
      requestId: string,
      body: unknown,
    ): Promise<SecretRequestResult<{ name: string }>> {
      const found = answerable(userId, agentId, requestId);
      if (!found.ok) return found;
      if (!isObject(body)) return invalidRequest("the body must be an object");
      if (
        !Object.keys(body).every((k) => ["value", "hosts", "form"].includes(k))
      )
        return invalidRequest("the body takes only value, hosts, form");
      const { request, scope } = found;
      const { name } = request.payload;
      const change = deps.store.create(scope, {
        name,
        value: body.value,
        hosts: body.hosts ?? request.payload.hosts,
        form: body.form ?? request.payload.form,
      });
      if (!change.ok) return changeFailure(change);
      open.delete(requestId);
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
      const found = answerable(userId, agentId, requestId);
      if (!found.ok) return found;
      const { name } = found.request.payload;
      open.delete(requestId);
      deps.emitSettled(agentId, requestId, "declined", name);
      deps.tellAgent(
        agentId,
        userId as string,
        `I declined your request for the secret ${name}.`,
      );
      return { ok: true, name };
    },
  };
}

export type SecretRequests = ReturnType<typeof createSecretRequests>;
