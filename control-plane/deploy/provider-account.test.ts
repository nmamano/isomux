// The provider listing, judged the way an acceptance gate has to judge it:
// exactly one instance, the expected id, a listing that can PROVE it saw the
// whole account, and values this side has validated for itself.
//
// The failure this guards against is quiet. `cli.ts list` asks for a page and
// prints what came back; if the account ever held a second box beyond that
// page, the transcript would look identical to a clean one. Ruling 7 is the
// reason that matters - one box, never a second.
//
// The second failure is subtler and was found in review: the machine runs these
// checks too, and that is NOT a reason for this side to trust its output. A
// boundary whose receiving half depends on the sending half having behaved is
// not a boundary.

import { describe, expect, test } from "bun:test";
import {
  EXPECTED_INSTANCE_ID,
  KNOWN_ASSET_STATES,
  PAGE_CAP,
  REMOTE_LABELS,
  judgeListing,
  judgeRemote,
  knownState,
  parseRemote,
  providerConfiguredFrom,
  providerDate,
  readWholeAccount,
  remoteRunUsable,
  strictBoolean,
  wholeCount,
} from "./provider-account.ts";
import { GATING_KEYS } from "./probe.ts";

const ONE = [
  { instanceId: 203474835, status: "running", cancelDate: "2026-08-29" },
];

const GOOD_REMOTE = [
  "provider_rows: 1",
  "provider_total_elements: 1",
  "listing_complete: true",
  "only_expected_id: true",
  "asset_state: running",
  "power_state: running",
  "cancel_date: 2026-08-29",
].join("\n");

/** A provider that answers with the pages it was given, in order. */
function fakeHttp(pages: unknown[]) {
  let call = 0;
  return {
    okOrThrow: async () => pages[Math.min(call++, pages.length - 1)],
  };
}

const page = (data: unknown, total: unknown) => ({
  data,
  _pagination: { totalElements: total },
});

describe("a listing is complete, malformed or exhausted - never assumed", () => {
  test("rows reaching a stable total is complete", async () => {
    const listing = await readWholeAccount(fakeHttp([page(ONE, 1)]));
    expect(listing.status).toBe("complete");
    expect(listing.rows.length).toBe(1);
    const reading = judgeListing(listing, {});
    expect(reading.complete).toBe(true);
    expect(reading.onlyExpectedId).toBe(true);
    expect(reading.cancelDate).toBe("2026-08-29");
  });

  test("several pages are followed until the total is reached", async () => {
    const first = Array.from({ length: 2 }, (_, i) => ({ instanceId: i + 1 }));
    const second = [{ instanceId: 3 }];
    const listing = await readWholeAccount(
      fakeHttp([page(first, 3), page(second, 3)]),
      2,
    );
    expect(listing.status).toBe("complete");
    expect(listing.rows.length).toBe(3);
  });

  test("A TOTAL THAT MOVES BETWEEN PAGES IS MALFORMED", async () => {
    // The account changed under the read, or the provider is inconsistent.
    // Either way nothing here can be called the whole account.
    const listing = await readWholeAccount(
      fakeHttp([page([{ instanceId: 1 }], 3), page([{ instanceId: 2 }], 9)]),
      1,
    );
    expect(listing.status).toBe("malformed");
  });

  test("A REPEATED ID IS MALFORMED, because overlapping pages cannot be added up", async () => {
    const listing = await readWholeAccount(
      fakeHttp([page([{ instanceId: 7 }], 2), page([{ instanceId: 7 }], 2)]),
      1,
    );
    expect(listing.status).toBe("malformed");
  });

  test("a missing or non-array data field is malformed, not empty", async () => {
    for (const data of [undefined, null, {}, "rows", 5]) {
      const listing = await readWholeAccount(fakeHttp([page(data, 1)]));
      expect({
        data: JSON.stringify(data) ?? "undefined",
        status: listing.status,
      }).toEqual({
        data: JSON.stringify(data) ?? "undefined",
        status: "malformed",
      });
    }
  });

  test("a missing pagination object is malformed", async () => {
    const listing = await readWholeAccount(fakeHttp([{ data: ONE }]));
    expect(listing.status).toBe("malformed");
  });

  test("a total that is not a whole non-negative number is malformed", async () => {
    for (const total of [
      undefined,
      null,
      Number.NaN,
      1.5,
      -1,
      "many",
      Number.POSITIVE_INFINITY,
    ]) {
      const listing = await readWholeAccount(fakeHttp([page(ONE, total)]));
      expect({ total: String(total), status: listing.status }).toEqual({
        total: String(total),
        status: "malformed",
      });
    }
  });

  test("an empty page before the total is reached is malformed", async () => {
    const listing = await readWholeAccount(
      fakeHttp([page([{ instanceId: 1 }], 5), page([], 5)]),
      1,
    );
    expect(listing.status).toBe("malformed");
  });

  test("THE PAGE CAP IS ITS OWN OUTCOME, not a quiet completion", async () => {
    // A provider reporting a total this reader cannot reach must not look like
    // a clean small account.
    const pages = Array.from({ length: PAGE_CAP + 2 }, (_, i) =>
      page([{ instanceId: i + 1 }], 10_000),
    );
    const listing = await readWholeAccount(fakeHttp(pages), 1);
    expect(listing.status).toBe("exhausted");
    expect(judgeListing(listing, {}).complete).toBe(false);
  });

  test("a second instance fails the id check even when the listing is complete", async () => {
    const listing = await readWholeAccount(
      fakeHttp([page([...ONE, { instanceId: 999, status: "running" }], 2)]),
    );
    expect(listing.status).toBe("complete");
    expect(judgeListing(listing, {}).onlyExpectedId).toBe(false);
  });
});

describe("values are validated, not echoed", () => {
  test("a state outside the observed list becomes 'unexpected'", () => {
    for (const state of KNOWN_ASSET_STATES)
      expect(knownState(state)).toBe(state);
    expect(knownState("<script>alert(1)</script>")).toBe("unexpected");
    expect(knownState("RUNNING")).toBe("unexpected");
    expect(knownState(42)).toBe("unexpected");
    expect(knownState(undefined)).toBe("unexpected");
  });

  test("A DATE THAT IS ONLY DIGIT-SHAPED IS REFUSED", () => {
    // Shape is not a calendar. Every one of these matches the pattern and none
    // of them is a day; accepting one would license the real-box cancel probe
    // on a schedule that does not exist (reviewer finding, 2026-08-12).
    for (const bad of [
      "2026-99-99",
      "2026-13-01",
      "2026-00-10",
      "2026-02-30",
      "2027-02-29",
      "2026-08-32",
      "2026-08-00",
      "2026-08-29T99:99:99Z",
      "2026-08-29T24:00:00Z",
      "2026-08-29T12:60:00Z",
      "2026-08-29T12:00:61Z",
      "2026-08-29T12:00:00+99:00",
      "2026-08-29T12:00:00+05:75",
    ]) {
      expect({ bad, out: providerDate(bad) }).toEqual({
        bad,
        out: "unexpected",
      });
    }
    // And the real ones still pass, including a leap day that exists.
    expect(providerDate("2028-02-29")).toBe("2028-02-29");
    expect(providerDate("2026-08-29T23:59:59+14:00")).toBe("2026-08-29");
  });

  test("A MALFORMED DATE WITH A VALID PREFIX IS REFUSED", () => {
    // The fail-open version validated `slice(0, 10)`, so this passed as
    // 2026-08-29 (reviewer finding, 2026-08-12). The whole input is checked
    // first, and only then is the day derived.
    expect(providerDate("2026-08-29T99:99:99-garbage")).toBe("unexpected");
    expect(providerDate("2026-08-29rm -rf")).toBe("unexpected");
    expect(providerDate("2026-08-29")).toBe("2026-08-29");
    expect(providerDate("2026-08-29T00:00:00Z")).toBe("2026-08-29");
    expect(providerDate("2026-08-29 00:00:00")).toBe("2026-08-29");
    expect(providerDate(null)).toBe("none");
    expect(providerDate("")).toBe("none");
    expect(providerDate(20260829)).toBe("unexpected");
  });

  test("counts and booleans are strict", () => {
    expect(wholeCount("3")).toBe(3);
    expect(wholeCount(0)).toBe(0);
    // Digits that do not survive as an exact number are refused too.
    expect(wholeCount("9".repeat(30))).toBeNull();
    for (const bad of ["3.5", "-1", "", "many", Number.NaN, null, undefined]) {
      expect({ bad: String(bad), n: wholeCount(bad) }).toEqual({
        bad: String(bad),
        n: null,
      });
    }
    expect(strictBoolean("true")).toBe(true);
    expect(strictBoolean("false")).toBe(false);
    for (const bad of ["TRUE", "yes", "1", "", null]) {
      expect(strictBoolean(bad)).toBeNull();
    }
  });
});

describe("only fixed labels cross back, and this side re-checks them", () => {
  test("the expected set parses into a typed reading", () => {
    const reading = parseRemote(GOOD_REMOTE);
    expect(reading).not.toBeNull();
    expect(reading!.rows).toBe(1);
    expect(reading!.complete).toBe(true);
    expect(reading!.cancelDate).toBe("2026-08-29");
  });

  test("A MISSING LABEL IS NO READING", () => {
    for (const label of REMOTE_LABELS) {
      const without = GOOD_REMOTE.split("\n")
        .filter((line) => !line.startsWith(`${label}:`))
        .join("\n");
      expect({ label, parsed: parseRemote(without) }).toEqual({
        label,
        parsed: null,
      });
    }
  });

  test("a repeated label is refused rather than last-one-wins", () => {
    expect(parseRemote(`${GOOD_REMOTE}\nonly_expected_id: false`)).toBeNull();
  });

  test("ANYTHING ELSE THE MACHINE SAYS IS DROPPED", () => {
    const chatty = [
      "Connecting to fly...",
      GOOD_REMOTE,
      "provider_secret: hunter2",
      "Connection closed",
    ].join("\n");
    expect(JSON.stringify(parseRemote(chatty))).not.toContain("hunter2");
  });

  test("A NON-NUMERIC COUNT FROM THE MACHINE IS NO READING", () => {
    // The machine claims to have checked. This side checks anyway.
    for (const line of [
      "provider_rows: lots",
      "provider_rows: -1",
      "provider_total_elements: 1.5",
      "listing_complete: yes",
      "only_expected_id: TRUE",
    ]) {
      const label = line.split(":")[0];
      const tampered = GOOD_REMOTE.split("\n")
        .map((existing) => (existing.startsWith(`${label}:`) ? line : existing))
        .join("\n");
      expect({ line, parsed: parseRemote(tampered) }).toEqual({
        line,
        parsed: null,
      });
    }
  });
});

describe("the gate's verdict", () => {
  test("one instance, the expected id, complete, with a cancel date", () => {
    const verdict = judgeRemote(parseRemote(GOOD_REMOTE));
    expect(verdict.ok).toBe(true);
    expect(verdict.cancelScheduled).toBe(true);
  });

  test("NO CANCEL DATE PASSES RULING 7 AND REPORTS NOT-SCHEDULED", () => {
    // Two separate questions: the account being right is ruling 7, and the box
    // being cancel-scheduled is R-2026-08-12-D4-1's precondition for the suites
    // tail. An operator needs to see which one failed.
    const verdict = judgeRemote(
      parseRemote(
        GOOD_REMOTE.replace("cancel_date: 2026-08-29", "cancel_date: none"),
      ),
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.cancelScheduled).toBe(false);
    expect(verdict.because).toContain("NO cancel date");
  });

  test("AN UNEXPECTED STATE FAILS ACCEPTANCE", () => {
    for (const label of ["asset_state", "power_state"]) {
      const verdict = judgeRemote(
        parseRemote(
          GOOD_REMOTE.split("\n")
            .map((line) =>
              line.startsWith(`${label}:`) ? `${label}: teleporting` : line,
            )
            .join("\n"),
        ),
      );
      expect({ label, ok: verdict.ok }).toEqual({ label, ok: false });
      expect(verdict.because).toContain("never observed");
    }
  });

  test("a rows/total that is not exactly one refuses", () => {
    const two = GOOD_REMOTE.replace(
      "provider_rows: 1",
      "provider_rows: 2",
    ).replace("provider_total_elements: 1", "provider_total_elements: 2");
    expect(judgeRemote(parseRemote(two)).ok).toBe(false);
  });

  test("an incomplete listing refuses, whatever the ids said", () => {
    expect(
      judgeRemote(
        parseRemote(
          GOOD_REMOTE.replace(
            "listing_complete: true",
            "listing_complete: false",
          ),
        ),
      ).ok,
    ).toBe(false);
  });

  test("no reading at all refuses", () => {
    expect(judgeRemote(null).ok).toBe(false);
  });

  test("the expected id and the page cap are constants, not arguments", () => {
    expect(EXPECTED_INSTANCE_ID).toBe("203474835");
    expect(PAGE_CAP).toBe(20);
  });
});

describe("a remote run that is not clean produced no answer", () => {
  const CLEAN = {
    code: 0,
    timedOut: false,
    groupSurvived: false,
    groupEmpty: true,
  };

  test("only a wholly clean run is read", () => {
    expect(remoteRunUsable(CLEAN)).toBe(true);
    expect(remoteRunUsable({ ...CLEAN, code: 1 })).toBe(false);
    expect(remoteRunUsable({ ...CLEAN, code: null })).toBe(false);
    expect(remoteRunUsable({ ...CLEAN, timedOut: true })).toBe(false);
    // THE ONE THAT WAS MISSING: exit 0 with a process still alive in the
    // group. Its output is a fragment, and a fragment that happens to parse
    // would have been accepted.
    expect(remoteRunUsable({ ...CLEAN, groupSurvived: true })).toBe(false);
    expect(remoteRunUsable({ ...CLEAN, groupEmpty: false })).toBe(false);
  });
});

describe("the health gate before the listing", () => {
  const HEALTHY = {
    ok: true,
    bounds_governed: true,
    branch_pinned: true,
    database_reachable: true,
    tick_recent: true,
    state_persisted: true,
    provider_configured: true,
  };

  test("a healthy machine reporting provider credentials answers true", () => {
    expect(providerConfiguredFrom(HEALTHY)).toBe(true);
    expect(
      providerConfiguredFrom({ ...HEALTHY, provider_configured: false }),
    ).toBe(false);
  });

  test("A DEGRADED MACHINE LICENSES NOTHING, whatever provider_configured says", () => {
    // Holding four environment names is not the same as serving. The sequence
    // asks for POST-DEPLOY health, so every gating boolean has to hold
    // (reviewer finding, 2026-08-12).
    for (const key of GATING_KEYS) {
      expect({
        key,
        answer: providerConfiguredFrom({ ...HEALTHY, [key]: false }),
      }).toEqual({ key, answer: false });
    }
  });

  test("A BODY THAT IS NOT THE HEALTH SURFACE'S SHAPE IS UNKNOWN, not false", () => {
    // Unknown refuses at the gate. False also refuses, but they are different
    // facts and the operator's next action differs.
    const { provider_configured: _gone, ...missing } = HEALTHY;
    expect(providerConfiguredFrom(missing)).toBeNull();
    expect(providerConfiguredFrom({ ...HEALTHY, extra: true })).toBeNull();
    expect(
      providerConfiguredFrom({ ...HEALTHY, provider_configured: "yes" }),
    ).toBeNull();
    expect(providerConfiguredFrom(null)).toBeNull();
    expect(providerConfiguredFrom("ok")).toBeNull();
  });
});
