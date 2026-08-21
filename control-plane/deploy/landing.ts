// The order the provider credentials land in, as a decision rather than a
// procedure somebody remembers.
//
// D4's G4 is eight steps run one at a time by an operator, and the dangerous
// ones are dangerous only OUT OF ORDER: a deploy before the preflight arms a
// loop that may act on a box nobody checked for, and a provider listing before
// the health reading is a credential sent to a machine whose state is unknown.
// Writing that order in a runbook makes it true of the runbook. Writing it here
// makes it true of the programs.
//
// EVERY PRECONDITION IS AN OBSERVATION, NEVER A MEMORY. There is no ledger file
// and no flag saying "step 1 went fine". Each executable OBSERVES what it needs
// at the moment it needs it - the preflight re-reads production, the activation
// re-reads which secret names the app carries, the listing re-reads the health
// surface - so a step cannot be satisfied by something that was true an hour
// ago and is not true now. That is also why `null` exists in `LiveEvidence`:
// "not observed" is its own answer and it REFUSES, because a check nobody ran
// is not a check that passed.

/** The eight steps, in the only order they may run. */
export const LANDING_STEPS = [
  "preflight",
  "canary",
  "unset-canary",
  "stage",
  "verify",
  "activate",
  "redeploy",
  "probe",
  "list",
] as const;

export type LandingStep = (typeof LANDING_STEPS)[number];

/**
 * What a program can SEE right now. Null is "not observed", and it is never
 * treated as false-but-fine: it refuses like any other unmet precondition.
 */
export interface LiveEvidence {
  /** Production carries no provider-linked asset and no unfinished
   * provider-mutating operation - re-read, not remembered. */
  preflightSafe: boolean | null;
  /** The app carries all four provider secret names. */
  providerNamesStaged: boolean | null;
  /** The deployed machine reports the provider handlers registered. */
  providerConfigured: boolean | null;
}

export interface Permission {
  ok: boolean;
  /** A fixed sentence naming what is missing. Never a value, never a count. */
  because: string;
}

/**
 * May this step run, given what has actually been observed?
 *
 * The three gated steps are the three that can change something or send a
 * credential. The rest - the canary, its cleanup, the verify, the probe and the
 * preflight itself - gate nothing, because refusing to let an operator LOOK is
 * how a fail-closed rule turns into a reason to work around it.
 */
export function mayRun(step: LandingStep, evidence: LiveEvidence): Permission {
  const need = (
    value: boolean | null,
    unobserved: string,
    untrue: string,
  ): Permission | null => {
    if (value === null) return { ok: false, because: unobserved };
    if (!value) return { ok: false, because: untrue };
    return null;
  };

  if (step === "stage") {
    return (
      need(
        evidence.preflightSafe,
        "the production preflight has not been run",
        "production is not in a state that may be given provider credentials",
      ) ?? { ok: true, because: "the preflight is green" }
    );
  }

  if (step === "activate") {
    return (
      need(
        evidence.preflightSafe,
        "the production preflight has not been run",
        "production is not in a state that may be given provider credentials",
      ) ??
      need(
        evidence.providerNamesStaged,
        "the app's secret names have not been read",
        "the four provider names are not all set on the app",
      ) ?? { ok: true, because: "the preflight is green and the names are set" }
    );
  }

  if (step === "redeploy") {
    // An UPGRADE of an already-armed deployment. The first-arming question -
    // "is production empty enough to be GIVEN provider credentials" - is
    // answered by history, and the staged names are that history, re-read: a
    // production that already holds all four provider names was armed by the
    // gated first activation. A production that does not is not upgradable,
    // it is unarmed, and must take the "activate" gate instead.
    return (
      need(
        evidence.providerNamesStaged,
        "the app's secret-name listing has not been read",
        "the four provider names are not all set on the app - this deployment " +
          "was never armed, so it must take the first-arming gate",
      ) ?? {
        ok: true,
        because:
          "the provider names are already on the app; this is an upgrade, not an arming",
      }
    );
  }

  if (step === "list") {
    return (
      need(
        evidence.providerConfigured,
        "the deployed machine's health has not been read",
        "the deployed machine does not report provider handlers registered",
      ) ?? { ok: true, because: "the machine reports it holds the credentials" }
    );
  }

  return { ok: true, because: "this step observes and changes nothing" };
}

/** Nothing has been observed. The starting point, and what every program builds
 * from by taking its own readings. */
export const NOTHING_OBSERVED: LiveEvidence = {
  preflightSafe: null,
  providerNamesStaged: null,
  providerConfigured: null,
};
