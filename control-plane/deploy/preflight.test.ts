// The preflight's decision, at every edge a live reading could reach.
//
// The reading itself needs production; the DECISION needs nothing, which is why
// it is a function. Everything below is a case an operator could actually meet
// on the night the credentials land.

import { describe, expect, test } from "bun:test";
import { PROVIDER_DEPENDENT_KINDS } from "../run-roster.ts";
import {
  PREFLIGHT_COUNTS,
  UNFINISHED_STATUSES,
  judgePreflight,
} from "./preflight.ts";

const CLEAN = {
  instances: 0,
  assets_carrying_a_provider_id: 0,
  unfinished_provider_operations: 0,
  open_attention_reasons: 0,
  accounts: 1,
};

describe("the two safety predicates, and only those two", () => {
  test("a clean production is safe", () => {
    const verdict = judgePreflight(CLEAN);
    expect({ readable: verdict.readable, safe: verdict.safe }).toEqual({
      readable: true,
      safe: true,
    });
  });

  test("A LINKED ASSET REFUSES, whatever else is true", () => {
    const verdict = judgePreflight({
      ...CLEAN,
      assets_carrying_a_provider_id: 1,
    });
    expect(verdict.safe).toBe(false);
    expect(verdict.because).toContain("provider-linked asset");
  });

  test("AN UNFINISHED PROVIDER OPERATION REFUSES", () => {
    const verdict = judgePreflight({
      ...CLEAN,
      unfinished_provider_operations: 1,
    });
    expect(verdict.safe).toBe(false);
    expect(verdict.because).toContain("unfinished provider-mutating");
  });

  test("ACCOUNTS AND ATTENTION ARE OBSERVATIONS, not predicates", () => {
    // Deliberate: a preflight that refused on open attention would refuse for
    // reasons unrelated to whether a box can be touched, and an operator would
    // learn to route around it.
    expect(judgePreflight({ ...CLEAN, open_attention_reasons: 4 }).safe).toBe(
      true,
    );
    expect(judgePreflight({ ...CLEAN, accounts: 0 }).safe).toBe(true);
    expect(judgePreflight({ ...CLEAN, instances: 3 }).safe).toBe(true);
  });
});

describe("a reading nobody could take is not a reading that passed", () => {
  test("EVERY expected count must be present", () => {
    for (const key of PREFLIGHT_COUNTS) {
      const { [key]: _gone, ...partial } = CLEAN;
      const verdict = judgePreflight(partial);
      expect({ key, safe: verdict.safe, readable: verdict.readable }).toEqual({
        key,
        safe: false,
        readable: false,
      });
    }
  });

  test("-1 - what the reader reports for a count it could not take - refuses", () => {
    expect(
      judgePreflight({ ...CLEAN, assets_carrying_a_provider_id: -1 }).safe,
    ).toBe(false);
  });

  test("a value that is not a whole number refuses", () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1.5,
      "0" as unknown as number,
      null as unknown as number,
      undefined as unknown as number,
    ]) {
      expect(
        judgePreflight({ ...CLEAN, unfinished_provider_operations: bad }).safe,
      ).toBe(false);
    }
  });

  test("an unreadable count is reported as unreadable, not as unsafe-because-linked", () => {
    // The two refusals have different next actions: one is "look at the row",
    // the other is "the database did not answer".
    expect(judgePreflight({}).because).toContain("could not be read");
  });
});

describe("the kinds are the roster's, not a copy", () => {
  test("the query's kinds ARE PROVIDER_DEPENDENT_KINDS", async () => {
    // The check a future handler must not slip past. `readCounts` interpolates
    // no kind names; it binds the constant, and this asserts the constant is
    // the roster's own - so adding a provider handler widens the preflight
    // automatically rather than leaving it behind.
    const source = await Bun.file(
      new URL("./preflight.ts", import.meta.url),
    ).text();
    expect(source).toContain("PROVIDER_DEPENDENT_KINDS");
    // No kind is written as a literal anywhere in the file.
    for (const kind of PROVIDER_DEPENDENT_KINDS) {
      expect(source).not.toContain(`"${kind}"`);
    }
    expect(PROVIDER_DEPENDENT_KINDS.length).toBeGreaterThan(0);
  });

  test("the unfinished statuses are the ones an operation can still act from", () => {
    expect([...UNFINISHED_STATUSES]).toEqual([
      "pending",
      "running",
      "ambiguous",
    ]);
    // succeeded and failed are absent on purpose: both are terminal for the
    // row, and a failed operation past its ceiling is an operator's problem
    // rather than a handler about to act.
    expect([...UNFINISHED_STATUSES]).not.toContain("succeeded" as never);
    expect([...UNFINISHED_STATUSES]).not.toContain("failed" as never);
  });
});
