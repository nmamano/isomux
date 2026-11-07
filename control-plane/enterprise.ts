// Enterprise accounts on the storefront (task 71718489).
//
// A company's IT signs in to the storefront, sets up one enterprise account
// (company, billing email, plan, seat count N), signs the standard agreement,
// and gets the account's secret. Each of the company's self-hosted offices
// sends that secret to the seat service (S2) to take a seat before it adds a
// member. A negotiated account is made by an operator from the CLI and is
// never set up or signed on the page.
//
// The secret is not stored: it is an HMAC of the account id and its
// secret_generation under a key derived from AUTH_SECRET (enterpriseSecret),
// the scheme of the status links (incidents.ts statusToken). The page
// recomputes it, a database copy gives none, and "make a new secret" bumps the
// generation, which kills the old one. A new AUTH_SECRET kills every one.
//
// Every write takes the account row with `for update`, checks it, and appends
// its audit row in the same transaction. Every time decision reads
// store.now(), never the wall clock.

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Store } from "./store.ts";
import { nextInvoice, type EnterprisePlan } from "./enterprise-billing.ts";

export type { EnterprisePlan };
export type EnterpriseKind = "standard" | "negotiated";

/** The context string of the secret's HMAC key (enterpriseSecret). */
export const ENTERPRISE_SECRET_CONTEXT = "isomux-enterprise-secret-v1";
/** Every secret starts with this, so a pasted value is recognisable. */
export const ENTERPRISE_SECRET_PREFIX = "isx_ent_";

/** The one standard agreement IT signs on the page. The PDF is the record:
 * a signature stores this version and the PDF's sha256. A new PDF needs a new
 * version. `pdfPath` is relative to control-plane/. */
export const AGREEMENT = {
  version: "2026-11-06-draft-5",
  pdfPath: "web/public/enterprise/isomux-agreement-5.pdf",
  publicPath: "/enterprise/isomux-agreement-5.pdf",
  sha256: "badfdf93a1e1d210267d69f9aa9c5d447a1e27b5f9bc4966d49273ba5eaecec3",
} as const;

/** Sanity bounds, not product limits. */
export const MAX_SEATS = 10_000;
export const MAX_COMPANY_LENGTH = 200;
export const MAX_SIGNER_LENGTH = 200;
export const MAX_EMAIL_LENGTH = 254;
export const MAX_PRICE_NOTE_LENGTH = 500;

export interface EnterpriseOfficeView {
  id: string;
  name: string | null;
  members: number;
  joinedAt: number;
  lastSeenAt: number;
}

export interface EnterpriseSignature {
  name: string;
  title: string;
  at: number;
  agreementVersion: string;
}

/** What the account page shows. */
export interface EnterpriseView {
  id: string;
  company: string;
  billingEmail: string;
  plan: EnterprisePlan;
  seats: number;
  kind: EnterpriseKind;
  /** Negotiated accounts only. */
  priceNote: string | null;
  /** Null for a standard account not signed yet. */
  signature: EnterpriseSignature | null;
  /** The contract year's anchor: the signature, or the negotiated start. */
  contractStart: number | null;
  /** Members across the offices not removed. */
  inUse: number;
  /** Offices not removed, oldest first. */
  offices: EnterpriseOfficeView[];
  /** Null while a standard account is not signed. */
  secret: string | null;
  /** A signed standard account's next invoice (enterprise-billing.ts
   * nextInvoice): when, and its amount so far; null amount for a quarter with
   * no seat added yet. Null for a negotiated or unsigned account. */
  nextInvoice: { issuedAt: number; amountCents: number | null } | null;
}

interface AccountRow {
  id: string;
  account_id: string;
  company: string;
  billing_email: string;
  plan: EnterprisePlan;
  seats: number;
  kind: EnterpriseKind;
  price_note: string | null;
  secret_generation: number;
  signer_name: string | null;
  signer_title: string | null;
  signed_at: string | number | null;
  agreement_version: string | null;
  contract_start: string | number | null;
}

interface OfficeRow {
  id: string;
  name: string | null;
  members: number;
  joined_at: string | number;
  last_seen_at: string | number;
}

const ACCOUNT_COLUMNS =
  "id, account_id, company, billing_email, plan, seats, kind, price_note, " +
  "secret_generation, signer_name, signer_title, signed_at, " +
  "agreement_version, contract_start";

/** An enterprise id as newEnterpriseId makes it. */
const ENTERPRISE_ID =
  /^ent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENTERPRISE_ID_LENGTH = 40;

function secretMac(authSecret: string, id: string, generation: number): string {
  const key = createHmac("sha256", authSecret)
    .update(ENTERPRISE_SECRET_CONTEXT)
    .digest();
  return createHmac("sha256", key)
    .update(`${id}:${generation}`)
    .digest("base64url");
}

/** The id and MAC of a well-formed secret. The MAC is base64url, which may
 * hold "_", so the id is cut by its fixed length. */
function parseSecret(secret: unknown): { id: string; mac: string } | null {
  if (typeof secret !== "string" || secret.length > 200) return null;
  if (!secret.startsWith(ENTERPRISE_SECRET_PREFIX)) return null;
  const rest = secret.slice(ENTERPRISE_SECRET_PREFIX.length);
  const id = rest.slice(0, ENTERPRISE_ID_LENGTH);
  if (!ENTERPRISE_ID.test(id) || rest[ENTERPRISE_ID_LENGTH] !== "_")
    return null;
  return { id, mac: rest.slice(ENTERPRISE_ID_LENGTH + 1) };
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function num(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function isSigned(row: AccountRow): boolean {
  return row.kind === "negotiated" || row.signed_at !== null;
}

function audit(
  store: Store,
  actor: string,
  enterpriseId: string,
  action: string,
  detail: string | null = null,
): Promise<unknown> {
  return store.appendAudit({
    actor,
    instance_id: null,
    action,
    target: enterpriseId,
    outcome: "succeeded",
    detail,
  });
}

/** One change of N, in the transaction that makes it (S4's history). */
function recordSeatChange(
  store: Store,
  enterpriseId: string,
  at: number,
  from: number,
  to: number,
): Promise<unknown> {
  return store.sqlRun(
    "insert into enterprise_seat_changes (id, enterprise_id, at, from_seats, to_seats) " +
      "values ($1, $2, $3, $4, $5)",
    [randomUUID(), enterpriseId, at, from, to],
  );
}

async function lockedAccountFor(
  store: Store,
  accountId: string,
): Promise<AccountRow | null> {
  return store.sqlGet<AccountRow>(
    `select ${ACCOUNT_COLUMNS} from enterprise_accounts where account_id = $1 for update`,
    [accountId],
  );
}

async function seatsInUse(store: Store, enterpriseId: string): Promise<number> {
  const row = await store.sqlGet<{ n: string | number | null }>(
    "select coalesce(sum(members), 0) as n from enterprise_offices " +
      "where enterprise_id = $1 and removed_at is null",
    [enterpriseId],
  );
  return Number(row?.n ?? 0);
}

function validSeats(seats: unknown): seats is number {
  return (
    typeof seats === "number" &&
    Number.isInteger(seats) &&
    seats >= 1 &&
    seats <= MAX_SEATS
  );
}

function validPlan(plan: unknown): plan is EnterprisePlan {
  return plan === "monthly" || plan === "yearly";
}

/** Trimmed, or null when empty or longer than `max`. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > max ? null : trimmed;
}

function validEmail(value: unknown): string | null {
  const email = text(value, MAX_EMAIL_LENGTH);
  return email && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
}

/** The account's secret for a generation. */
export function enterpriseSecret(
  authSecret: string,
  enterpriseId: string,
  generation: number,
): string {
  return (
    ENTERPRISE_SECRET_PREFIX +
    enterpriseId +
    "_" +
    secretMac(authSecret, enterpriseId, generation)
  );
}

/** The account a secret names, when it is the current one. Null for a
 * malformed, unknown or old secret. `signed` is false for a standard account
 * not signed yet (the seat service answers 403 not_signed). */
export async function enterpriseForSecret(
  store: Store,
  authSecret: string,
  secret: string,
): Promise<{ enterpriseId: string; signed: boolean } | null> {
  const parsed = parseSecret(secret);
  if (!parsed) return null;
  const row = await store.sqlGet<AccountRow>(
    `select ${ACCOUNT_COLUMNS} from enterprise_accounts where id = $1`,
    [parsed.id],
  );
  if (!row) return null;
  const expected = secretMac(authSecret, row.id, row.secret_generation);
  if (!sameText(parsed.mac, expected)) return null;
  return { enterpriseId: row.id, signed: isSigned(row) };
}

/** The signed-in account's enterprise account, or null when it has none. */
export async function enterpriseFor(
  store: Store,
  accountId: string,
  authSecret: string,
): Promise<EnterpriseView | null> {
  return store.tx(async () => {
    const row = await store.sqlGet<AccountRow>(
      `select ${ACCOUNT_COLUMNS} from enterprise_accounts where account_id = $1`,
      [accountId],
    );
    if (!row) return null;
    const offices = await store.sqlAll<OfficeRow>(
      "select id, name, members, joined_at, last_seen_at from enterprise_offices " +
        "where enterprise_id = $1 and removed_at is null order by joined_at, id",
      [row.id],
    );
    const signed = isSigned(row);
    let next: EnterpriseView["nextInvoice"] = null;
    if (row.kind === "standard" && row.contract_start !== null) {
      const history = await store.sqlAll<{
        at: string | number;
        from_seats: number;
        to_seats: number;
      }>(
        "select at, from_seats, to_seats from enterprise_seat_changes " +
          "where enterprise_id = $1 order by at, id",
        [row.id],
      );
      const upcoming = nextInvoice(
        row.plan,
        Number(row.contract_start),
        history.map((h) => ({
          at: Number(h.at),
          from: Number(h.from_seats),
          to: Number(h.to_seats),
        })),
        store.now(),
      );
      next = {
        issuedAt: upcoming.period.issuedAt,
        amountCents: upcoming.amountCents,
      };
    }
    return {
      id: row.id,
      company: row.company,
      billingEmail: row.billing_email,
      plan: row.plan,
      seats: Number(row.seats),
      kind: row.kind,
      priceNote: row.price_note,
      signature:
        row.signed_at !== null && row.signer_name !== null
          ? {
              name: row.signer_name,
              title: row.signer_title ?? "",
              at: Number(row.signed_at),
              agreementVersion: row.agreement_version ?? "",
            }
          : null,
      contractStart: num(row.contract_start),
      inUse: offices.reduce((sum, o) => sum + Number(o.members), 0),
      offices: offices.map((o) => ({
        id: o.id,
        name: o.name,
        members: Number(o.members),
        joinedAt: Number(o.joined_at),
        lastSeenAt: Number(o.last_seen_at),
      })),
      secret: signed
        ? enterpriseSecret(authSecret, row.id, row.secret_generation)
        : null,
      nextInvoice: next,
    };
  });
}

export interface CreateEnterpriseInput {
  company: string;
  /** Normalized by the caller (the route's normalizeEmail). */
  billingEmail: string;
  plan: EnterprisePlan;
  seats: number;
}

export type CreateEnterpriseResult =
  | { ok: true; id: string }
  | { ok: false; reason: "exists" }
  | {
      ok: false;
      reason: "invalid";
      field: "company" | "billingEmail" | "plan" | "seats";
    };

/** Set up the signed-in account's enterprise account, standard and unsigned.
 * One per sign-in: a second create answers "exists". Audits
 * enterprise.created. */
export async function createEnterprise(
  store: Store,
  accountId: string,
  input: CreateEnterpriseInput,
): Promise<CreateEnterpriseResult> {
  const company = text(input.company, MAX_COMPANY_LENGTH);
  if (!company) return { ok: false, reason: "invalid", field: "company" };
  const billingEmail = validEmail(input.billingEmail);
  if (!billingEmail)
    return { ok: false, reason: "invalid", field: "billingEmail" };
  if (!validPlan(input.plan))
    return { ok: false, reason: "invalid", field: "plan" };
  if (!validSeats(input.seats))
    return { ok: false, reason: "invalid", field: "seats" };
  return store.tx(async () => {
    const id = `ent-${randomUUID()}`;
    const now = store.now();
    // on conflict, not a caught unique violation: a failed statement aborts
    // the transaction, and two tabs creating at once must read "exists".
    const made = await store.sqlGet<{ id: string }>(
      "insert into enterprise_accounts (id, account_id, company, billing_email, " +
        "plan, seats, kind, created_at, updated_at) " +
        "values ($1, $2, $3, $4, $5, $6, 'standard', $7, $7) " +
        "on conflict (account_id) do nothing returning id",
      [id, accountId, company, billingEmail, input.plan, input.seats, now],
    );
    if (!made) return { ok: false, reason: "exists" };
    await recordSeatChange(store, id, now, 0, input.seats);
    await audit(
      store,
      `account:${accountId}`,
      id,
      "enterprise.created",
      `${input.plan} ${input.seats}`,
    );
    return { ok: true, id };
  });
}

export interface SignAgreementInput {
  name: string;
  title: string;
  /** The "I am authorized to sign for <company>" box. */
  authority: boolean;
}

export type SignAgreementResult =
  | { ok: true }
  | {
      ok: false;
      reason: "no_account" | "already_signed" | "negotiated";
    }
  | { ok: false; reason: "invalid"; field: "name" | "title" | "authority" };

/** Sign AGREEMENT for the account's company. Stores the signer, signed_at,
 * contract_start = signed_at, AGREEMENT.version and AGREEMENT.sha256. Audits
 * enterprise.signed. */
export async function signAgreement(
  store: Store,
  accountId: string,
  input: SignAgreementInput,
): Promise<SignAgreementResult> {
  const name = text(input.name, MAX_SIGNER_LENGTH);
  if (!name) return { ok: false, reason: "invalid", field: "name" };
  const title = text(input.title, MAX_SIGNER_LENGTH);
  if (!title) return { ok: false, reason: "invalid", field: "title" };
  if (input.authority !== true)
    return { ok: false, reason: "invalid", field: "authority" };
  return store.tx(async () => {
    const row = await lockedAccountFor(store, accountId);
    if (!row) return { ok: false, reason: "no_account" };
    if (row.kind === "negotiated") return { ok: false, reason: "negotiated" };
    if (row.signed_at !== null) return { ok: false, reason: "already_signed" };
    const now = store.now();
    await store.sqlRun(
      "update enterprise_accounts set signer_name = $2, signer_title = $3, " +
        "signed_at = $4, contract_start = $4, agreement_version = $5, " +
        "agreement_sha256 = $6, version = version + 1, updated_at = $4 " +
        "where id = $1",
      [row.id, name, title, now, AGREEMENT.version, AGREEMENT.sha256],
    );
    await audit(
      store,
      `account:${accountId}`,
      row.id,
      "enterprise.signed",
      AGREEMENT.version,
    );
    return { ok: true };
  });
}

export type ChangeSeatsResult =
  | { ok: true; seats: number }
  | { ok: false; reason: "no_account" | "not_signed" }
  | { ok: false; reason: "invalid" }
  | {
      ok: false;
      /** stale: current seats != from. below_in_use: to < inUse.
       * yearly_decrease: to < from on a yearly plan. */
      reason: "stale" | "below_in_use" | "yearly_decrease";
      seats: number;
      inUse: number;
    };

/** Change N from `from` to `to` (an integer 1..MAX_SEATS). Audits
 * enterprise.seats_changed with detail "<from> -> <to>". */
export async function changeSeats(
  store: Store,
  accountId: string,
  change: { from: number; to: number },
): Promise<ChangeSeatsResult> {
  // `from` is the N IT saw, compared with the current one, not a new count:
  // a check-in can raise N past MAX_SEATS, and IT must still change it then.
  const from: unknown = change.from;
  if (
    !validSeats(change.to) ||
    typeof from !== "number" ||
    !Number.isInteger(from) ||
    from < 1
  )
    return { ok: false, reason: "invalid" };
  return store.tx(async () => {
    const row = await lockedAccountFor(store, accountId);
    if (!row) return { ok: false, reason: "no_account" };
    if (!isSigned(row)) return { ok: false, reason: "not_signed" };
    const seats = Number(row.seats);
    const inUse = await seatsInUse(store, row.id);
    if (seats !== change.from)
      return { ok: false, reason: "stale", seats, inUse };
    if (row.plan === "yearly" && change.to < change.from)
      return { ok: false, reason: "yearly_decrease", seats, inUse };
    if (change.to < inUse)
      return { ok: false, reason: "below_in_use", seats, inUse };
    if (change.to === seats) return { ok: true, seats };
    const now = store.now();
    await store.sqlRun(
      "update enterprise_accounts set seats = $2, version = version + 1, " +
        "updated_at = $3 where id = $1",
      [row.id, change.to, now],
    );
    await recordSeatChange(store, row.id, now, seats, change.to);
    await audit(
      store,
      `account:${accountId}`,
      row.id,
      "enterprise.seats_changed",
      `${seats} -> ${change.to}`,
    );
    return { ok: true, seats: change.to };
  });
}

export type RenewSecretResult =
  | { ok: true; secret: string }
  | { ok: false; reason: "no_account" | "not_signed" };

/** Make a new secret: bump the generation, which kills the old one. Audits
 * enterprise.secret_renewed. */
export async function renewSecret(
  store: Store,
  accountId: string,
  authSecret: string,
): Promise<RenewSecretResult> {
  return store.tx(async () => {
    const row = await lockedAccountFor(store, accountId);
    if (!row) return { ok: false, reason: "no_account" };
    if (!isSigned(row)) return { ok: false, reason: "not_signed" };
    const generation = Number(row.secret_generation) + 1;
    await store.sqlRun(
      "update enterprise_accounts set secret_generation = $2, " +
        "version = version + 1, updated_at = $3 where id = $1",
      [row.id, generation, store.now()],
    );
    await audit(
      store,
      `account:${accountId}`,
      row.id,
      "enterprise.secret_renewed",
      `generation ${generation}`,
    );
    return {
      ok: true,
      secret: enterpriseSecret(authSecret, row.id, generation),
    };
  });
}

/** Most offices an account keeps active at once; a new or returning office
 * past it is refused (bad_request). A sanity bound: it keeps the raised seat
 * count inside int4 and the offices list a page. */
export const MAX_OFFICES = 1000;
/** Most members one office may report. */
export const MAX_OFFICE_MEMBERS = 100_000;
export const MAX_OFFICE_NAME_LENGTH = 100;

export type RecordSeatsResult =
  | {
      ok: true;
      company: string;
      kind: EnterpriseKind;
      seats: number;
      inUse: number;
      /** Offices not removed. */
      offices: number;
    }
  | { ok: false; reason: "bad_secret" | "not_signed" | "bad_request" }
  | { ok: false; reason: "seats_full"; seats: number; inUse: number };

const OFFICE_ID = /^[0-9a-f]{32}$/;

interface SeatCall {
  office: string;
  members: number;
  add: boolean;
}

function seatCall(body: unknown): SeatCall | null {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return null;
  const { office, members, add } = body as Record<string, unknown>;
  if (typeof office !== "string" || !OFFICE_ID.test(office)) return null;
  if (
    typeof members !== "number" ||
    !Number.isInteger(members) ||
    members < 0 ||
    members > MAX_OFFICE_MEMBERS
  )
    return null;
  if (typeof add !== "boolean") return null;
  return { office, members, add };
}

/**
 * The seat service (POST /api/enterprise/v1/seats). `body` is the parsed
 * JSON, or undefined when it did not parse.
 *
 * The secret is checked first, so a caller without it learns nothing about
 * the body rules: once on a plain read, so a bad one never takes the row lock,
 * and again under the lock, so a new secret that commits first wins. Every
 * count is read under the account row lock, so two adds on the last seat
 * cannot both pass.
 *
 * add=true takes a seat before the office adds a member: refused (seats_full)
 * when the other offices' members plus `members` pass N, and then nothing is
 * written. add=false (a check-in, a release, a first join) is never refused:
 * it records the count, and raises N to the count in use when it is over.
 * A new office, or one IT removed, joins on its call (audited) and keeps its
 * name and first join time; past MAX_OFFICES active offices it is
 * bad_request. A plain check-in is not audited.
 */
export async function recordSeats(
  store: Store,
  authSecret: string,
  secret: string,
  body: unknown,
): Promise<RecordSeatsResult> {
  const known = await enterpriseForSecret(store, authSecret, secret);
  if (!known) return { ok: false, reason: "bad_secret" };
  const input = seatCall(body);
  if (!input) return { ok: false, reason: "bad_request" };
  return store.tx(async (): Promise<RecordSeatsResult> => {
    const row = await store.sqlGet<AccountRow>(
      `select ${ACCOUNT_COLUMNS} from enterprise_accounts where id = $1 for update`,
      [known.enterpriseId],
    );
    const parsed = parseSecret(secret);
    if (
      !row ||
      !parsed ||
      !sameText(
        parsed.mac,
        secretMac(authSecret, row.id, row.secret_generation),
      )
    )
      return { ok: false, reason: "bad_secret" };
    if (!isSigned(row)) return { ok: false, reason: "not_signed" };
    const others = await store.sqlGet<{
      members: string | number;
      offices: string | number;
    }>(
      "select coalesce(sum(members), 0) as members, count(*) as offices " +
        "from enterprise_offices " +
        "where enterprise_id = $1 and removed_at is null and id <> $2",
      [row.id, input.office],
    );
    const otherMembers = Number(others?.members ?? 0);
    const otherOffices = Number(others?.offices ?? 0);
    const own = await store.sqlGet<{
      members: number;
      removed_at: string | number | null;
    }>(
      "select members, removed_at from enterprise_offices " +
        "where enterprise_id = $1 and id = $2",
      [row.id, input.office],
    );
    const active = own !== null && own.removed_at === null;
    if (!active && otherOffices >= MAX_OFFICES)
      return { ok: false, reason: "bad_request" };
    const seats = Number(row.seats);
    const inUse = otherMembers + input.members;
    if (input.add && inUse > seats) {
      return {
        ok: false,
        reason: "seats_full",
        seats,
        inUse: otherMembers + (active ? Number(own.members) : 0),
      };
    }
    const now = store.now();
    const actor = `office:${input.office}`;
    await store.sqlRun(
      "insert into enterprise_offices " +
        "(enterprise_id, id, members, joined_at, last_seen_at) " +
        "values ($1, $2, $3, $4, $4) " +
        "on conflict (enterprise_id, id) do update set members = $3, " +
        "last_seen_at = $4, removed_at = null",
      [row.id, input.office, input.members, now],
    );
    if (!active)
      await audit(
        store,
        actor,
        row.id,
        "enterprise.office_joined",
        input.office,
      );
    let newSeats = seats;
    if (inUse > seats) {
      newSeats = inUse;
      await store.sqlRun(
        "update enterprise_accounts set seats = $2, version = version + 1, " +
          "updated_at = $3 where id = $1",
        [row.id, newSeats, now],
      );
      await recordSeatChange(store, row.id, now, seats, newSeats);
      await audit(
        store,
        actor,
        row.id,
        "enterprise.seats_raised",
        `${seats} -> ${newSeats}`,
      );
    }
    return {
      ok: true,
      company: row.company,
      kind: row.kind,
      seats: newSeats,
      inUse,
      offices: otherOffices + 1,
    };
  });
}

export type OfficeChangeResult =
  | { ok: true }
  | { ok: false; reason: "no_account" | "not_found" | "invalid" };

/** Lock the caller's account and change one of its offices not removed.
 * `write` gets the enterprise id and the office id. */
async function changeOffice(
  store: Store,
  accountId: string,
  office: unknown,
  action: string,
  write: (enterpriseId: string, office: string) => Promise<unknown>,
): Promise<OfficeChangeResult> {
  if (typeof office !== "string" || !OFFICE_ID.test(office))
    return { ok: false, reason: "invalid" };
  return store.tx(async (): Promise<OfficeChangeResult> => {
    const row = await lockedAccountFor(store, accountId);
    if (!row) return { ok: false, reason: "no_account" };
    const found = await store.sqlGet<{ id: string }>(
      "select id from enterprise_offices " +
        "where enterprise_id = $1 and id = $2 and removed_at is null",
      [row.id, office],
    );
    if (!found) return { ok: false, reason: "not_found" };
    await write(row.id, office);
    await audit(store, `account:${accountId}`, row.id, action, office);
    return { ok: true };
  });
}

/** IT names an office on the account page (1..MAX_OFFICE_NAME_LENGTH
 * characters, trimmed). Audits enterprise.office_renamed. */
export async function renameOffice(
  store: Store,
  accountId: string,
  change: { office: unknown; name: unknown },
): Promise<OfficeChangeResult> {
  const name = text(change.name, MAX_OFFICE_NAME_LENGTH);
  if (name === null) return { ok: false, reason: "invalid" };
  return changeOffice(
    store,
    accountId,
    change.office,
    "enterprise.office_renamed",
    (enterpriseId, office) =>
      store.sqlRun(
        "update enterprise_offices set name = $3 " +
          "where enterprise_id = $1 and id = $2",
        [enterpriseId, office, name],
      ),
  );
}

/** IT removes a shut-down office: its members leave the count, and it
 * rejoins on its next call. Audits enterprise.office_removed. */
export async function removeOffice(
  store: Store,
  accountId: string,
  change: { office: unknown },
): Promise<OfficeChangeResult> {
  return changeOffice(
    store,
    accountId,
    change.office,
    "enterprise.office_removed",
    (enterpriseId, office) =>
      store.sqlRun(
        "update enterprise_offices set removed_at = $3 " +
          "where enterprise_id = $1 and id = $2",
        [enterpriseId, office, store.now()],
      ),
  );
}

export interface NegotiatedInput {
  /** The storefront sign-in email of the customer's IT. */
  email: string;
  company: string;
  /** Defaults to the account's email. */
  billingEmail?: string;
  plan: EnterprisePlan;
  seats: number;
  priceNote: string;
  /** The contract start; defaults to store.now(). */
  start?: number;
}

export type NegotiatedResult =
  | { ok: true; id: string }
  | { ok: false; reason: "no_account" | "exists" }
  | { ok: false; reason: "invalid"; field: string };

/** An operator records a negotiated account: kind negotiated, signed outside
 * the page, contract_start = start. Audits enterprise.created with actor
 * "operator". */
export async function createNegotiatedEnterprise(
  store: Store,
  input: NegotiatedInput,
): Promise<NegotiatedResult> {
  const company = text(input.company, MAX_COMPANY_LENGTH);
  if (!company) return { ok: false, reason: "invalid", field: "company" };
  if (!validPlan(input.plan))
    return { ok: false, reason: "invalid", field: "plan" };
  if (!validSeats(input.seats))
    return { ok: false, reason: "invalid", field: "seats" };
  const priceNote = text(input.priceNote, MAX_PRICE_NOTE_LENGTH);
  if (!priceNote) return { ok: false, reason: "invalid", field: "priceNote" };
  const email = validEmail(input.email?.toLowerCase());
  if (!email) return { ok: false, reason: "invalid", field: "email" };
  let billingEmail = email;
  if (input.billingEmail !== undefined) {
    const b = validEmail(input.billingEmail.toLowerCase());
    if (!b) return { ok: false, reason: "invalid", field: "billingEmail" };
    billingEmail = b;
  }
  return store.tx(async () => {
    const account = await store.sqlGet<{ id: string }>(
      "select id from accounts where email = $1",
      [email],
    );
    if (!account) return { ok: false, reason: "no_account" };
    const id = `ent-${randomUUID()}`;
    const now = store.now();
    const start = input.start ?? now;
    const made = await store.sqlGet<{ id: string }>(
      "insert into enterprise_accounts (id, account_id, company, billing_email, " +
        "plan, seats, kind, price_note, contract_start, created_at, updated_at) " +
        "values ($1, $2, $3, $4, $5, $6, 'negotiated', $7, $8, $9, $9) " +
        "on conflict (account_id) do nothing returning id",
      [
        id,
        account.id,
        company,
        billingEmail,
        input.plan,
        input.seats,
        priceNote,
        start,
        now,
      ],
    );
    if (!made) return { ok: false, reason: "exists" };
    await recordSeatChange(store, id, now, 0, input.seats);
    await audit(
      store,
      "operator",
      id,
      "enterprise.created",
      `negotiated ${input.plan} ${input.seats}`,
    );
    return { ok: true, id };
  });
}
