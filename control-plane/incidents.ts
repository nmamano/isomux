// The status pages for an enterprise customer's critical issue.
//
// The enterprise agreement (section 7) promises a written update at least every
// hour until a critical issue is resolved: what Isomux found, what it is doing
// now, and when it expects the fix. The updates go to a status page for the
// issue and to the customer's contacts by email. This module is the store side
// of that promise, as a LISTED verb surface like ops.ts.
//
// Three kinds of caller, three kinds of check, each inside the transaction that
// does the work:
//
//   THE CUSTOMER holds a private link and no sign-in. The link is not stored:
//   it is an HMAC of the customer id and its link generation (statusToken), so
//   a database leak alone gives no link. Re-making a link bumps the generation
//   and kills every older one.
//
//   AN OPERATOR is re-read with isOperator in the transaction, as in ops.ts. A
//   non-operator gets the same null as a missing row.
//
//   THE SUPPORT AGENT holds the one write key (incident_keys). It is stored as a
//   sha256 hash and compared in constant time. A bad key gets null.
//
// Every time decision reads store.now(), never the wall clock.

import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { isOperator } from "./operator.ts";
import type { Store } from "./store.ts";

export type IncidentKind = "critical" | "security";
export type IncidentStatus = "open" | "resolved";
/** Who posted an update, as the customer sees it. Never a name or an email. */
export type AuthorKind = "engineer" | "support_agent";

/** The promise: an update at least this often while the issue is open. */
export const UPDATE_EVERY_MS = 60 * 60_000;
/** An open issue is due (GET ?due=1) once its last update is this old. */
export const DUE_AFTER_MS = 40 * 60_000;
/** The context string of the status link's HMAC (statusToken). */
export const STATUS_LINK_CONTEXT = "isomux-status-link-v1";

/** One update as it is posted. */
export interface IncidentUpdateInput {
  found: string;
  doingNow: string;
  /** When we expect the fix, epoch ms. Required and in the future, except on
   * the final update, where it may be null. */
  estimateAt: number | null;
  /** True resolves the issue in the same transaction. */
  final?: boolean;
}

/** One update as the customer sees it. */
export interface StatusUpdateView {
  n: number;
  postedAt: number;
  author: AuthorKind;
  found: string;
  doingNow: string;
  estimateAt: number | null;
  final: boolean;
}

export interface StatusIncidentSummary {
  n: number;
  title: string;
  kind: IncidentKind;
  status: IncidentStatus;
  openedAt: number;
  resolvedAt: number | null;
  lastUpdateAt: number;
}

/** /status/<token>: the customer's issues, newest first. */
export interface StatusListView {
  customerLabel: string;
  incidents: StatusIncidentSummary[];
}

/** /status/<token>/<n>: one issue with its updates, newest first. */
export interface StatusIncidentView extends StatusIncidentSummary {
  customerLabel: string;
  timeZone: string;
  updates: StatusUpdateView[];
}

/** One update as an operator sees it, with the gap that preceded it. */
export interface OpsUpdateItem extends StatusUpdateView {
  /** The account id of the engineer, or "key" for the write key. */
  authorRef: string;
  /** Since the previous update (or the open, for the first). */
  gapMs: number;
  /** How far the gap went past UPDATE_EVERY_MS; 0 when on time. */
  lateByMs: number;
}

export interface OpsIncidentItem {
  id: string;
  customerId: string;
  customerLabel: string;
  n: number;
  title: string;
  kind: IncidentKind;
  status: IncidentStatus;
  timeZone: string;
  contacts: string[];
  openedAt: number;
  openedBy: string;
  resolvedAt: number | null;
  lastUpdateAt: number;
  /** lastUpdateAt + UPDATE_EVERY_MS while open; null once resolved. */
  dueAt: number | null;
  /** How far an open issue is past dueAt now; 0 when on time or resolved. */
  lateByMs: number;
  /** Oldest first. */
  updates: OpsUpdateItem[];
}

export interface OpsCustomerItem {
  id: string;
  label: string;
  linkGeneration: number;
}

/** /ops/incidents. */
export interface OpsIncidentsView {
  now: number;
  customers: OpsCustomerItem[];
  /** Open first, then newest. */
  incidents: OpsIncidentItem[];
  keySet: boolean;
  keyRotatedAt: number | null;
}

/** GET /api/ops/incidents for the write key. */
export interface DueIncidentItem {
  id: string;
  customerLabel: string;
  n: number;
  title: string;
  kind: IncidentKind;
  lastUpdateAt: number;
  dueAt: number;
  lateByMs: number;
}

/** What a posting verb hands back: everything the update's email needs. */
export interface PostedUpdate {
  incidentId: string;
  customerId: string;
  customerLabel: string;
  linkGeneration: number;
  n: number;
  title: string;
  kind: IncidentKind;
  timeZone: string;
  contacts: string[];
  update: StatusUpdateView;
}

/** A post that reached a real issue and was refused: not_found is 404,
 * resolved is 409, invalid is 400. */
export type PostRefusal =
  | { ok: false; refused: "not_found" }
  | { ok: false; refused: "resolved" }
  | { ok: false; refused: "invalid"; reason: string };

export type PostResult = { ok: true; posted: PostedUpdate } | PostRefusal;

export interface OpenIncidentInput {
  /** The customer, by its label. A new label creates the customer. */
  customerLabel: string;
  contacts: string[];
  kind: IncidentKind;
  /** An IANA time zone, for the estimate on the customer's page. */
  timeZone: string;
  title: string;
  /** Opening IS the first update: the customer gets mail at once and the hour
   * starts. */
  first: IncidentUpdateInput;
}

/** The customer's private link token: `<customerId>.<mac>`.
 *
 * The same two steps as the sign-in link (web/lib/signin-link.server.ts): a
 * key derived from the secret and this link's context, then an HMAC of the
 * claim. The claim names the generation, so a re-made link kills the old one. */
export function statusToken(
  secret: string,
  customerId: string,
  linkGeneration: number,
): string {
  return `${customerId}.${statusMac(secret, customerId, linkGeneration)}`;
}

function statusMac(
  secret: string,
  customerId: string,
  linkGeneration: number,
): string {
  const key = createHmac("sha256", secret).update(STATUS_LINK_CONTEXT).digest();
  return createHmac("sha256", key)
    .update(`${customerId}:${linkGeneration}`)
    .digest("base64url");
}

/** A customer id as newCustomerId makes it; checked before any query. */
const CUSTOMER_ID =
  /^sc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const newCustomerId = () => `sc-${randomUUID()}`;
const newIncidentId = () => `inc-${randomUUID()}`;
const newUpdateId = () => `iu-${randomUUID()}`;

/** The same text as a byte compare in constant time; false on any length
 * difference. The MAC is compared as TEXT: decoding base64url would accept a
 * changed last character whose bits are padding. */
function sameText(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

interface CustomerRow {
  id: string;
  label: string;
  link_generation: number;
}

/** The customer a link names, or null: an unknown id, a bad MAC and a stale
 * generation are the same null. */
async function customerForToken(
  store: Store,
  secret: string,
  token: string,
): Promise<CustomerRow | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [customerId, mac] = parts;
  if (!CUSTOMER_ID.test(customerId) || !mac || !secret) return null;
  const row = await store.sqlGet<CustomerRow>(
    "select id, label, link_generation from status_customers where id = $1",
    [customerId],
  );
  if (!row) return null;
  return sameText(mac, statusMac(secret, row.id, row.link_generation))
    ? row
    : null;
}

interface IncidentRow {
  id: string;
  customer_id: string;
  n: number;
  title: string;
  kind: IncidentKind;
  time_zone: string;
  contacts: string;
  status: IncidentStatus;
  opened_at: number;
  opened_by: string;
  resolved_at: number | null;
}

interface UpdateRow {
  incident_id: string;
  n: number;
  found: string;
  doing_now: string;
  estimate_at: number | null;
  final: number;
  author_kind: AuthorKind;
  author_ref: string;
  posted_at: number;
}

const INCIDENT_COLUMNS =
  "id, customer_id, n, title, kind, time_zone, contacts, status, opened_at, " +
  "opened_by, resolved_at";
const UPDATE_COLUMNS =
  "incident_id, n, found, doing_now, estimate_at, final, author_kind, " +
  "author_ref, posted_at";

function updateView(row: UpdateRow): StatusUpdateView {
  return {
    n: row.n,
    postedAt: row.posted_at,
    author: row.author_kind,
    found: row.found,
    doingNow: row.doing_now,
    estimateAt: row.estimate_at,
    final: row.final === 1,
  };
}

/** Each issue's updates, oldest first, in one read. */
async function updatesOf(
  store: Store,
  incidentIds: string[],
): Promise<Map<string, UpdateRow[]>> {
  const out = new Map<string, UpdateRow[]>(incidentIds.map((id) => [id, []]));
  if (incidentIds.length === 0) return out;
  const rows = await store.sqlAll<UpdateRow>(
    `select ${UPDATE_COLUMNS} from incident_updates ` +
      "where incident_id = any($1::text[]) order by incident_id, n",
    // A Postgres array literal, because SqlArgs carries scalars only. The ids
    // are our own (inc-<uuid>), so none holds a quote or a comma.
    [`{${incidentIds.map((id) => `"${id}"`).join(",")}}`],
  );
  for (const row of rows) out.get(row.incident_id)?.push(row);
  return out;
}

function lastUpdateAt(incident: IncidentRow, updates: UpdateRow[]): number {
  return updates.at(-1)?.posted_at ?? incident.opened_at;
}

function summary(
  incident: IncidentRow,
  updates: UpdateRow[],
): StatusIncidentSummary {
  return {
    n: incident.n,
    title: incident.title,
    kind: incident.kind,
    status: incident.status,
    openedAt: incident.opened_at,
    resolvedAt: incident.resolved_at,
    lastUpdateAt: lastUpdateAt(incident, updates),
  };
}

/** /status/<token>. Null for a bad, stale or unknown token. */
export async function statusListFor(
  store: Store,
  secret: string,
  token: string,
): Promise<StatusListView | null> {
  const customer = await customerForToken(store, secret, token);
  if (!customer) return null;
  const incidents = await store.sqlAll<IncidentRow>(
    `select ${INCIDENT_COLUMNS} from incidents where customer_id = $1 order by n desc`,
    [customer.id],
  );
  const updates = await updatesOf(
    store,
    incidents.map((i) => i.id),
  );
  return {
    customerLabel: customer.label,
    incidents: incidents.map((i) => summary(i, updates.get(i.id) ?? [])),
  };
}

/** /status/<token>/<n>. Null for a bad token, or an n that is not this
 * customer's. */
export async function statusIncidentFor(
  store: Store,
  secret: string,
  token: string,
  n: number,
): Promise<StatusIncidentView | null> {
  if (!Number.isSafeInteger(n) || n < 1) return null;
  const customer = await customerForToken(store, secret, token);
  if (!customer) return null;
  const incident = await store.sqlGet<IncidentRow>(
    `select ${INCIDENT_COLUMNS} from incidents where customer_id = $1 and n = $2`,
    [customer.id, n],
  );
  if (!incident) return null;
  const updates =
    (await updatesOf(store, [incident.id])).get(incident.id) ?? [];
  return {
    ...summary(incident, updates),
    customerLabel: customer.label,
    timeZone: incident.time_zone,
    updates: updates.map(updateView).reverse(),
  };
}

/** /ops/incidents. Null for a non-operator. */
export async function opsIncidents(
  store: Store,
  accountId: string,
): Promise<OpsIncidentsView | null> {
  return store.tx(async () => {
    if (!(await isOperator(store, accountId))) return null;
    const now = store.now();
    const customers = await store.sqlAll<CustomerRow>(
      "select id, label, link_generation from status_customers order by label",
    );
    const labels = new Map(customers.map((c) => [c.id, c.label]));
    const incidents = await store.sqlAll<IncidentRow>(
      `select ${INCIDENT_COLUMNS} from incidents ` +
        "order by (status = 'open') desc, opened_at desc, n desc",
    );
    const updates = await updatesOf(
      store,
      incidents.map((i) => i.id),
    );
    const key = await store.sqlGet<{
      key_hash: string | null;
      rotated_at: number | null;
    }>("select key_hash, rotated_at from incident_keys where id = 'current'");
    return {
      now,
      customers: customers.map((c) => ({
        id: c.id,
        label: c.label,
        linkGeneration: c.link_generation,
      })),
      incidents: incidents.map((incident) =>
        opsItem(
          incident,
          labels.get(incident.customer_id) ?? "",
          updates.get(incident.id) ?? [],
          now,
        ),
      ),
      keySet: !!key?.key_hash,
      keyRotatedAt: key?.rotated_at ?? null,
    };
  });
}

function opsItem(
  incident: IncidentRow,
  customerLabel: string,
  updates: UpdateRow[],
  now: number,
): OpsIncidentItem {
  const last = lastUpdateAt(incident, updates);
  const open = incident.status === "open";
  const dueAt = open ? last + UPDATE_EVERY_MS : null;
  let previous = incident.opened_at;
  return {
    id: incident.id,
    customerId: incident.customer_id,
    customerLabel,
    n: incident.n,
    title: incident.title,
    kind: incident.kind,
    status: incident.status,
    timeZone: incident.time_zone,
    contacts: parseContacts(incident.contacts),
    openedAt: incident.opened_at,
    openedBy: incident.opened_by,
    resolvedAt: incident.resolved_at,
    lastUpdateAt: last,
    dueAt,
    lateByMs: dueAt === null ? 0 : Math.max(0, now - dueAt),
    updates: updates.map((row) => {
      const gapMs = Math.max(0, row.posted_at - previous);
      previous = row.posted_at;
      return {
        ...updateView(row),
        authorRef: row.author_ref,
        gapMs,
        lateByMs: Math.max(0, gapMs - UPDATE_EVERY_MS),
      };
    }),
  };
}

function parseContacts(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed)
      ? parsed.filter((c): c is string => typeof c === "string")
      : [];
  } catch {
    return [];
  }
}

// ------------------------------------------------------------ input rules

const MAX_TEXT = 4000;
const MAX_TITLE = 200;
const MAX_LABEL = 100;
const MAX_CONTACTS = 10;
const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

function invalid(reason: string): PostRefusal {
  return { ok: false, refused: "invalid", reason };
}

function text(value: unknown, name: string, max: number): Checked<string> {
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, reason: `${name} is required` };
  }
  if (value.length > max) {
    return { ok: false, reason: `${name} is over ${max} characters` };
  }
  return { ok: true, value: value.trim() };
}

/** An update's fields, checked against the store clock. */
function checkUpdate(
  input: unknown,
  now: number,
): Checked<Required<IncidentUpdateInput>> {
  if (typeof input !== "object" || input === null) {
    return { ok: false, reason: "the update is missing" };
  }
  const raw = input as Record<string, unknown>;
  const found = text(raw.found, "found", MAX_TEXT);
  if (!found.ok) return found;
  const doingNow = text(raw.doingNow, "doingNow", MAX_TEXT);
  if (!doingNow.ok) return doingNow;
  if (raw.final !== undefined && typeof raw.final !== "boolean") {
    return { ok: false, reason: "final must be true or false" };
  }
  const final = raw.final === true;
  const estimate = raw.estimateAt ?? null;
  if (estimate !== null && !Number.isSafeInteger(estimate)) {
    return { ok: false, reason: "estimateAt must be a time in ms" };
  }
  const estimateAt = estimate as number | null;
  if (!final && estimateAt === null) {
    return {
      ok: false,
      reason: "estimateAt is required until the final update",
    };
  }
  if (!final && (estimateAt as number) <= now) {
    return { ok: false, reason: "estimateAt must be in the future" };
  }
  return {
    ok: true,
    value: { found: found.value, doingNow: doingNow.value, estimateAt, final },
  };
}

function validTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function checkOpening(
  input: unknown,
  now: number,
): Checked<{
  customerLabel: string;
  contacts: string[];
  kind: IncidentKind;
  timeZone: string;
  title: string;
  first: Required<IncidentUpdateInput>;
}> {
  if (typeof input !== "object" || input === null) {
    return { ok: false, reason: "the issue is missing" };
  }
  const raw = input as Record<string, unknown>;
  const label = text(raw.customerLabel, "customerLabel", MAX_LABEL);
  if (!label.ok) return label;
  const title = text(raw.title, "title", MAX_TITLE);
  if (!title.ok) return title;
  if (raw.kind !== "critical" && raw.kind !== "security") {
    return { ok: false, reason: "kind must be critical or security" };
  }
  if (!validTimeZone(raw.timeZone)) {
    return { ok: false, reason: "timeZone is not a known time zone" };
  }
  const contacts = raw.contacts;
  if (
    !Array.isArray(contacts) ||
    contacts.length < 1 ||
    contacts.length > MAX_CONTACTS
  ) {
    return {
      ok: false,
      reason: `contacts must hold 1 to ${MAX_CONTACTS} addresses`,
    };
  }
  const addresses: string[] = [];
  for (const contact of contacts) {
    if (
      typeof contact !== "string" ||
      contact.length > 254 ||
      !EMAIL.test(contact.trim())
    ) {
      return { ok: false, reason: "a contact is not an email address" };
    }
    addresses.push(contact.trim());
  }
  const first = checkUpdate(raw.first, now);
  if (!first.ok) return first;
  if (first.value.final) {
    return { ok: false, reason: "the first update cannot be the final one" };
  }
  return {
    ok: true,
    value: {
      customerLabel: label.value,
      contacts: addresses,
      kind: raw.kind,
      timeZone: raw.timeZone,
      title: title.value,
      first: first.value,
    },
  };
}

// ---------------------------------------------------------------- posting

interface Author {
  kind: AuthorKind;
  ref: string;
}

/** Post one update to a LOCKED open issue, and resolve it on a final update.
 * The caller holds the issue row FOR UPDATE, so max(n) cannot race. */
async function appendUpdateIn(
  store: Store,
  incident: IncidentRow,
  update: Required<IncidentUpdateInput>,
  author: Author,
): Promise<PostedUpdate> {
  const now = store.now();
  const last = await store.sqlGet<{ n: number | null }>(
    "select max(n) as n from incident_updates where incident_id = $1",
    [incident.id],
  );
  const n = (last?.n ?? 0) + 1;
  await store.sqlRun(
    "insert into incident_updates (id, incident_id, n, found, doing_now, " +
      "estimate_at, final, author_kind, author_ref, posted_at) " +
      "values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    [
      newUpdateId(),
      incident.id,
      n,
      update.found,
      update.doingNow,
      update.estimateAt,
      update.final ? 1 : 0,
      author.kind,
      author.ref,
      now,
    ],
  );
  if (update.final) {
    await store.sqlRun(
      "update incidents set status = 'resolved', resolved_at = $2, " +
        "version = version + 1, updated_at = $2 where id = $1",
      [incident.id, now],
    );
  }
  const customer = await store.sqlGet<CustomerRow>(
    "select id, label, link_generation from status_customers where id = $1",
    [incident.customer_id],
  );
  return {
    incidentId: incident.id,
    customerId: incident.customer_id,
    customerLabel: customer?.label ?? "",
    linkGeneration: customer?.link_generation ?? 0,
    n: incident.n,
    title: incident.title,
    kind: incident.kind,
    timeZone: incident.time_zone,
    contacts: parseContacts(incident.contacts),
    update: {
      n,
      postedAt: now,
      author: author.kind,
      found: update.found,
      doingNow: update.doingNow,
      estimateAt: update.estimateAt,
      final: update.final,
    },
  };
}

/** Lock the issue, then check and post. Must run inside a transaction. */
async function postIn(
  store: Store,
  incidentId: string,
  input: IncidentUpdateInput,
  author: Author,
): Promise<PostResult> {
  const checked = checkUpdate(input, store.now());
  // FOR UPDATE before the status and max(n) reads: without it a post can land
  // after a final update, and two posts collide on unique(incident_id, n).
  const incident = await store.sqlGet<IncidentRow>(
    `select ${INCIDENT_COLUMNS} from incidents where id = $1 for update`,
    [incidentId],
  );
  if (!incident) return { ok: false, refused: "not_found" };
  if (incident.status !== "open") return { ok: false, refused: "resolved" };
  if (!checked.ok) return invalid(checked.reason);
  return {
    ok: true,
    posted: await appendUpdateIn(store, incident, checked.value, author),
  };
}

/** Open an issue with its first update. Null for a non-operator. */
export async function openIncident(
  store: Store,
  accountId: string,
  input: OpenIncidentInput,
): Promise<PostResult | null> {
  return store.tx(async () => {
    if (!(await isOperator(store, accountId))) return null;
    const now = store.now();
    const checked = checkOpening(input, now);
    if (!checked.ok) return invalid(checked.reason);
    const opening = checked.value;
    // Get or create the customer, then LOCK it: max(n) + 1 below is per
    // customer, and two opens must not take the same number.
    await store.sqlRun(
      "insert into status_customers (id, label, link_generation, version, " +
        "created_at, updated_at) values ($1, $2, 1, 0, $3, $3) " +
        "on conflict (label) do nothing",
      [newCustomerId(), opening.customerLabel, now],
    );
    const customer = await store.sqlGet<CustomerRow>(
      "select id, label, link_generation from status_customers " +
        "where label = $1 for update",
      [opening.customerLabel],
    );
    if (!customer) throw new Error("the status customer row was not created");
    const last = await store.sqlGet<{ n: number | null }>(
      "select max(n) as n from incidents where customer_id = $1",
      [customer.id],
    );
    const incident: IncidentRow = {
      id: newIncidentId(),
      customer_id: customer.id,
      n: (last?.n ?? 0) + 1,
      title: opening.title,
      kind: opening.kind,
      time_zone: opening.timeZone,
      contacts: JSON.stringify(opening.contacts),
      status: "open",
      opened_at: now,
      opened_by: accountId,
      resolved_at: null,
    };
    await store.sqlRun(
      "insert into incidents (id, customer_id, n, title, kind, time_zone, " +
        "contacts, status, opened_at, opened_by, resolved_at, version, " +
        "created_at, updated_at) " +
        "values ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, null, 0, $8, $8)",
      [
        incident.id,
        incident.customer_id,
        incident.n,
        incident.title,
        incident.kind,
        incident.time_zone,
        incident.contacts,
        now,
        accountId,
      ],
    );
    return {
      ok: true,
      posted: await appendUpdateIn(store, incident, opening.first, {
        kind: "engineer",
        ref: accountId,
      }),
    };
  });
}

/** An engineer's update. Null for a non-operator. */
export async function postUpdateAsOperator(
  store: Store,
  accountId: string,
  incidentId: string,
  input: IncidentUpdateInput,
): Promise<PostResult | null> {
  return store.tx(async () => {
    if (!(await isOperator(store, accountId))) return null;
    return postIn(store, incidentId, input, {
      kind: "engineer",
      ref: accountId,
    });
  });
}

/** The support agent's update. Null for a bad key. */
export async function postUpdateWithKey(
  store: Store,
  key: string,
  incidentId: string,
  input: IncidentUpdateInput,
): Promise<PostResult | null> {
  return store.tx(async () => {
    if (!(await keyIsCurrent(store, key))) return null;
    return postIn(store, incidentId, input, {
      kind: "support_agent",
      ref: "key",
    });
  });
}

// --------------------------------------------------------------- the key

function keyHash(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** Is this the current write key? No key is set until an operator rotates
 * one, and then every key is refused. */
async function keyIsCurrent(store: Store, key: string): Promise<boolean> {
  if (!key || key.length > 512) return false;
  const row = await store.sqlGet<{ key_hash: string | null }>(
    "select key_hash from incident_keys where id = 'current'",
  );
  if (!row?.key_hash) return false;
  return sameText(keyHash(key), row.key_hash);
}

/** The open issues, or only the due ones. Null for a bad key. */
export async function incidentsWithKey(
  store: Store,
  key: string,
  options: { dueOnly: boolean },
): Promise<DueIncidentItem[] | null> {
  return store.tx(async () => {
    if (!(await keyIsCurrent(store, key))) return null;
    const now = store.now();
    const incidents = await store.sqlAll<IncidentRow & { label: string }>(
      `select ${INCIDENT_COLUMNS.split(", ")
        .map((c) => `i.${c}`)
        .join(", ")}, c.label from incidents i ` +
        "join status_customers c on c.id = i.customer_id " +
        "where i.status = 'open' order by i.opened_at, i.n",
    );
    const updates = await updatesOf(
      store,
      incidents.map((i) => i.id),
    );
    const out: DueIncidentItem[] = [];
    for (const incident of incidents) {
      const last = lastUpdateAt(incident, updates.get(incident.id) ?? []);
      if (options.dueOnly && now - last < DUE_AFTER_MS) continue;
      const dueAt = last + UPDATE_EVERY_MS;
      out.push({
        id: incident.id,
        customerLabel: incident.label,
        n: incident.n,
        title: incident.title,
        kind: incident.kind,
        lastUpdateAt: last,
        dueAt,
        lateByMs: Math.max(0, now - dueAt),
      });
    }
    return out;
  });
}

/** Kill a customer's link and return the new token. Null for a non-operator
 * or an unknown customer. */
export async function remakeStatusLink(
  store: Store,
  accountId: string,
  secret: string,
  customerId: string,
): Promise<{ token: string } | null> {
  if (!CUSTOMER_ID.test(customerId)) return null;
  return store.tx(async () => {
    if (!(await isOperator(store, accountId))) return null;
    const customer = await store.sqlGet<CustomerRow>(
      "select id, label, link_generation from status_customers " +
        "where id = $1 for update",
      [customerId],
    );
    if (!customer) return null;
    const generation = customer.link_generation + 1;
    await store.sqlRun(
      "update status_customers set link_generation = $2, " +
        "version = version + 1, updated_at = $3 where id = $1",
      [customer.id, generation, store.now()],
    );
    return { token: statusToken(secret, customer.id, generation) };
  });
}

/** Make a new write key, kill the old one, and return the new one. It is
 * shown once. Null for a non-operator. */
export async function rotateIncidentKey(
  store: Store,
  accountId: string,
): Promise<{ key: string } | null> {
  return store.tx(async () => {
    if (!(await isOperator(store, accountId))) return null;
    // 256 random bits; only the hash is kept.
    const key = randomBytes(32).toString("base64url");
    const now = store.now();
    await store.sqlRun(
      "update incident_keys set key_hash = $1, rotated_at = $2, " +
        "rotated_by = $3, version = version + 1, updated_at = $2 " +
        "where id = 'current'",
      [keyHash(key), now, `account:${accountId}`],
    );
    return { key };
  });
}
