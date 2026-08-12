// The provider account, read from the machine that holds the credentials.
//
//   bun control-plane/deploy/provider-account.ts            ask the machine
//   bun control-plane/deploy/provider-account.ts --on-box   what the machine runs
//
// RULING 7 IS THE POINT, as restated by R-2026-08-12-D4-2: exactly one instance
// THIS LOOP MAY TOUCH, id 203474835. The account may hold others - it held one
// on 2026-08-12, a cancelled latency-test box of Nil's, self-terminating on
// 2026-08-29 - and the rule is not that they cannot exist but that this loop
// must never create, mutate, inspect or act on them. Which box is ours is not a
// claim our database can support: the database says what WE think we have, and
// only the provider account says what exists and can be billed for. So this
// reads the provider, from the fly machine, because that is where the provider
// credentials live and this box has none.
//
// `cli.ts list` is NOT this. It prints a page of the account for a human, with
// no answer about whether the page was the whole account. A listing that
// silently truncated would look identical to a clean one while hiding whatever
// lay beyond the page - including, on the night this was written, the stranger
// that turned the ruling from a count into a question about identity.
//
// THE ANSWER IS FAIL-CLOSED IN EVERY DIRECTION IT CAN BE:
//   - the remote run must be CLEAN: exit 0, not timed out, no surviving
//     process group, group proved empty. A leader that exits 0 while something
//     it started is still running has produced a partial answer, not an answer.
//   - the pages must be a COMPLETE listing: every page an array, every
//     pagination object present, one stable finite total, unique ids, and the
//     rows reaching that total before the page cap. Exhausting the cap is its
//     own refusal, not a completion.
//   - the values must SURVIVE LOCAL VALIDATION. The machine's output is
//     re-checked here rather than trusted because it passed a check over there:
//     counts must be whole and non-negative, the booleans exactly `true` or
//     `false`, the states inside a closed allowlist, the date the provider's
//     full shape. `unexpected` anywhere fails acceptance.
//
// WHAT CROSSES BACK: eight fixed labels, parsed and re-judged. Nothing else the
// machine says is read, so a chatty or compromised machine cannot write into an
// operator's transcript - and of the strangers, ONLY THEIR NUMBER crosses. No
// id, no name, no state, no date, and no per-instance request is ever made for
// one. A loop that may not touch them has no business learning about them.

import { ContaboHttp } from "../contabo/http.ts";
import {
  TokenProvider,
  credentialsFromEnv,
  type FetchLike,
} from "../contabo/auth.ts";
import {
  APP,
  FLYCTL,
  FLY_TOKEN_FILE,
  inspectMintFile,
  mintFileUsable,
  type BoundedSpawn,
  readSecretFile,
  realBoundedSpawn,
} from "./fly-cli.ts";
import { HEALTH_PATH } from "../mint-seam.ts";
import { PROVISIONER_ORIGIN, judgeHealth } from "./probe.ts";
import { NOTHING_OBSERVED, mayRun } from "./landing.ts";

/** The one instance this loop may see. Ruling 7, as a constant rather than a
 * value a caller passes. */
export const EXPECTED_INSTANCE_ID = "203474835";

/** How long the remote read gets. */
export const REMOTE_DEADLINE_MS = 120_000;
/** How many pages before the reader gives up and says so. */
export const PAGE_CAP = 20;

/** What the on-box half is allowed to say, and the only lines the local half
 * reads back. */
export const REMOTE_LABELS = [
  "provider_rows",
  "provider_total_elements",
  "listing_complete",
  "expected_id_present",
  "other_instances",
  "asset_state",
  "power_state",
  "cancel_date",
] as const;

/**
 * The states this loop has actually observed on this account, and the only ones
 * acceptance may pass on.
 *
 * A closed list rather than a shape check: a state nobody here has seen is a
 * state nobody here has reasoned about, and passing it through as "well, it
 * matched [a-z_]" is how an unknown provider condition becomes an accepted one.
 */
export const KNOWN_ASSET_STATES = [
  "running",
  "stopped",
  "provisioning",
  "installing",
  "manual_provisioning",
  "product_not_available",
  "verification_required",
  "rescue",
  "reset_password",
  "other",
] as const;

export interface AccountReading {
  rows: number;
  totalElements: number;
  complete: boolean;
  /** The expected id occurs EXACTLY ONCE in a complete listing. Twice is not
   * presence, it is a listing nobody should reason about. */
  expectedIdPresent: boolean;
  /**
   * How many instances are not ours. A NUMBER AND NOTHING ELSE - no id, no
   * name, no state, no date. R-2026-08-12-D4-2 restated ruling 7 from "one
   * instance on the account" to "one instance THIS LOOP MAY TOUCH", and the
   * account may legitimately hold strangers (2026-08-12: one, a cancelled
   * latency-test box of Nil's, self-terminating 2026-08-29). What the loop
   * must never do is learn anything about them or act on them, so the count is
   * the whole of what crosses.
   */
  otherInstances: number;
  assetState: string;
  powerState: string;
  /** The provider's own date, or "none", or "unexpected". */
  cancelDate: string;
}

/** The provider's timestamp, whole. A prefix check would let a malformed value
 * with a valid first ten characters through, which is fail-open. */
const PROVIDER_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):?(\d{2}))?)?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A whole, non-negative number, or null.
 *
 * The string arm requires DIGITS, rather than handing the value to `Number`:
 * `Number("")` and `Number(" ")` are both 0, so an empty field would have read
 * as a count of zero - and "zero rows" is an answer, not an absence.
 */
export function wholeCount(value: unknown): number | null {
  if (typeof value === "string") {
    if (!/^\d+$/.test(value)) return null;
    const n = Number(value);
    // Digits alone can still exceed what a number can hold exactly: enough of
    // them convert to Infinity or to a rounded value that is not the count the
    // machine sent.
    return Number.isSafeInteger(n) ? n : null;
  }
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

/** Exactly `true` or `false`, as a string. Anything else is not a boolean. */
export function strictBoolean(value: unknown): boolean | null {
  if (value === "true" || value === true) return true;
  if (value === "false" || value === false) return false;
  return null;
}

/** A state from the closed list, or the fixed word that fails acceptance. */
export function knownState(value: unknown): string {
  return typeof value === "string" &&
    (KNOWN_ASSET_STATES as readonly string[]).includes(value)
    ? value
    : "unexpected";
}

/**
 * The provider's date, validated WHOLE and then reduced to its day.
 *
 * Order matters: validate the full input, then derive. Deriving first and
 * validating the derivation accepts `2026-08-29T99:99:99-garbage` on the
 * strength of its first ten characters (reviewer finding, 2026-08-12).
 */
export function providerDate(value: unknown): string {
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value !== "string") return "unexpected";
  const match = PROVIDER_DATE.exec(value);
  if (!match) return "unexpected";
  // SHAPE IS NOT A DATE. `2026-99-99` and `...T99:99:99Z` both match a digit
  // pattern, and accepting either would license the real-box cancel probe on a
  // schedule that does not exist (reviewer finding, 2026-08-12). So every field
  // is checked against the calendar and the clock.
  const [, y, mo, d, h, mi, sec, offSign, offH, offM] = match;
  if (!isRealDay(Number(y), Number(mo), Number(d))) return "unexpected";
  if (h !== undefined) {
    if (Number(h) > 23 || Number(mi) > 59 || Number(sec) > 59) {
      return "unexpected";
    }
  }
  if (offSign !== undefined && (Number(offH) > 14 || Number(offM) > 59)) {
    return "unexpected";
  }
  const day = value.slice(0, 10);
  return DATE_ONLY.test(day) ? day : "unexpected";
}

/** Days in a month, with the leap rule spelled out rather than approximated. */
export function isRealDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= lengths[month - 1];
}

export interface RawInstance {
  instanceId?: number | string;
  status?: string;
  cancelDate?: string | null;
}

export type ListingStatus =
  /** Every page well-formed and the rows reached a stable total. */
  | "complete"
  /** A page, a pagination object or a total was not the shape it must be. */
  | "malformed"
  /** The cap was reached before the rows reached the total. */
  | "exhausted";

export interface WholeListing {
  status: ListingStatus;
  rows: RawInstance[];
  totalElements: number;
}

/**
 * Every page, or a refusal that says WHICH kind.
 *
 * The three outcomes are distinguished because they mean different things to an
 * operator: malformed is "the provider or the transport is not what we think",
 * exhausted is "the account is bigger than this reader expects", and both are
 * different from a clean account with two boxes in it.
 */
export async function readWholeAccount(
  http: { okOrThrow: (method: string, path: string) => Promise<unknown> },
  pageSize = 100,
): Promise<WholeListing> {
  const rows: RawInstance[] = [];
  const seen = new Set<string>();
  let total: number | null = null;

  for (let page = 1; page <= PAGE_CAP; page++) {
    const body = (await http.okOrThrow(
      "GET",
      `/v1/compute/instances?size=${pageSize}&page=${page}`,
    )) as { data?: unknown; _pagination?: { totalElements?: unknown } } | null;

    // The pagination object is REQUIRED on every page: it is the only thing
    // that says whether what we hold is the account.
    const pagination = body?._pagination;
    if (!pagination || typeof pagination !== "object") {
      return { status: "malformed", rows, totalElements: total ?? -1 };
    }
    const reported = wholeCount(pagination.totalElements);
    if (reported === null) {
      return { status: "malformed", rows, totalElements: total ?? -1 };
    }
    // A TOTAL THAT MOVES BETWEEN PAGES is a listing nobody can call complete:
    // the account changed under the read, or the provider is inconsistent.
    if (total !== null && reported !== total) {
      return { status: "malformed", rows, totalElements: total };
    }
    total = reported;

    if (!Array.isArray(body?.data)) {
      return { status: "malformed", rows, totalElements: total };
    }
    for (const row of body.data as RawInstance[]) {
      const id = String((row ?? {}).instanceId ?? "");
      // A REPEATED ID means the pages overlap, and overlapping pages cannot be
      // added up into an account.
      if (id === "" || seen.has(id)) {
        return { status: "malformed", rows, totalElements: total };
      }
      seen.add(id);
      rows.push(row);
    }

    if (rows.length === total) {
      return { status: "complete", rows, totalElements: total };
    }
    if (rows.length > total) {
      return { status: "malformed", rows, totalElements: total };
    }
    if ((body.data as RawInstance[]).length === 0) {
      // Nothing more is coming and the total was never reached.
      return { status: "malformed", rows, totalElements: total };
    }
  }
  return { status: "exhausted", rows, totalElements: total ?? -1 };
}

/**
 * Judge a listing that has already been proved complete or not.
 *
 * ROW IDENTIFIERS ARE USED HERE AND NOWHERE ELSE, for exactly three things:
 * whether the expected id is present, whether it occurs once, and how many
 * rows are not it. No other row's id, name, state or date is read, and the
 * caller makes no per-instance request for any of them.
 */
export function judgeListing(
  listing: WholeListing,
  powerStates: Record<string, string>,
): AccountReading {
  const ids = listing.rows.map((r) => String(r.instanceId ?? ""));
  const mine = ids.filter((id) => id === EXPECTED_INSTANCE_ID).length;
  const expected = listing.rows.find(
    (r) => String(r.instanceId ?? "") === EXPECTED_INSTANCE_ID,
  );
  return {
    rows: listing.rows.length,
    totalElements: listing.totalElements,
    complete: listing.status === "complete",
    // EXACTLY once. Twice would mean the listing carries our box in two rows,
    // which is a listing to refuse rather than a presence to celebrate.
    expectedIdPresent: mine === 1,
    otherInstances: ids.length - mine,
    assetState: knownState(expected?.status),
    powerState: knownState(powerStates[EXPECTED_INSTANCE_ID]),
    cancelDate: providerDate(expected?.cancelDate),
  };
}

/** The on-box half: read the account with the machine's own credentials. */
async function onBox(): Promise<void> {
  const fetchImpl = fetch as unknown as FetchLike;
  const http = new ContaboHttp({
    fetchImpl,
    tokens: new TokenProvider(credentialsFromEnv(), fetchImpl),
  });
  const listing = await readWholeAccount(http);
  const powerStates: Record<string, string> = {};
  const expected = listing.rows.find(
    (r) => String(r.instanceId ?? "") === EXPECTED_INSTANCE_ID,
  );
  if (expected) {
    const one = (await http.okOrThrow(
      "GET",
      `/v1/compute/instances/${EXPECTED_INSTANCE_ID}`,
    )) as { data?: { status?: string }[] } | null;
    const status = one?.data?.[0]?.status;
    if (typeof status === "string") powerStates[EXPECTED_INSTANCE_ID] = status;
  }
  const reading = judgeListing(listing, powerStates);
  console.log(`provider_rows: ${reading.rows}`);
  console.log(`provider_total_elements: ${reading.totalElements}`);
  console.log(`listing_complete: ${reading.complete}`);
  console.log(`expected_id_present: ${reading.expectedIdPresent}`);
  console.log(`other_instances: ${reading.otherInstances}`);
  console.log(`asset_state: ${reading.assetState}`);
  console.log(`power_state: ${reading.powerState}`);
  console.log(`cancel_date: ${reading.cancelDate}`);
}

/**
 * Read the fixed labels out of whatever the machine said, and VALIDATE THEM
 * HERE.
 *
 * The machine ran the same checks, and that is not a reason to skip them: the
 * point of a boundary is that the receiving side does not depend on the sending
 * side having behaved. Returns null when any label is missing, repeated, or
 * carries a value this side will not accept.
 */
export function parseRemote(text: string): AccountReading | null {
  const found = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([a-z_]+): (.+)$/.exec(line.trim());
    if (!match) continue;
    const [, label, value] = match;
    if (!(REMOTE_LABELS as readonly string[]).includes(label)) continue;
    if (found.has(label)) return null;
    found.set(label, value);
  }
  if (found.size !== REMOTE_LABELS.length) return null;

  const rows = wholeCount(found.get("provider_rows"));
  const total = wholeCount(found.get("provider_total_elements"));
  const complete = strictBoolean(found.get("listing_complete"));
  const present = strictBoolean(found.get("expected_id_present"));
  const others = wholeCount(found.get("other_instances"));
  if (
    rows === null ||
    total === null ||
    complete === null ||
    present === null ||
    others === null
  ) {
    return null;
  }
  return {
    rows,
    totalElements: total,
    complete,
    expectedIdPresent: present,
    otherInstances: others,
    assetState: knownState(found.get("asset_state")),
    powerState: knownState(found.get("power_state")),
    cancelDate: providerDate(
      found.get("cancel_date") === "none" ? null : found.get("cancel_date"),
    ),
  };
}

/** The gate's verdict over a locally validated reading. */
export function judgeRemote(reading: AccountReading | null): {
  ok: boolean;
  cancelScheduled: boolean;
  because: string;
} {
  const no = (because: string) => ({
    ok: false,
    cancelScheduled: false,
    because,
  });
  if (!reading)
    return no("the machine's answer was not a reading this side accepts");
  if (!reading.complete)
    return no("the account listing could not be proved complete");
  // R-2026-08-12-D4-2: the predicate is about OUR box, not the account's size.
  // The account may legitimately hold strangers - it held one on 2026-08-12, a
  // cancelled latency-test box of Nil's - and what the loop may never do is
  // learn anything about them or act on them.
  if (!reading.expectedIdPresent) {
    return no(
      "the expected instance is not present exactly once in the account",
    );
  }
  if (reading.rows !== reading.totalElements) {
    return no("the rows held do not match the total the provider reported");
  }
  if (reading.otherInstances !== reading.rows - 1) {
    return no("the stranger count does not account for every row read");
  }
  if (reading.otherInstances > 1) {
    // Fail closed, and say only the NUMBER. More than one stranger is a new
    // fact about the account that a manager and Nil rule on, not a threshold
    // this program may pass on its own.
    return no(
      `more than one instance on the account is not ours (${reading.otherInstances}) - ` +
        "a manager and Nil decision before any pass",
    );
  }
  if (
    reading.assetState === "unexpected" ||
    reading.powerState === "unexpected"
  ) {
    return no("the instance carries a state this loop has never observed");
  }
  if (reading.cancelDate === "unexpected") {
    return no("the cancel date is not a shape the provider should have sent");
  }
  const cancelScheduled = reading.cancelDate !== "none";
  return {
    ok: true,
    cancelScheduled,
    because: cancelScheduled
      ? "the expected instance is present and carries a cancel date"
      : "the expected instance is present with NO cancel date",
  };
}

/**
 * Whether a bounded remote run produced an answer at all.
 *
 * A leader that exits 0 while something it started is still running has
 * produced a PARTIAL answer, and a partial answer to "is there exactly one box"
 * is the one this gate must never accept (reviewer finding, 2026-08-12).
 */
export function remoteRunUsable(result: {
  code: number | null;
  timedOut: boolean;
  groupSurvived: boolean;
  groupEmpty: boolean;
}): boolean {
  return (
    result.code === 0 &&
    !result.timedOut &&
    !result.groupSurvived &&
    result.groupEmpty
  );
}

/**
 * Whether the deployed machine says it holds provider credentials.
 *
 * Null for every "we could not establish that" - an unusable credential file, a
 * status that is not 200, a body whose shape is not the health surface's, a
 * value that is not a boolean, or a throw. Null REFUSES at the gate, because
 * not established is not the same as false and neither is a reason to proceed.
 */
export function providerConfiguredFrom(body: unknown): boolean | null {
  const verdict = judgeHealth(body);
  if (!verdict.shapeOk) return null;
  const value = (body as Record<string, unknown>).provider_configured;
  if (typeof value !== "boolean") return null;
  // A DEGRADED MACHINE LICENSES NOTHING. Holding four environment names is not
  // the same as serving: the sequence asks for POST-DEPLOY health, so every
  // gating boolean must hold before the listing may be asked for (reviewer
  // finding, 2026-08-12). False rather than null, because this is a machine
  // that answered and said no.
  if (!verdict.gatingTrue) return false;
  return value;
}

/**
 * Exported since G5 (2026-08-12) so the recycle ladder takes its health gate
 * from HERE rather than restating the read: one place opens the seam credential
 * and one place judges the answer, and a second copy could be given a weaker
 * version of either.
 */
export async function readProviderHealth(): Promise<boolean | null> {
  const { checks, token } = inspectMintFile();
  if (!mintFileUsable(checks)) return null;
  try {
    const response = await fetch(`${PROVISIONER_ORIGIN}${HEALTH_PATH}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.status !== 200) return null;
    return providerConfiguredFrom(await response.json());
  } catch {
    // Discarded: a fetch error can carry the host it failed to reach.
    return null;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--on-box") {
    await onBox();
    return;
  }
  if (args.length > 0) {
    console.log("usage: provider-account.ts [--on-box]");
    process.exitCode = 2;
    return;
  }

  // THE LISTING IS GATED ON THE MACHINE'S OWN HEALTH READING. Asking a machine
  // for a provider listing before it says it holds provider credentials is a
  // credential sent to a machine in an unknown state.
  const providerConfigured = await readProviderHealth();
  console.log(`health_readable: ${providerConfigured !== null}`);
  console.log(`provider_configured: ${providerConfigured ?? "unknown"}`);
  const permission = mayRun("list", {
    ...NOTHING_OBSERVED,
    providerConfigured,
  });
  console.log(`may_list: ${permission.ok}`);
  console.log(`because: ${permission.because}`);
  if (!permission.ok) {
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    const spawn: BoundedSpawn = realBoundedSpawn;
    result = await spawn(
      [
        FLYCTL,
        "ssh",
        "console",
        "-a",
        APP,
        "-C",
        "bun control-plane/deploy/provider-account.ts --on-box",
      ],
      { FLY_API_TOKEN: readSecretFile(FLY_TOKEN_FILE) },
      "",
      REMOTE_DEADLINE_MS,
    );
  } catch {
    console.log("remote_threw: true");
    console.log("account_as_ruling_7_requires: false");
    process.exitCode = 1;
    return;
  }

  console.log(`remote_exit: ${result.code}`);
  console.log(`timed_out: ${result.timedOut}`);
  console.log(`group_survived: ${result.groupSurvived}`);
  console.log(`group_empty: ${result.groupEmpty}`);
  // A CLEAN RUN, or no reading at all. A leader that exited 0 while something
  // it started is still running produced a partial answer.
  const reading = remoteRunUsable(result) ? parseRemote(result.stdout) : null;
  const verdict = judgeRemote(reading);
  if (reading) {
    console.log(`provider_rows: ${reading.rows}`);
    console.log(`provider_total_elements: ${reading.totalElements}`);
    console.log(`listing_complete: ${reading.complete}`);
    console.log(`expected_id_present: ${reading.expectedIdPresent}`);
    console.log(`other_instances: ${reading.otherInstances}`);
    console.log(`asset_state: ${reading.assetState}`);
    console.log(`power_state: ${reading.powerState}`);
    console.log(`cancel_date: ${reading.cancelDate}`);
  }
  console.log(`account_as_ruling_7_requires: ${verdict.ok}`);
  console.log(`cancel_scheduled: ${verdict.cancelScheduled}`);
  console.log(`because: ${verdict.because}`);
  process.exitCode = verdict.ok ? 0 : 1;
}

if (import.meta.main) {
  await main();
}
