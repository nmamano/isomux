// The order, as the thing that refuses rather than the thing that is written
// down. Every case here is a step somebody could run tonight by typing it.

import { describe, expect, test } from "bun:test";
import {
  LANDING_STEPS,
  NOTHING_OBSERVED,
  type LandingStep,
  type LiveEvidence,
  mayRun,
} from "./landing.ts";

const SAFE: LiveEvidence = {
  preflightSafe: true,
  providerNamesStaged: true,
  providerConfigured: true,
};

describe("the gated steps refuse on unobserved evidence", () => {
  // The failure this prevents is not a wrong answer, it is an ABSENT one: a
  // program that treats "nobody looked" as "nothing wrong" is the shape of
  // every incident where the check was skipped rather than failed.
  test("NOTHING OBSERVED refuses every step that can change something", () => {
    for (const step of ["stage", "activate", "list"] as LandingStep[]) {
      const verdict = mayRun(step, NOTHING_OBSERVED);
      expect({ step, ok: verdict.ok }).toEqual({ step, ok: false });
      expect(verdict.because).toContain("has not been");
    }
  });

  test("an observed FALSE refuses with a different sentence than an absent one", () => {
    const absent = mayRun("activate", { ...SAFE, preflightSafe: null });
    const refused = mayRun("activate", { ...SAFE, preflightSafe: false });
    expect(absent.ok).toBe(false);
    expect(refused.ok).toBe(false);
    // Distinguishable on purpose: "nobody ran it" and "it said no" are
    // different problems with different next actions.
    expect(absent.because).not.toBe(refused.because);
  });
});

describe("no deploy before a green preflight and a staged import", () => {
  test("ACTIVATE NEEDS BOTH, and says which one is missing", () => {
    expect(mayRun("activate", SAFE).ok).toBe(true);
    const noPreflight = mayRun("activate", { ...SAFE, preflightSafe: false });
    expect(noPreflight.ok).toBe(false);
    expect(noPreflight.because).toContain("production");
    const noNames = mayRun("activate", {
      ...SAFE,
      providerNamesStaged: false,
    });
    expect(noNames.ok).toBe(false);
    expect(noNames.because).toContain("provider names");
  });

  test("the preflight is checked FIRST, so a missing preflight is never reported as a missing import", () => {
    const neither = mayRun("activate", {
      preflightSafe: false,
      providerNamesStaged: false,
      providerConfigured: null,
    });
    expect(neither.because).toContain("production");
  });

  test("STAGING a credential also needs the preflight", () => {
    // Staging is inert until a deploy, but a credential that reaches the
    // platform is a credential that exists there, and the question of whether
    // production is safe to arm is the same question.
    expect(mayRun("stage", { ...NOTHING_OBSERVED }).ok).toBe(false);
    expect(mayRun("stage", { ...SAFE, providerNamesStaged: null }).ok).toBe(
      true,
    );
  });
});

describe("no provider listing before the machine's health is read", () => {
  test("LIST NEEDS provider_configured, observed", () => {
    expect(mayRun("list", SAFE).ok).toBe(true);
    expect(mayRun("list", { ...SAFE, providerConfigured: false }).ok).toBe(
      false,
    );
    expect(mayRun("list", { ...SAFE, providerConfigured: null }).ok).toBe(
      false,
    );
  });

  test("a green preflight does NOT license the listing", () => {
    // They answer different questions. Production being safe says nothing
    // about whether the machine we are about to talk to holds the credentials.
    expect(
      mayRun("list", {
        preflightSafe: true,
        providerNamesStaged: true,
        providerConfigured: null,
      }).ok,
    ).toBe(false);
  });
});

describe("the steps that only look are never blocked", () => {
  test("the preflight, the canary, its cleanup, the verify and the probe run on no evidence at all", () => {
    for (const step of [
      "preflight",
      "canary",
      "unset-canary",
      "verify",
      "probe",
    ] as LandingStep[]) {
      expect({ step, ok: mayRun(step, NOTHING_OBSERVED).ok }).toEqual({
        step,
        ok: true,
      });
    }
  });

  test("EVERY DECLARED STEP IS CLASSIFIED EXPLICITLY, gated or not", () => {
    // The earlier version of this test asserted only that each step returned a
    // boolean, which the permissive default gives any new step for free - a
    // vacuous check that would have welcomed an ungated mutation (reviewer
    // finding, 2026-08-12). This one names the classification, so a step added
    // to LANDING_STEPS without a decision here fails.
    const CLASSIFICATION: Record<LandingStep, "gated" | "observes-only"> = {
      preflight: "observes-only",
      canary: "observes-only",
      "unset-canary": "observes-only",
      stage: "gated",
      verify: "observes-only",
      activate: "gated",
      probe: "observes-only",
      list: "gated",
    };
    expect(Object.keys(CLASSIFICATION).sort()).toEqual(
      [...LANDING_STEPS].sort(),
    );
    for (const step of LANDING_STEPS) {
      // A gated step refuses on no evidence; an observing one does not.
      expect({ step, ok: mayRun(step, NOTHING_OBSERVED).ok }).toEqual({
        step,
        ok: CLASSIFICATION[step] === "observes-only",
      });
    }
  });
});
