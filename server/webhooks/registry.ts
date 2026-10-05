// The webhook registry: hook records, their secrets, and the read side of each
// hook's delivery log. See internal-docs/webhooks-design.md section 2.
//
// Files under STATE_ROOT/webhooks:
//   webhooks.json             {webhooks: WebhookRecord[]}
//   secrets.json              {[id]: {secret, rotatedAt}}  mode 0600, dir 0700
//   <id>/deliveries.json      WebhookDelivery[], newest last (written by
//                             deliveries.ts)
//
// THE SECRET HAS ITS OWN FILE so that no list or read of a record can return it
// by accident. Only readSecret and rotateSecret hand it out. The two human
// secret routes call them, and ingress calls readSecret to verify a delivery.
//
// CORRUPTION FAILS LOUD, as in server/app-registry.ts: a malformed file raises
// `registry_corrupt` on every operation, reads included. An empty worldview
// would hand out a name a live hook holds and then write the truncated view
// over the file that still held the truth. A MISSING file is an office with no
// hooks, so old installs need no migration. Every failed write throws
// `persist_failed`; the caller answers 500.
//
// CONCURRENCY: every operation is synchronous, so a create runs read -> check
// -> write without yielding, and two concurrent requests cannot both take one
// name.

import { randomBytes } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join, resolve } from "path";
import { STATE_ROOT } from "../config.ts";
import { atomicWriteFileSync } from "../persistence.ts";
import {
  WEBHOOK_ARG_NAME_PATTERN,
  WEBHOOK_MAX_ARGS,
  WEBHOOK_MAX_RULES,
  WEBHOOK_NAME_PATTERN,
  normalizeWebhookNote,
} from "./block.ts";
import type {
  WebhookDelivery,
  WebhookRecord,
  WebhookRule,
  WebhookScheme,
  WebhookTarget,
} from "../../shared/types.ts";
import type { WebhookErrorCode } from "../../shared/contract-shapes.ts";

// Sanity bounds (ruling 8), constants and not env vars.
export const WEBHOOK_MAX_HOOKS = 100;
export const WEBHOOK_MAX_MATCH_ENTRIES = 10;
// One match path, match value or arg template (PM ruling, 2026-10-05). Over
// it is 422 rule_field_too_long.
export const WEBHOOK_MAX_RULE_FIELD_CHARS = 1000;
export const WEBHOOK_DELIVERY_LOG_MAX = 500;

export const WEBHOOK_ID_PATTERN = /^wh_[0-9a-f]{16}$/;
// An HTTP header name (RFC 9110 token).
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
const SCHEMES: readonly WebhookScheme[] = ["github-hmac-sha256", "hmac-sha256"];
const ID_MAX_CHARS = 200;

export class WebhookRegistryError extends Error {
  constructor(
    public readonly code: WebhookErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WebhookRegistryError";
  }
}

const refuse = (code: WebhookErrorCode, message: string) =>
  new WebhookRegistryError(code, message);

const tooLong = (where: string) =>
  refuse(
    "rule_field_too_long",
    `${where} is longer than ${WEBHOOK_MAX_RULE_FIELD_CHARS} characters`,
  );

// Moving the file aside reads as "no hooks", which frees every name and drops
// every secret; the advice must not recommend it.
const corrupt = (file: string, why: string): WebhookRegistryError =>
  new WebhookRegistryError(
    "registry_corrupt",
    `${file} is unreadable (${why}). The webhook registry refuses to operate ` +
      `on a partial view of itself. Restore or repair the file from a ` +
      `known-good copy, then retry. Do not delete it or move it aside - a ` +
      `missing file reads as an office with no webhooks.`,
  );

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  return Object.keys(value).find((key) => !allowed.includes(key)) ?? null;
}

// The fields a caller sets. Create and PATCH both validate a WHOLE set (PATCH
// merges first), so a rule that holds at create also holds after any edit.
export interface WebhookFields {
  name: string;
  scheme: WebhookScheme;
  signatureHeader: string | null;
  eventHeader: string | null;
  deliveryHeader: string | null;
  rules: WebhookRule[];
  target: WebhookTarget;
  enabled: boolean;
}

function validateHeaderName(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !HEADER_NAME_PATTERN.test(value)) {
    throw refuse(
      "invalid_headers",
      `${field} must be an HTTP header name of at most 100 characters`,
    );
  }
  // Header lookups are case-insensitive; one stored form keeps them simple.
  return value.toLowerCase();
}

// `checkKey` throws for a bad key.
function validateStringMap(
  value: unknown,
  where: string,
  max: number,
  checkKey: (key: string) => void,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw refuse("invalid_rules", `${where} must be an object`);
  }
  const entries = Object.entries(value);
  if (entries.length > max) {
    throw refuse("invalid_rules", `${where} has more than ${max} entries`);
  }
  for (const [key, entry] of entries) {
    checkKey(key);
    if (typeof entry !== "string") {
      throw refuse("invalid_rules", `${where}.${key} must be a string`);
    }
    if (entry.length > WEBHOOK_MAX_RULE_FIELD_CHARS) {
      throw tooLong(`${where}.${key}`);
    }
  }
  // fromEntries defines own properties, so a "__proto__" key stays data.
  return Object.fromEntries(entries) as Record<string, string>;
}

function validateRule(value: unknown, index: number): WebhookRule {
  const where = `rules[${index}]`;
  if (!isPlainObject(value)) {
    throw refuse("invalid_rules", `${where} must be an object`);
  }
  const extra = onlyKeys(value, ["event", "match", "args"]);
  if (extra)
    throw refuse("invalid_rules", `${where} has unknown key "${extra}"`);
  // Compared with the RAW event header, exactly (PM ruling, 2026-10-05). The
  // reduction to [A-Za-z0-9._:-] is for the block text only.
  const { event } = value;
  if (typeof event !== "string" || event.length === 0) {
    throw refuse(
      "invalid_rules",
      `${where}.event must be "*" or an event name`,
    );
  }
  const match = validateStringMap(
    value.match,
    `${where}.match`,
    WEBHOOK_MAX_MATCH_ENTRIES,
    (path) => {
      if (path.length === 0) {
        throw refuse("invalid_rules", `${where}.match has an empty path`);
      }
      if (path.length > WEBHOOK_MAX_RULE_FIELD_CHARS) {
        throw tooLong(`a path in ${where}.match`);
      }
    },
  );
  const args = validateStringMap(
    value.args,
    `${where}.args`,
    WEBHOOK_MAX_ARGS,
    (name) => {
      if (!WEBHOOK_ARG_NAME_PATTERN.test(name)) {
        throw refuse(
          "invalid_rules",
          `${where}.args: arg name "${name}" must match [a-z][a-z0-9_]* and have at most 40 characters`,
        );
      }
    },
  );
  return {
    event,
    ...(match === undefined ? {} : { match }),
    ...(args === undefined ? {} : { args }),
  };
}

function validateId(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > ID_MAX_CHARS
  ) {
    throw refuse("invalid_target", `${field} must be a non-empty string`);
  }
  return value;
}

// Shape only. Whether the caller may point the hook at this target is the
// webhookTargetAllowed precondition, which reads live state.
export function validateWebhookTarget(value: unknown): WebhookTarget {
  if (!isPlainObject(value)) {
    throw refuse("invalid_target", "target must be an object");
  }
  if (value.kind === "agent") {
    const extra = onlyKeys(value, ["kind", "agentId", "note"]);
    if (extra) {
      throw refuse("invalid_target", `target has unknown key "${extra}"`);
    }
    const agentId = validateId(value.agentId, "target.agentId");
    if (value.note === undefined || value.note === null || value.note === "") {
      return { kind: "agent", agentId };
    }
    if (typeof value.note !== "string") {
      throw refuse("invalid_note", "target.note must be a string");
    }
    const note = normalizeWebhookNote(value.note);
    if (!note.ok) {
      throw refuse(
        "invalid_note",
        note.reason === "angle_bracket"
          ? "target.note may not contain < or >"
          : "target.note is longer than 1000 characters",
      );
    }
    return { kind: "agent", agentId, note: note.note };
  }
  if (value.kind === "cronjob") {
    const extra = onlyKeys(value, ["kind", "cronjobId"]);
    if (extra) {
      throw refuse("invalid_target", `target has unknown key "${extra}"`);
    }
    return {
      kind: "cronjob",
      cronjobId: validateId(value.cronjobId, "target.cronjobId"),
    };
  }
  throw refuse("invalid_target", 'target.kind must be "agent" or "cronjob"');
}

// Validate and normalize a whole field set. Throws WebhookRegistryError.
export function validateWebhookFields(input: {
  [K in keyof WebhookFields]: unknown;
}): WebhookFields {
  const { name, scheme, rules, enabled } = input;
  if (typeof name !== "string" || !WEBHOOK_NAME_PATTERN.test(name)) {
    throw refuse(
      "invalid_name",
      "name must be 1-63 characters of lowercase letters, digits and hyphens",
    );
  }
  if (!SCHEMES.includes(scheme as WebhookScheme)) {
    throw refuse(
      "invalid_scheme",
      'scheme must be "github-hmac-sha256" or "hmac-sha256"',
    );
  }
  const signatureHeader = validateHeaderName(
    input.signatureHeader,
    "signatureHeader",
  );
  const eventHeader = validateHeaderName(input.eventHeader, "eventHeader");
  const deliveryHeader = validateHeaderName(
    input.deliveryHeader,
    "deliveryHeader",
  );
  if (scheme === "github-hmac-sha256") {
    if (signatureHeader || eventHeader || deliveryHeader) {
      throw refuse(
        "invalid_headers",
        "github-hmac-sha256 reads GitHub's own headers; leave signatureHeader, eventHeader and deliveryHeader unset",
      );
    }
  } else if (!signatureHeader) {
    throw refuse("invalid_headers", "hmac-sha256 needs signatureHeader");
  }
  if (!Array.isArray(rules)) {
    throw refuse("invalid_rules", "rules must be an array");
  }
  if (rules.length > WEBHOOK_MAX_RULES) {
    throw refuse(
      "invalid_rules",
      `a webhook has at most ${WEBHOOK_MAX_RULES} rules`,
    );
  }
  if (typeof enabled !== "boolean") {
    throw refuse("invalid_request", "enabled must be a boolean");
  }
  return {
    name,
    scheme: scheme as WebhookScheme,
    signatureHeader,
    eventHeader,
    deliveryHeader,
    rules: rules.map(validateRule),
    target: validateWebhookTarget(input.target),
    enabled,
  };
}

function readStateFile(file: string): unknown {
  if (!existsSync(file)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch (err) {
    throw corrupt(file, `cannot be read: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw corrupt(file, "not valid JSON");
  }
}

function persistedRecord(value: unknown, file: string): WebhookRecord {
  if (!isPlainObject(value)) throw corrupt(file, "a record is not an object");
  const { id, userId, username, createdBy, createdByAgentId, createdAt } =
    value;
  if (typeof id !== "string" || !WEBHOOK_ID_PATTERN.test(id)) {
    throw corrupt(file, "a record has an invalid id");
  }
  let fields: WebhookFields;
  try {
    fields = validateWebhookFields({
      name: value.name,
      scheme: value.scheme,
      signatureHeader: value.signatureHeader,
      eventHeader: value.eventHeader,
      deliveryHeader: value.deliveryHeader,
      rules: value.rules,
      target: value.target,
      enabled: value.enabled,
    });
  } catch (err) {
    throw corrupt(file, `record ${id}: ${(err as Error).message}`);
  }
  if (
    typeof userId !== "string" ||
    (username !== null && typeof username !== "string") ||
    typeof createdBy !== "string" ||
    (createdByAgentId !== undefined && typeof createdByAgentId !== "string") ||
    typeof createdAt !== "number" ||
    !Number.isFinite(createdAt)
  ) {
    throw corrupt(file, `record ${id} has invalid owner fields`);
  }
  return {
    id,
    ...fields,
    userId,
    username,
    createdBy,
    ...(createdByAgentId === undefined ? {} : { createdByAgentId }),
    createdAt,
  };
}

interface StoredSecret {
  secret: string;
  rotatedAt: number;
}

export interface CreateWebhookInput {
  fields: WebhookFields;
  userId: string;
  username: string | null;
  createdBy: string;
  createdByAgentId?: string;
}

export interface WebhookRegistry {
  // Every hook, creation order.
  list(): WebhookRecord[];
  get(id: string): WebhookRecord | null;
  // Generates the id and the secret. Throws WebhookRegistryError.
  create(input: CreateWebhookInput): WebhookRecord;
  // Replace the caller-set fields with an already merged and validated set.
  // Null when no hook has that id.
  update(id: string, fields: WebhookFields): WebhookRecord | null;
  // Drops the secret, the record and the hook's directory. Null when no hook
  // has that id.
  remove(id: string): WebhookRecord | null;
  secretState(id: string): "set" | "missing";
  // The two human secret routes, and ingress to verify a delivery. Never put
  // into any other response.
  readSecret(id: string): string | null;
  // The new secret; the old one stops working at once. Null when no hook has
  // that id.
  rotateSecret(id: string): string | null;
  // Newest first, at most `limit`.
  readDeliveries(id: string, limit: number): WebhookDelivery[];
}

export interface WebhookRegistryOptions {
  dir?: string;
  now?: () => number;
  // Tests inject a failing writer to prove a failed write leaves a consistent
  // state on disk.
  writeFile?: (path: string, data: string, mode?: number) => void;
}

export function createWebhookRegistry(
  options: WebhookRegistryOptions = {},
): WebhookRegistry {
  const dir = resolve(options.dir ?? join(STATE_ROOT, "webhooks"));
  const hooksFile = join(dir, "webhooks.json");
  const secretsFile = join(dir, "secrets.json");
  const now = options.now ?? (() => Date.now());
  const writeFile = options.writeFile ?? atomicWriteFileSync;

  const loadHooks = (): WebhookRecord[] => {
    const raw = readStateFile(hooksFile);
    if (raw === undefined) return [];
    if (!isPlainObject(raw) || !Array.isArray(raw.webhooks)) {
      throw corrupt(hooksFile, "expected {webhooks: [...]}");
    }
    const hooks = raw.webhooks.map((v) => persistedRecord(v, hooksFile));
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const hook of hooks) {
      if (ids.has(hook.id)) throw corrupt(hooksFile, `duplicate id ${hook.id}`);
      if (names.has(hook.name)) {
        throw corrupt(hooksFile, `duplicate name ${hook.name}`);
      }
      ids.add(hook.id);
      names.add(hook.name);
    }
    return hooks;
  };

  const loadSecrets = (): Map<string, StoredSecret> => {
    const raw = readStateFile(secretsFile);
    if (raw === undefined) return new Map();
    if (!isPlainObject(raw)) throw corrupt(secretsFile, "expected an object");
    const secrets = new Map<string, StoredSecret>();
    for (const [id, entry] of Object.entries(raw)) {
      if (
        !isPlainObject(entry) ||
        typeof entry.secret !== "string" ||
        entry.secret.length === 0 ||
        typeof entry.rotatedAt !== "number"
      ) {
        throw corrupt(secretsFile, `entry ${id} is malformed`);
      }
      secrets.set(id, { secret: entry.secret, rotatedAt: entry.rotatedAt });
    }
    return secrets;
  };

  // The directory holds the secrets file, so it is private as well as the file.
  const ensurePrivateDir = () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  };

  const write = (file: string, value: unknown, mode?: number) => {
    try {
      ensurePrivateDir();
      writeFile(file, JSON.stringify(value, null, 2), mode);
    } catch (err) {
      console.error(`[webhooks] failed to write ${file}:`, err);
      throw refuse(
        "persist_failed",
        "the webhook registry could not complete the write; inspect server logs and retry",
      );
    }
  };
  const writeHooks = (hooks: WebhookRecord[]) =>
    write(hooksFile, { webhooks: hooks });
  const writeSecrets = (secrets: Map<string, StoredSecret>) =>
    write(secretsFile, Object.fromEntries(secrets), 0o600);

  const newSecret = () => randomBytes(32).toString("base64url");

  return {
    list: () => loadHooks(),

    get: (id) => loadHooks().find((hook) => hook.id === id) ?? null,

    create(input) {
      const hooks = loadHooks();
      const secrets = loadSecrets();
      if (hooks.length >= WEBHOOK_MAX_HOOKS) {
        throw refuse(
          "webhook_limit_reached",
          `an office has at most ${WEBHOOK_MAX_HOOKS} webhooks`,
        );
      }
      if (hooks.some((hook) => hook.name === input.fields.name)) {
        throw refuse(
          "name_taken",
          `a webhook named "${input.fields.name}" already exists`,
        );
      }
      let id: string;
      do {
        id = `wh_${randomBytes(8).toString("hex")}`;
      } while (hooks.some((hook) => hook.id === id) || secrets.has(id));
      const record: WebhookRecord = {
        id,
        ...input.fields,
        userId: input.userId,
        username: input.username,
        createdBy: input.createdBy,
        ...(input.createdByAgentId === undefined
          ? {}
          : { createdByAgentId: input.createdByAgentId }),
        createdAt: now(),
      };
      // The secret first: a crash between the writes leaves an orphan secret
      // that no record names, never a hook that cannot verify.
      secrets.set(id, { secret: newSecret(), rotatedAt: now() });
      writeSecrets(secrets);
      try {
        writeHooks([...hooks, record]);
      } catch (err) {
        secrets.delete(id);
        try {
          writeSecrets(secrets);
        } catch {
          // Already logged; an orphan secret names no hook.
        }
        throw err;
      }
      return record;
    },

    update(id, fields) {
      const hooks = loadHooks();
      const index = hooks.findIndex((hook) => hook.id === id);
      if (index === -1) return null;
      if (hooks.some((hook) => hook.id !== id && hook.name === fields.name)) {
        throw refuse(
          "name_taken",
          `a webhook named "${fields.name}" already exists`,
        );
      }
      const updated: WebhookRecord = { ...hooks[index], ...fields };
      hooks[index] = updated;
      writeHooks(hooks);
      return updated;
    },

    remove(id) {
      const hooks = loadHooks();
      const secrets = loadSecrets();
      const record = hooks.find((hook) => hook.id === id);
      if (!record) return null;
      // The secret first: if the record write then fails, the hook still
      // exists with its secret missing, and a retried delete finishes the job.
      if (secrets.delete(id)) writeSecrets(secrets);
      writeHooks(hooks.filter((hook) => hook.id !== id));
      try {
        rmSync(join(dir, id), { recursive: true, force: true });
      } catch (err) {
        // The record is gone, so the rows are unreachable; the leftover
        // directory costs disk only.
        console.error(`[webhooks] could not remove ${join(dir, id)}:`, err);
      }
      return record;
    },

    secretState(id) {
      return loadSecrets().has(id) ? "set" : "missing";
    },

    readSecret(id) {
      return loadSecrets().get(id)?.secret ?? null;
    },

    rotateSecret(id) {
      if (!loadHooks().some((hook) => hook.id === id)) return null;
      const secrets = loadSecrets();
      const secret = newSecret();
      secrets.set(id, { secret, rotatedAt: now() });
      writeSecrets(secrets);
      return secret;
    },

    readDeliveries(id, limit) {
      if (!WEBHOOK_ID_PATTERN.test(id)) return [];
      const file = join(dir, id, "deliveries.json");
      const raw = readStateFile(file);
      if (raw === undefined) return [];
      if (!Array.isArray(raw)) throw corrupt(file, "expected an array");
      return (raw as WebhookDelivery[]).slice(-limit).reverse();
    },
  };
}

// Production singleton over STATE_ROOT/webhooks. Constructing it touches no
// disk.
export const webhookRegistry: WebhookRegistry = createWebhookRegistry();
