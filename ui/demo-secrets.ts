// The demo's secrets routes (secrets.* and officeSecrets.*). The demo keeps
// no value at all: it validates the value and drops it, so nothing in the
// browser can return one. Show answers with a fixed stand-in that says so.

import {
  checkSecretForm,
  checkSecretHosts,
  checkSecretName,
  checkSecretValue,
  type SecretFieldError,
} from "../shared/secret-hosts.ts";
import { checkConnectionNote } from "../shared/connection-notes.ts";
import type { SecretWire } from "../shared/contract-shapes.ts";
import { ApiError, type ApiMethod } from "./api.ts";

const scopes = new Map<string, SecretWire[]>();

export const DEMO_SHOWN_VALUE = "the-demo-keeps-no-values";

// Who is asking: the demo session's user id and whether they own the office.
export type DemoViewer = { userId: string | null; owner: boolean };

// The same codes and detail fields as server/routes/handlers/secrets.ts.
function refuse(error: SecretFieldError): never {
  if (error.reason === "never_listed")
    throw new ApiError(
      422,
      "host_not_allowed",
      `${error.host} never receives a secret: model and package registry hosts are on the never-list`,
      { code: "host_not_allowed", field: error.field, host: error.host },
    );
  throw new ApiError(
    400,
    "invalid_secret",
    `the ${error.field} field is not valid`,
    { code: "invalid_secret", field: error.field, reason: error.reason },
  );
}

// Answers a secrets route, or returns undefined for any other path. `userId`
// resolves a username, or null for an unknown one.
export function demoSecretsRoute(
  method: ApiMethod,
  pathname: string,
  body: unknown,
  userId: (username: string) => string | null,
  viewer: DemoViewer = { userId: null, owner: true },
): { handled: true; result: unknown } | undefined {
  const match =
    pathname.match(
      /^\/api\/office\/secrets(?:\/([^/]+))?(\/value|\/reissue)?$/,
    ) ??
    pathname.match(
      /^\/api\/users\/([^/]+)\/secrets(?:\/([^/]+))?(\/value|\/reissue)?$/,
    );
  if (!match) return undefined;
  const office = pathname.startsWith("/api/office/");
  let key = "office";
  let name: string | undefined = match[1];
  let value = match[2];
  if (!office) {
    const id = userId(decodeURIComponent(match[1]));
    if (!id) throw new ApiError(404, "not_found", "Not found");
    key = id;
    name = match[2];
    value = match[3];
  }
  name = name === undefined ? undefined : decodeURIComponent(name);
  const list = scopes.get(key) ?? [];
  scopes.set(key, list);
  const b = (body ?? {}) as Record<string, unknown>;
  const now = Date.now();

  if (name === undefined) {
    // A member reads the office's secrets as names, hosts and notes.
    if (method === "GET")
      return {
        handled: true,
        result: {
          secrets:
            office && !viewer.owner
              ? list.map(({ name, hosts, note }) => ({ name, hosts, note }))
              : list,
        },
      };
    if (method !== "POST") return undefined;
    const fieldError = checkSecretName(b.name) ?? checkSecretValue(b.value);
    if (fieldError) refuse(fieldError);
    const hosts = checkSecretHosts(b.hosts);
    if (!hosts.ok) refuse(hosts.error);
    const form = checkSecretForm(b.form);
    if (!form.ok) refuse(form.error);
    const note = checkConnectionNote(b.note ?? null);
    if (!note.ok) refuse({ field: "note", reason: note.reason });
    if (list.some((s) => s.name === b.name))
      throw new ApiError(
        409,
        "secret_exists",
        "a secret with this name exists",
      );
    const secret: SecretWire = {
      name: b.name as string,
      hosts: hosts.hosts,
      form: form.form,
      createdAt: now,
      valueSetAt: now,
      updatedAt: now,
      note: note.note,
    };
    list.push(secret);
    list.sort((a, c) => a.name.localeCompare(c.name));
    return { handled: true, result: { secret } };
  }

  const index = list.findIndex((s) => s.name === name);
  if (index === -1) throw new ApiError(404, "not_found", "Not found");
  const secret = list[index];
  if (value === "/reissue") {
    if (method !== "POST") return undefined;
    secret.updatedAt = now;
    return { handled: true, result: { secret } };
  }
  // Show: the secret's own member, or an owner on an office secret.
  if (value === "/value" && method === "GET") {
    const allowed = office ? viewer.owner : key === viewer.userId;
    if (!allowed) throw new ApiError(403, "forbidden", "Forbidden");
    return { handled: true, result: { value: DEMO_SHOWN_VALUE } };
  }
  if (value) {
    if (method !== "PUT") return undefined;
    const valueError = checkSecretValue(b.value);
    if (valueError) refuse(valueError);
    secret.valueSetAt = now;
    secret.updatedAt = now;
    return { handled: true, result: { secret } };
  }
  if (method === "DELETE") {
    list.splice(index, 1);
    return { handled: true, result: undefined };
  }
  if (method !== "PATCH") return undefined;
  if (b.hosts !== undefined) {
    const hosts = checkSecretHosts(b.hosts);
    if (!hosts.ok) refuse(hosts.error);
    secret.hosts = hosts.hosts;
  }
  if (b.form !== undefined) {
    const form = checkSecretForm(b.form);
    if (!form.ok) refuse(form.error);
    secret.form = form.form;
  }
  if (b.note !== undefined) {
    const note = checkConnectionNote(b.note);
    if (!note.ok) refuse({ field: "note", reason: note.reason });
    secret.note = note.note;
  }
  secret.updatedAt = now;
  return { handled: true, result: { secret } };
}

// The hosts of a demo secret, for the demo's MCP servers (demo-mcp-servers.ts).
// `key` is "office" or a user id.
export function demoSecretHosts(key: string, name: string): string[] | null {
  return scopes.get(key)?.find((s) => s.name === name)?.hosts ?? null;
}
