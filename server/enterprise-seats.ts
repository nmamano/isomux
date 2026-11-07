// Enterprise seats, the office side (task 8b80e61f; design in task 71718489).
// An office whose owner checks "This office is part of an Enterprise Contract"
// and pastes the account's secret asks the seat service on cloud.isomux.com
// for a seat before each member add, releases it after a removal, and checks
// in every hour. It sends its random office id and its member count only.
//
// The lock: while the box is on and no secret was ever accepted, messages to
// agents (the officeNotEnterpriseLocked route precondition) and member adds
// are refused. The office stays usable otherwise. Once a secret is accepted
// nothing is locked again: an outage, a rejected secret or a full account
// show in Settings and refuse new adds only.
//
// One object per office (createEnterpriseSeats), so the test harness never
// inherits state from a previous boot.

import type {
  EnterpriseProblem,
  EnterpriseSeatAnswer,
  EnterpriseViewRes,
} from "../shared/contract-shapes.ts";
import { randomBytes } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { isHostedAccess, type InstallKind } from "./install-kind.ts";
import { atomicWriteFileSync } from "./persistence.ts";

export const ENTERPRISE_SEATS_URL =
  "https://cloud.isomux.com/api/enterprise/v1/seats";
export const ENTERPRISE_SEATS_TIMEOUT_MS = 10_000;
// Longest secret the office sends. The service makes much shorter ones.
export const ENTERPRISE_SECRET_MAX = 512;

// The service's refusals (400/401/403/409/429), by the contract.
export const SEAT_REFUSALS = [
  "bad_request",
  "bad_secret",
  "not_signed",
  "seats_full",
  "rate_limited",
] as const;
export type SeatRefusal = (typeof SEAT_REFUSALS)[number];

export type SeatCallResult =
  | { kind: "ok"; answer: EnterpriseSeatAnswer }
  | { kind: "refused"; reason: SeatRefusal; seats?: number; inUse?: number }
  // A network error, a timeout, a redirect, a 5xx or a 200 with a bad body.
  | { kind: "unreachable" };

// Why the office refused a member add or a secret.
export type EnterpriseRefusal =
  | SeatRefusal
  // The box is on and no secret was accepted yet.
  | "secret_needed"
  // A pasted secret the service could not check.
  | "unreachable"
  // A pasted secret that cannot go in a header.
  | "invalid_secret"
  // A secret pasted while the box is off.
  | "off";

// The route error codes for each refusal.
export const ENTERPRISE_ERROR_CODES: Record<EnterpriseRefusal, string> = {
  seats_full: "seats_full",
  bad_secret: "enterprise_secret_rejected",
  not_signed: "enterprise_not_signed",
  rate_limited: "enterprise_rate_limited",
  secret_needed: "enterprise_secret_needed",
  bad_request: "enterprise_bad_request",
  unreachable: "enterprise_unreachable",
  invalid_secret: "invalid_secret",
  off: "enterprise_off",
};

export type EnterpriseView = EnterpriseViewRes;

export type EnterpriseOutcome<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: EnterpriseRefusal;
      seats?: number;
      inUse?: number;
    };

export interface EnterpriseSeatsDeps {
  stateRoot: string;
  // The office's active members (users.json; a pendingSignIn member counts).
  countMembers: () => number;
  installKind: InstallKind;
  publicOrigin: () => string | null;
  url?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface EnterpriseSeats {
  available(): boolean;
  view(): EnterpriseView;
  locked(): boolean;
  // Box on: locked until a secret is accepted. Box off: a best-effort
  // members=0 call, then the secret and the accepted state go.
  setEnabled(enabled: boolean): Promise<EnterpriseView>;
  // The first join (add=false). Only a 200 stores the secret.
  pasteSecret(secret: string): Promise<EnterpriseOutcome<EnterpriseView>>;
  // Runs `add` after a seat is granted (or the service is unreachable).
  // Calls go one at a time; the count is read inside the lock.
  takeSeat<T>(add: () => T | Promise<T>): Promise<EnterpriseOutcome<T>>;
  // Fire and forget: add=false with the count at send time.
  release(): void;
  checkIn(): Promise<EnterpriseView>;
}

const REFUSAL_BY_STATUS: Record<number, SeatRefusal> = {
  400: "bad_request",
  401: "bad_secret",
  403: "not_signed",
  409: "seats_full",
  429: "rate_limited",
};

const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

function answerOf(body: unknown): EnterpriseSeatAnswer | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.company !== "string") return null;
  if (b.kind !== "standard" && b.kind !== "negotiated") return null;
  if (!count(b.seats) || !count(b.inUse) || !count(b.offices)) return null;
  return {
    company: b.company,
    kind: b.kind,
    seats: b.seats,
    inUse: b.inUse,
    offices: b.offices,
  };
}

// A value that can go in an Authorization header as is: printable ASCII with
// no space. Anything else would make fetch throw, which reads as an outage.
export function headerSafeSecret(raw: string): string | null {
  const secret = raw.trim();
  if (secret.length === 0 || secret.length > ENTERPRISE_SECRET_MAX) return null;
  return /^[\x21-\x7e]+$/.test(secret) ? secret : null;
}

// One call to the seat service. Never throws. The bearer never follows a
// redirect: a 3xx is "unreachable", like a 5xx or no answer in time.
export async function seatCall(input: {
  url: string;
  secret: string;
  office: string;
  members: number;
  add: boolean;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<SeatCallResult> {
  const signal = AbortSignal.timeout(input.timeoutMs);
  // The deadline covers the body read too.
  const deadline = new Promise<SeatCallResult>((resolve) =>
    signal.addEventListener("abort", () => resolve({ kind: "unreachable" }), {
      once: true,
    }),
  );
  const call = async (): Promise<SeatCallResult> => {
    const res = await (input.fetchImpl ?? fetch)(input.url, {
      method: "POST",
      redirect: "manual",
      signal,
      headers: {
        Authorization: `Bearer ${input.secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        office: input.office,
        members: input.members,
        add: input.add,
      }),
    });
    const body: unknown = await res.json().catch(() => null);
    if (res.status === 200) {
      const answer = answerOf(body);
      return answer ? { kind: "ok", answer } : { kind: "unreachable" };
    }
    const reason = REFUSAL_BY_STATUS[res.status];
    if (!reason) return { kind: "unreachable" };
    const b = (body ?? {}) as Record<string, unknown>;
    return {
      kind: "refused",
      reason,
      ...(count(b.seats) ? { seats: b.seats } : {}),
      ...(count(b.inUse) ? { inUse: b.inUse } : {}),
    };
  };
  try {
    return await Promise.race([call(), deadline]);
  } catch {
    return { kind: "unreachable" };
  }
}

interface Stored {
  enabled: boolean;
  officeId: string | null;
  accepted: EnterpriseConnected | null;
  problem: EnterpriseProblem | null;
}
type EnterpriseConnected = NonNullable<EnterpriseViewRes["connected"]>;

const OFF: Stored = {
  enabled: false,
  officeId: null,
  accepted: null,
  problem: null,
};

// A damaged file reads as off: it must never stop the boot.
function loadStored(path: string): Stored {
  if (!existsSync(path)) return { ...OFF };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Stored>;
    const accepted = raw.accepted ? answerOf(raw.accepted) : null;
    const problems: (EnterpriseProblem | null)[] = [
      "bad_secret",
      "not_signed",
      "unreachable",
    ];
    return {
      enabled: raw.enabled === true,
      officeId:
        typeof raw.officeId === "string" && /^[0-9a-f]{32}$/.test(raw.officeId)
          ? raw.officeId
          : null,
      accepted:
        accepted && typeof raw.accepted?.checkedAt === "number"
          ? { ...accepted, checkedAt: raw.accepted.checkedAt }
          : null,
      problem: problems.includes(raw.problem ?? null)
        ? (raw.problem ?? null)
        : null,
    };
  } catch (err) {
    console.error(
      "[enterprise-seats] the state file is damaged; the box reads as off:",
      err instanceof Error ? err.name : "error",
    );
    return { ...OFF };
  }
}

export function createEnterpriseSeats(
  deps: EnterpriseSeatsDeps,
): EnterpriseSeats {
  const statePath = join(deps.stateRoot, "enterprise-seats.json");
  const secretPath = join(deps.stateRoot, "secrets", "enterprise-seats.key");
  const url = deps.url ?? ENTERPRISE_SEATS_URL;
  const timeoutMs = deps.timeoutMs ?? ENTERPRISE_SEATS_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  let stored = loadStored(statePath);
  let secret: string | null = null;
  try {
    if (existsSync(secretPath))
      secret = readFileSync(secretPath, "utf8").trim() || null;
  } catch {
    console.error("[enterprise-seats] the secret file cannot be read");
  }

  // available() reads the office config, so the box is checked first: an
  // office with the box off never reads it.
  const available = () =>
    !isHostedAccess(deps.installKind, deps.publicOrigin());
  const locked = () =>
    stored.enabled && stored.accepted === null && available();
  // Connected: the calls this office makes.
  const active = () =>
    stored.enabled && stored.accepted !== null && available();

  const save = (next: Stored) => {
    stored = next;
    atomicWriteFileSync(statePath, JSON.stringify(stored, null, 2), 0o600);
  };

  const writeSecret = (value: string) => {
    const dir = join(deps.stateRoot, "secrets");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    atomicWriteFileSync(secretPath, value, 0o600);
    secret = value;
  };
  const dropSecret = () => {
    rmSync(secretPath, { force: true });
    secret = null;
  };

  // One seat call at a time, in order. A step that throws does not stop the
  // ones after it.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(step: () => Promise<T>): Promise<T> => {
    const run = chain.then(step);
    chain = run.catch(() => {});
    return run;
  };

  const call = (members: number, add: boolean, withSecret = secret) =>
    seatCall({
      url,
      secret: withSecret ?? "",
      office: stored.officeId ?? "",
      members,
      add,
      timeoutMs,
      fetchImpl: deps.fetchImpl,
    });

  // What a call on the stored secret tells Settings. A seats_full or a
  // rate_limited answers that one request only.
  const note = (r: SeatCallResult) => {
    if (r.kind === "ok")
      save({
        ...stored,
        accepted: { ...r.answer, checkedAt: now() },
        problem: null,
      });
    else if (r.kind === "unreachable")
      save({ ...stored, problem: "unreachable" });
    else if (r.reason === "bad_secret" || r.reason === "not_signed")
      save({ ...stored, problem: r.reason });
  };

  const view = (): EnterpriseView =>
    available()
      ? {
          available: true,
          enabled: stored.enabled,
          locked: locked(),
          connected: stored.enabled ? stored.accepted : null,
          // An accepted office whose secret file is gone asks the owner
          // to paste the current one; nobody is locked out.
          problem: !stored.enabled
            ? null
            : stored.accepted && !secret
              ? "bad_secret"
              : stored.problem,
        }
      : {
          available: false,
          enabled: false,
          locked: false,
          connected: null,
          problem: null,
        };

  const refusal = <T>(r: SeatCallResult & { kind: "refused" }) =>
    ({
      ok: false,
      reason: r.reason,
      ...(r.seats !== undefined ? { seats: r.seats } : {}),
      ...(r.inUse !== undefined ? { inUse: r.inUse } : {}),
    }) as EnterpriseOutcome<T>;

  const release = () => {
    serial(async () => {
      if (!active() || !secret) return;
      note(await call(deps.countMembers(), false));
    }).catch((err) =>
      console.error(
        "[enterprise-seats] a release failed:",
        err instanceof Error ? err.message : "error",
      ),
    );
  };

  return {
    available,
    view,
    locked,

    async setEnabled(enabled) {
      return serial(async () => {
        if (enabled) {
          if (!stored.enabled)
            save({
              ...stored,
              enabled: true,
              officeId: stored.officeId ?? randomBytes(16).toString("hex"),
            });
          return view();
        }
        // Free the office's seats on the account first; IT would otherwise
        // remove the office by hand.
        if (stored.enabled && stored.accepted && secret) {
          const r = await call(0, false);
          if (r.kind !== "ok")
            console.error(
              "[enterprise-seats] the service did not take the uncheck:",
              r.kind === "refused" ? r.reason : r.kind,
            );
        }
        dropSecret();
        save({ ...stored, enabled: false, accepted: null, problem: null });
        return view();
      });
    },

    async pasteSecret(raw) {
      const candidate = headerSafeSecret(raw);
      if (!candidate) return { ok: false, reason: "invalid_secret" };
      return serial(async (): Promise<EnterpriseOutcome<EnterpriseView>> => {
        if (!stored.enabled) return { ok: false, reason: "off" };
        // A failed paste changes nothing: an accepted office keeps its
        // secret and its state.
        const r = await call(deps.countMembers(), false, candidate);
        if (r.kind === "refused") return refusal(r);
        if (r.kind === "unreachable")
          return { ok: false, reason: "unreachable" };
        writeSecret(candidate);
        save({
          ...stored,
          accepted: { ...r.answer, checkedAt: now() },
          problem: null,
        });
        return { ok: true, value: view() };
      });
    },

    takeSeat(add) {
      return serial(async () => {
        if (!stored.enabled || !available())
          return { ok: true, value: await add() };
        if (stored.accepted === null)
          return { ok: false, reason: "secret_needed" };
        if (secret) {
          const r = await call(deps.countMembers() + 1, true);
          note(r);
          if (r.kind === "refused") return refusal(r);
        }
        let value;
        try {
          value = await add();
        } catch (err) {
          release();
          throw err;
        }
        return { ok: true, value };
      });
    },

    release,

    checkIn() {
      return serial(async () => {
        if (active() && secret) note(await call(deps.countMembers(), false));
        return view();
      });
    },
  };
}
