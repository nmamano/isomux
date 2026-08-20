// The Production coordinator's judgements, proved before anything is public.
//
// Everything tested here is a decision the live phase makes ONCE, against a
// deployment that is already serving: a wrong verdict either detaches a healthy
// domain or leaves a broken one attached. So the expected statuses are written
// down here, before the run, rather than read off the transcript afterwards.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  PREVIEW_SHAPES,
  PRODUCTION_SHAPES,
  PROBE_EXPECTATIONS,
  SECRET_SHAPES,
  TLS_OFFSETS_MS,
  afterInvocation,
  awaitTls,
  UNAUTH_PROBE_EXPECTATIONS,
  dropHolders,
  envWritesFor,
  expectedProductionBefore,
  EMPTY_ROWS,
  USER_TABLES,
  afterRowsExpected,
  beforeRowsAcceptable,
  guardedRun,
  buildHolders,
  modeFrom,
  probeInputFor,
  probeExpectationsFor,
  probeKeysFor,
  probeRuntimeReady,
  rowsMatch,
  judgeByTarget,
  judgeProbe,
  parseSecretText,
  shapedState,
} from "./production-phase.ts";
import { fetchInviteFromSeam } from "../mint-client.ts";
import { FORBIDDEN_ENV_NAMES } from "./vercel-api.ts";
import type { EnvFact } from "./vercel-env.ts";

const fact = (key: string, type: string, target: string[]): EnvFact => ({
  key,
  type,
  target,
});

/** The thirteen entries the project carries when the phase has done its job. */
const THIRTEEN: EnvFact[] = [
  fact("CONTROL_PLANE_DB", "sensitive", ["preview"]),
  fact("AUTH_SECRET", "sensitive", ["preview"]),
  fact("CONTROL_PLANE_DB", "sensitive", ["production"]),
  fact("AUTH_SECRET", "sensitive", ["production"]),
  fact("CONTROL_PLANE_MINT_TOKEN", "sensitive", ["production"]),
  fact("AUTH_GOOGLE_SECRET", "sensitive", ["production"]),
  fact("AUTH_URL", "encrypted", ["production"]),
  fact("CONTROL_PLANE_MINT_URL", "encrypted", ["production"]),
  fact("AUTH_GOOGLE_ID", "encrypted", ["production"]),
  fact("STRIPE_LIVE_SECRET_KEY", "sensitive", ["production"]),
  fact("CONTROL_PLANE_STRIPE_MODE", "encrypted", ["production"]),
  fact("CONTROL_PLANE_ENTRY_PRICE_ID", "encrypted", ["production"]),
  fact("CONTROL_PLANE_POWERUSER_PRICE_ID", "encrypted", ["production"]),
];

const judge = (facts: EnvFact[]) =>
  judgeByTarget(facts, PREVIEW_SHAPES, PRODUCTION_SHAPES, FORBIDDEN_ENV_NAMES);

describe("the local probe runtime boundary", () => {
  test("accepts only the exact successful readiness transcript", () => {
    expect(probeRuntimeReady("probe_runtime_ready: true\n", 0)).toBe(true);
    expect(probeRuntimeReady("", 1)).toBe(false);
    expect(probeRuntimeReady("probe_runtime_ready: true\nnoise\n", 0)).toBe(
      false,
    );
    expect(probeRuntimeReady("probe_runtime_ready: false\n", 0)).toBe(false);
  });

  test.skipIf(
    !fs.existsSync(
      path.join(import.meta.dir, "..", "web", "node_modules", "next-auth"),
    ),
  )("the installed real probe produces the accepted transcript", () => {
    const child = Bun.spawnSync(
      ["bun", "--no-install", "e2e/production-probe.ts", "--preflight"],
      { cwd: path.join(import.meta.dir, "..", "web") },
    );
    const stdout = new TextDecoder().decode(child.stdout);
    expect(probeRuntimeReady(stdout, child.exitCode)).toBe(true);
    expect(stdout).toBe("probe_runtime_ready: true\n");
  });

  test("a fresh-clone probe with no web dependencies fails at startup", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "probe-preflight-"));
    try {
      fs.copyFileSync(
        path.join(import.meta.dir, "..", "web", "e2e", "production-probe.ts"),
        path.join(bare, "production-probe.ts"),
      );
      const child = Bun.spawnSync(
        ["bun", "--no-install", "production-probe.ts", "--preflight"],
        { cwd: bare },
      );
      expect(child.exitCode).not.toBe(0);
      expect(new TextDecoder().decode(child.stdout)).toBe("");
      expect(
        probeRuntimeReady(
          new TextDecoder().decode(child.stdout),
          child.exitCode,
        ),
      ).toBe(false);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("the environment, judged PER TARGET", () => {
  test("DUPLICATE KEYS ON DISJOINT TARGETS ARE CORRECT, not a collision", () => {
    // The whole reason this helper exists instead of judgeInventory: two names
    // live on BOTH targets with different values, and a key map would let one
    // stand in for the other.
    const verdict = judge(THIRTEEN);
    expect(verdict.exact).toBe(true);
    expect(verdict.totalFacts).toBe(13);
    expect(verdict.duplicates).toEqual([]);
    expect(verdict.previewProblems).toEqual([]);
    expect(verdict.productionProblems).toEqual([]);
  });

  test("A MISSING TARGET-SPECIFIC DUPLICATE FAILS, though the key still exists", () => {
    // Preview's CONTROL_PLANE_DB is gone; Production's remains. A key map would
    // find the name and report exact. This must not.
    const missingPreview = THIRTEEN.filter(
      (f) => !(f.key === "CONTROL_PLANE_DB" && f.target[0] === "preview"),
    );
    const verdict = judge(missingPreview);
    expect(verdict.exact).toBe(false);
    expect(verdict.previewExact).toBe(false);
    expect(verdict.previewProblems).toContain(
      "missing:preview:CONTROL_PLANE_DB",
    );
    expect(verdict.productionExact).toBe(true);
  });

  test("the wrong target fails", () => {
    const wrong = THIRTEEN.map((f) =>
      f.key === "AUTH_URL" ? fact(f.key, f.type, ["preview"]) : f,
    );
    const verdict = judge(wrong);
    expect(verdict.exact).toBe(false);
    expect(verdict.productionProblems).toContain("missing:production:AUTH_URL");
    expect(verdict.previewProblems).toContain("unexpected:preview:AUTH_URL");
  });

  test("the same key twice on the SAME target fails", () => {
    const verdict = judge([
      ...THIRTEEN,
      fact("AUTH_URL", "encrypted", ["production"]),
    ]);
    expect(verdict.exact).toBe(false);
    expect(verdict.duplicates).toEqual(["AUTH_URL|production"]);
  });

  test("A MULTI-TARGET ENTRY REFUSES, because per-target judging would count it twice", () => {
    const verdict = judge(
      THIRTEEN.map((f) =>
        f.key === "AUTH_URL"
          ? fact(f.key, f.type, ["preview", "production"])
          : f,
      ),
    );
    expect(verdict.everySingleTarget).toBe(false);
    expect(verdict.exact).toBe(false);
  });

  test("an unknown or empty target refuses", () => {
    expect(
      judge(
        THIRTEEN.map((f) =>
          f.key === "AUTH_URL" ? fact(f.key, f.type, []) : f,
        ),
      ).exact,
    ).toBe(false);
    expect(
      judge(
        THIRTEEN.map((f) =>
          f.key === "AUTH_URL" ? fact(f.key, f.type, ["development"]) : f,
        ),
      ).exact,
    ).toBe(false);
  });

  test("A FOURTEENTH ENTRY FAILS, whatever it is", () => {
    const verdict = judge([
      ...THIRTEEN,
      fact("SOMETHING_ELSE", "encrypted", ["production"]),
    ]);
    expect(verdict.exact).toBe(false);
    expect(verdict.totalExpected).toBe(false);
    expect(verdict.productionProblems).toContain(
      "unexpected:production:SOMETHING_ELSE",
    );
  });

  test("A FORBIDDEN NAME IS CAUGHT BY NAME, not merely by being unexpected", () => {
    const verdict = judge([
      ...THIRTEEN,
      fact("CONTROL_PLANE_DEV_AUTH", "encrypted", ["production"]),
    ]);
    expect(verdict.forbiddenPresent).toEqual(["CONTROL_PLANE_DEV_AUTH"]);
    expect(verdict.exact).toBe(false);
  });

  test("the wrong type fails: a sensitive value stored readable is not the same value", () => {
    const verdict = judge(
      THIRTEEN.map((f) =>
        f.key === "AUTH_SECRET" && f.target[0] === "production"
          ? fact(f.key, "encrypted", f.target)
          : f,
      ),
    );
    expect(verdict.productionProblems).toContain("type:production:AUTH_SECRET");
    expect(verdict.exact).toBe(false);
  });

  test("the starting state is preview-only", () => {
    const start = judgeByTarget(
      THIRTEEN.filter((f) => f.target[0] === "preview"),
      PREVIEW_SHAPES,
      [],
      FORBIDDEN_ENV_NAMES,
    );
    expect(start.exact).toBe(true);
  });

  test("a live Stripe key passes on Production and refuses on Preview", () => {
    expect(
      PRODUCTION_SHAPES.find((shape) => shape.key === "STRIPE_LIVE_SECRET_KEY"),
    ).toEqual({
      key: "STRIPE_LIVE_SECRET_KEY",
      type: "sensitive",
      target: "production",
    });
    expect(judge(THIRTEEN).exact).toBe(true);
    const leakedToPreview = [
      ...THIRTEEN,
      fact("STRIPE_LIVE_SECRET_KEY", "sensitive", ["preview"]),
    ];
    const verdict = judge(leakedToPreview);
    expect(verdict.exact).toBe(false);
    expect(verdict.previewExact).toBe(false);
  });

  test("the eleven production names, and the absences that matter", () => {
    expect(PRODUCTION_SHAPES.map((s) => s.key).sort()).toEqual([
      "AUTH_GOOGLE_ID",
      "AUTH_GOOGLE_SECRET",
      "AUTH_SECRET",
      "AUTH_URL",
      "CONTROL_PLANE_DB",
      "CONTROL_PLANE_ENTRY_PRICE_ID",
      "CONTROL_PLANE_MINT_TOKEN",
      "CONTROL_PLANE_MINT_URL",
      "CONTROL_PLANE_POWERUSER_PRICE_ID",
      "CONTROL_PLANE_STRIPE_MODE",
      "STRIPE_LIVE_SECRET_KEY",
    ]);
    // Only values that are public by construction may be readable back.
    expect(
      PRODUCTION_SHAPES.filter((s) => s.type === "encrypted")
        .map((s) => s.key)
        .sort(),
    ).toEqual([
      "AUTH_GOOGLE_ID",
      "AUTH_URL",
      "CONTROL_PLANE_ENTRY_PRICE_ID",
      "CONTROL_PLANE_MINT_URL",
      "CONTROL_PLANE_POWERUSER_PRICE_ID",
      "CONTROL_PLANE_STRIPE_MODE",
    ]);
    for (const shape of PRODUCTION_SHAPES) {
      expect(
        (FORBIDDEN_ENV_NAMES as readonly string[]).includes(shape.key),
      ).toBe(false);
    }
  });
});

describe("the bounded TLS wait", () => {
  /** A clock that only moves when the code sleeps, so fifteen minutes cost
   * nothing and the BOUND is what is actually measured. */
  function fakeClock() {
    let nowMs = 1_000_000;
    const slept: number[] = [];
    return {
      now: () => nowMs,
      slept,
      sleep: async (ms: number) => {
        slept.push(ms);
        nowMs += ms;
      },
      startedAtMs: nowMs,
    };
  }

  test("AT MOST FIVE READS, AND THE LAST ONE AT THE FIFTEEN-MINUTE DEADLINE", () => {
    // The offsets are ABSOLUTE. Sleeping them cumulatively would wait 35
    // minutes for a 15-minute budget, which is the bug this pins.
    expect([...TLS_OFFSETS_MS]).toEqual([
      60_000, 180_000, 360_000, 600_000, 900_000,
    ]);
    expect(TLS_OFFSETS_MS.length).toBe(5);
    expect(Math.max(...TLS_OFFSETS_MS)).toBe(15 * 60_000);
  });

  test("never verified: five reads, and the clock lands exactly on the deadline", async () => {
    const clock = fakeClock();
    const result = await awaitTls({
      offsets: TLS_OFFSETS_MS,
      now: clock.now,
      sleep: clock.sleep,
      startedAtMs: clock.startedAtMs,
      check: async () => false,
    });
    expect(result.reads).toBe(5);
    expect(result.verified).toBe(false);
    expect(result.elapsedMs).toBe(900_000);
    expect(result.elapsedMs).toBeLessThanOrEqual(15 * 60_000);
    // Each sleep is the GAP to the next absolute offset, not the offset itself.
    expect(clock.slept).toEqual([60_000, 120_000, 180_000, 240_000, 300_000]);
  });

  test("the first success ends it immediately", async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await awaitTls({
      offsets: TLS_OFFSETS_MS,
      now: clock.now,
      sleep: clock.sleep,
      startedAtMs: clock.startedAtMs,
      check: async () => {
        calls += 1;
        return calls === 2;
      },
    });
    expect(result.reads).toBe(2);
    expect(result.verified).toBe(true);
    expect(result.elapsedMs).toBe(180_000);
  });

  test("A HANDSHAKE THAT THROWS IS 'NOT YET', not a failure", async () => {
    // A TLS reset is exactly what absence looks like, and it is the thing we
    // are waiting to stop happening - so it must not abort the wait.
    const clock = fakeClock();
    let calls = 0;
    const result = await awaitTls({
      offsets: TLS_OFFSETS_MS,
      now: clock.now,
      sleep: clock.sleep,
      startedAtMs: clock.startedAtMs,
      check: async () => {
        calls += 1;
        if (calls < 3) throw new Error("handshake reset");
        return true;
      },
    });
    expect(result.verified).toBe(true);
    expect(result.reads).toBe(3);
  });

  test("a late start does not sleep backwards", async () => {
    const clock = fakeClock();
    const result = await awaitTls({
      offsets: [60_000],
      now: clock.now,
      sleep: clock.sleep,
      // Already past the first offset.
      startedAtMs: clock.startedAtMs - 120_000,
      check: async () => true,
    });
    expect(clock.slept).toEqual([]);
    expect(result.reads).toBe(1);
  });
});

describe("the probe verdict", () => {
  const green = [
    "providers_status: 200",
    "providers_count: 1",
    "providers_only_google: true",
    "providers_has_dev: false",
    "signin_status: 200",
    "signin_has_dev_form: false",
    "signin_has_google: true",
    "office_signed_out_status: 302",
    "office_signed_out_redirects_to_signin: true",
    "office_signed_out_to_vercel: false",
    "home_status: 200",
    "home_shows_identity: true",
    "home_shows_no_office: true",
    "office_fake_account_status: 404",
    "ops_fake_account_status: 404",
    "reveal_status: 200",
    "reveal_is_forbidden: true",
    "reveal_is_failed: false",
    "reveal_has_url: false",
    "reveal_no_store: true",
    "no_auth_secret_reflected: true",
    "no_dsn_reflected: true",
    "no_mint_token_reflected: true",
    "no_oauth_secret_reflected: true",
    "no_bypass_reflected: true",
  ].join("\n");

  test("the green transcript passes", () => {
    const verdict = judgeProbe(green, 0);
    expect(verdict.missing).toEqual([]);
    expect(verdict.mismatched).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  test("A DEV PROVIDER ON PRODUCTION FAILS", () => {
    const verdict = judgeProbe(
      green
        .replace("providers_has_dev: false", "providers_has_dev: true")
        .replace("providers_count: 1", "providers_count: 2")
        .replace("providers_only_google: true", "providers_only_google: false"),
      0,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.mismatched).toContain("providers_has_dev");
  });

  test("A SIGNED-OUT 200 FAILS: that is a store-backed page served to nobody", () => {
    const verdict = judgeProbe(
      green.replace(
        "office_signed_out_status: 302",
        "office_signed_out_status: 200",
      ),
      0,
    );
    expect(verdict.signedOutRefused).toBe(false);
    expect(verdict.ok).toBe(false);
  });

  test("A REDIRECT TO VERCEL SSO FAILS, even though it is also a refusal", () => {
    // It would mean we never reached our own application, so every other probe
    // in the run would have been talking to the platform's login page.
    const verdict = judgeProbe(
      green.replace(
        "office_signed_out_to_vercel: false",
        "office_signed_out_to_vercel: true",
      ),
      0,
    );
    expect(verdict.ok).toBe(false);
  });

  test("`failed` INSTEAD OF `forbidden` FAILS: the round trip proved nothing", () => {
    // `failed` is what an unreachable provisioner or a refused bearer gives.
    // Only `forbidden` proves the deployment's own bearer reached fly and the
    // fabricated triple was refused on the far side.
    const verdict = judgeProbe(
      green
        .replace("reveal_is_forbidden: true", "reveal_is_forbidden: false")
        .replace("reveal_is_failed: false", "reveal_is_failed: true"),
      0,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.mismatched).toContain("reveal_is_forbidden");
    expect(verdict.mismatched).toContain("reveal_is_failed");
  });

  test("a returned invite URL fails: nothing may be minted for a fabricated triple", () => {
    expect(
      judgeProbe(
        green.replace("reveal_has_url: false", "reveal_has_url: true"),
        0,
      ).ok,
    ).toBe(false);
  });

  test("the store-connectivity proof failing fails the run", () => {
    // A 500 here means the deployment could not open production Neon.
    const verdict = judgeProbe(
      green.replace("home_status: 200", "home_status: 500"),
      0,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.mismatched).toContain("home_status");
  });

  test("A MISSING LINE IS NOT A PASS", () => {
    const verdict = judgeProbe(
      green
        .split("\n")
        .filter((l) => !l.startsWith("home_shows_no_office"))
        .join("\n"),
      0,
    );
    expect(verdict.missing).toEqual(["home_shows_no_office"]);
    expect(verdict.ok).toBe(false);
  });

  test("A CHILD CANNOT WIDEN WHAT THE PARENT MAY SAY", () => {
    // Anything not matching the fixed line shape is not read at all.
    const verdict = judgeProbe(
      `${green}\nleaked_dsn: postgres://user:password@host/db\nProviders: {"dev":{}}`,
      0,
    );
    expect(verdict.ok).toBe(true);
    expect(Object.keys(verdict.parsed)).not.toContain("leaked_dsn");
    expect(Object.keys(verdict.parsed)).not.toContain("Providers");
  });

  test("an empty transcript is a failure, not an absence of failures", () => {
    const verdict = judgeProbe("", 0);
    expect(verdict.ok).toBe(false);
    expect(verdict.missing.length).toBe(
      Object.keys(PROBE_EXPECTATIONS).length + 1,
    );
  });
});

describe("the deployment state shape", () => {
  test("only a fixed shape survives", () => {
    expect(shapedState("READY")).toBe("READY");
    expect(shapedState("BUILDING")).toBe("BUILDING");
    expect(shapedState("ready")).toBe("unexpected");
    expect(shapedState(undefined)).toBe("unexpected");
    expect(shapedState({ readyState: "READY" })).toBe("unexpected");
  });
});

describe("THE ROLLBACK GUARD after the deploy is invoked", () => {
  /** A guard rig whose steps can be made to fail either way: by returning
   * false (a structured verdict) or by THROWING (the case the guard exists
   * for). The call log proves the ORDER - rollback before any reporting. */
  function rig(overrides: Partial<Record<string, () => Promise<boolean>>>) {
    const calls: string[] = [];
    const step = (name: string) => async (): Promise<boolean> => {
      calls.push(name);
      const override = overrides[name];
      if (override) return override();
      return true;
    };
    return {
      calls,
      steps: {
        artifactCleanupHeld: step("cleanup"),
        correlateAndAwaitReady: step("correlate"),
        rowsZeroAfterDeploy: step("rows"),
        awaitCertificate: step("tls"),
        probe: step("probe"),
        finalStateHolds: step("final"),
        rollback: async (because: string) => {
          calls.push(`rollback:${because}`);
        },
      },
    };
  }

  test("the happy path detaches nothing", async () => {
    const r = rig({});
    expect(await afterInvocation(r.steps)).toEqual({ kind: "held" });
    expect(r.calls.some((c) => c.startsWith("rollback"))).toBe(false);
  });

  test("A THROWN CORRELATION FAILURE ROLLS BACK, it does not escape", async () => {
    // This is the hole the guard closes: an API read that raises would
    // otherwise exit the coordinator with the domain attached to a deployment
    // nobody proved.
    const r = rig({
      correlate: async () => {
        throw new Error("the deployments API reset the connection");
      },
    });
    const outcome = await afterInvocation(r.steps);
    expect(outcome.kind).toBe("rolled-back");
    expect(r.calls).toEqual([
      "cleanup",
      "correlate",
      "rollback:an error was thrown after the deploy was invoked",
    ]);
  });

  test("A THROWN PROBE SPAWN ROLLS BACK, and nothing after it runs", async () => {
    const r = rig({
      probe: async () => {
        throw new Error("the child could not be spawned");
      },
    });
    expect((await afterInvocation(r.steps)).kind).toBe("rolled-back");
    // The rollback is the LAST thing, and `final` never ran.
    expect(r.calls).toEqual([
      "cleanup",
      "correlate",
      "rows",
      "tls",
      "probe",
      "rollback:an error was thrown after the deploy was invoked",
    ]);
  });

  test("A THROWN FINAL-STATE READ ROLLS BACK", async () => {
    const r = rig({
      final: async () => {
        throw new Error("the domains API failed");
      },
    });
    expect((await afterInvocation(r.steps)).kind).toBe("rolled-back");
    expect(r.calls.at(-1)).toBe(
      "rollback:an error was thrown after the deploy was invoked",
    );
  });

  test("a structured failure rolls back with its own reason", async () => {
    for (const [name, because] of [
      ["correlate", "the production deployment did not hold"],
      ["rows", "production data appeared during the deploy"],
      ["probe", "a probe failed its acceptance predicate"],
      ["final", "a row count or the attachment did not hold"],
    ] as const) {
      const r = rig({ [name]: async () => false });
      expect(await afterInvocation(r.steps)).toEqual({
        kind: "rolled-back",
        because,
      });
      expect(r.calls.at(-1)).toBe(`rollback:${because}`);
    }
  });

  test("THE TLS TIMEOUT IS THE ONE EXCEPTION: park attached, never detach", async () => {
    // Manager-ruled. Production never began serving, so there is nothing
    // public to roll back, and detaching would throw away a working domain.
    const r = rig({ tls: async () => false });
    expect(await afterInvocation(r.steps)).toEqual({ kind: "parked-no-tls" });
    expect(r.calls.some((c) => c.startsWith("rollback"))).toBe(false);
    expect(r.calls).not.toContain("probe");
  });

  test("a rollback that itself throws does not swallow the outcome", async () => {
    const r = rig({ probe: async () => false });
    const steps = {
      ...r.steps,
      rollback: async () => {
        throw new Error("detach failed");
      },
    };
    // The guard's own catch turns it into the thrown-error rollback path
    // rather than crashing the coordinator with a public deployment.
    expect((await afterInvocation(steps)).kind).toBe("rolled-back");
  });
});

describe("the probe transcript is CLOSED", () => {
  const green = [
    "providers_status: 200",
    "providers_count: 1",
    "providers_only_google: true",
    "providers_has_dev: false",
    "signin_status: 200",
    "signin_has_dev_form: false",
    "signin_has_google: true",
    "office_signed_out_status: 302",
    "office_signed_out_redirects_to_signin: true",
    "office_signed_out_to_vercel: false",
    "home_status: 200",
    "home_shows_identity: true",
    "home_shows_no_office: true",
    "office_fake_account_status: 404",
    "ops_fake_account_status: 404",
    "reveal_status: 200",
    "reveal_is_forbidden: true",
    "reveal_is_failed: false",
    "reveal_has_url: false",
    "reveal_no_store: true",
    "no_auth_secret_reflected: true",
    "no_dsn_reflected: true",
    "no_mint_token_reflected: true",
    "no_oauth_secret_reflected: true",
    "no_bypass_reflected: true",
  ].join("\n");

  test("AN UNEXPECTED SHAPED LINE IS REFUSED, not quietly carried", () => {
    // A child could otherwise widen the parent's output with a shaped name
    // nobody asked for - `secret_length: 44` is the shape of a leak.
    const verdict = judgeProbe(`${green}\nsecret_length: 44`, 0);
    expect(verdict.unexpected).toEqual(["secret_length"]);
    expect(verdict.ok).toBe(false);
    expect(Object.keys(verdict.parsed)).not.toContain("secret_length");
  });

  test("A DUPLICATE LINE IS REFUSED: a later line must not replace a result", () => {
    // Without this, a child that printed `home_status: 500` and then
    // `home_status: 200` would pass on the second line.
    const verdict = judgeProbe(`${green}\nhome_status: 500`, 0);
    expect(verdict.duplicated).toEqual(["home_status"]);
    expect(verdict.ok).toBe(false);
    // The FIRST value is the one kept, so the duplicate cannot rewrite it.
    expect(verdict.parsed.home_status).toBe(200);
  });

  test("A GREEN TRANSCRIPT WITH A NON-ZERO EXIT IS REFUSED", () => {
    // The child died after its last line; the transcript is not the verdict.
    const verdict = judgeProbe(green, 1);
    expect(verdict.missing).toEqual([]);
    expect(verdict.mismatched).toEqual([]);
    expect(verdict.exitedZero).toBe(false);
    expect(verdict.ok).toBe(false);
  });

  test("each secret class is its own canary", () => {
    for (const name of [
      "no_auth_secret_reflected",
      "no_dsn_reflected",
      "no_mint_token_reflected",
      "no_oauth_secret_reflected",
      "no_bypass_reflected",
    ]) {
      const verdict = judgeProbe(
        green.replace(`${name}: true`, `${name}: false`),
        0,
      );
      expect({ name, ok: verdict.ok }).toEqual({ name, ok: false });
      expect(verdict.mismatched).toContain(name);
    }
  });

  test("A REDIRECT TO OUR HOST BUT THE WRONG PATH IS NOT A PASS", () => {
    const verdict = judgeProbe(
      green.replace(
        "office_signed_out_redirects_to_signin: true",
        "office_signed_out_redirects_to_signin: false",
      ),
      0,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.mismatched).toContain(
      "office_signed_out_redirects_to_signin",
    );
  });
});

describe("the secret files", () => {
  const OAUTH = [
    "GOOGLE_CLIENT_ID='1234567890-abc123def456.apps.googleusercontent.com'",
    "GOOGLE_CLIENT_SECRET='GOCSPX-abcdefghijklmnop'",
  ].join("\n");
  const NAMES = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];

  test("the expected file parses", () => {
    const parsed = parseSecretText(OAUTH, NAMES);
    expect([...parsed.keys()].sort()).toEqual(NAMES);
  });

  test("A REPEATED NAME IS REFUSED, even when both lines agree", () => {
    // A Map would keep the last silently, and "which of these is the
    // credential" is not a question a program should answer alone.
    expect(() =>
      parseSecretText(
        `${OAUTH}\nGOOGLE_CLIENT_SECRET='GOCSPX-abcdefghijklmnop'`,
        NAMES,
      ),
    ).toThrow();
  });

  test("an extra or a missing name is refused", () => {
    expect(() => parseSecretText(`${OAUTH}\nEXTRA='x'`, NAMES)).toThrow();
    expect(() =>
      parseSecretText(
        "GOOGLE_CLIENT_ID='1-a.apps.googleusercontent.com'",
        NAMES,
      ),
    ).toThrow();
  });

  test("A MISSHAPEN CREDENTIAL IS REFUSED BEFORE IT CAN BE WRITTEN", () => {
    // These are written `sensitive` and cannot be read back, so a wrong value
    // would first show up as a broken sign-in on a public hostname.
    expect(() =>
      parseSecretText(
        OAUTH.replace("GOCSPX-abcdefghijklmnop", "not-a-google-secret"),
        NAMES,
      ),
    ).toThrow();
    expect(() =>
      parseSecretText(
        OAUTH.replace(".apps.googleusercontent.com", ".example.com"),
        NAMES,
      ),
    ).toThrow();
    expect(() =>
      parseSecretText("CONTROL_PLANE_MINT_TOKEN='short'", [
        "CONTROL_PLANE_MINT_TOKEN",
      ]),
    ).toThrow();
    expect(() =>
      parseSecretText(`CONTROL_PLANE_MINT_TOKEN='${"a".repeat(40)}'`, [
        "CONTROL_PLANE_MINT_TOKEN",
      ]),
    ).not.toThrow();
    // Upper-case hex is not the measured shape.
    expect(() =>
      parseSecretText(`CONTROL_PLANE_MINT_TOKEN='${"A".repeat(40)}'`, [
        "CONTROL_PLANE_MINT_TOKEN",
      ]),
    ).toThrow();
  });

  test("an unquoted or empty value is refused", () => {
    expect(() =>
      parseSecretText("GOOGLE_CLIENT_ID=bare", ["GOOGLE_CLIENT_ID"]),
    ).toThrow();
    expect(() =>
      parseSecretText("CONTROL_PLANE_MINT_TOKEN=''", [
        "CONTROL_PLANE_MINT_TOKEN",
      ]),
    ).toThrow();
  });

  test("the shapes are the measured ones", () => {
    expect(SECRET_SHAPES.CONTROL_PLANE_MINT_TOKEN.source).toBe(
      "^[0-9a-f]{40}$",
    );
    expect(
      SECRET_SHAPES.GOOGLE_CLIENT_ID.test("1-a.apps.googleusercontent.com"),
    ).toBe(true);
    expect(
      SECRET_SHAPES.STRIPE_LIVE_SECRET_KEY.test("rk_live_public_shape"),
    ).toBe(true);
    expect(
      SECRET_SHAPES.STRIPE_LIVE_SECRET_KEY.test("sk_live_public_shape"),
    ).toBe(false);
    expect(
      SECRET_SHAPES.CONTROL_PLANE_ENTRY_PRICE_ID.test("price_public_shape"),
    ).toBe(true);
    expect(
      SECRET_SHAPES.CONTROL_PLANE_POWERUSER_PRICE_ID.test("price_public_shape"),
    ).toBe(true);
  });
});

describe("THE BEARER MAPPING, which is what `forbidden` actually proves", () => {
  /** The seam, faked at the fetch boundary, so the CLIENT's mapping is what is
   * under test rather than the provisioner's behaviour. */
  function withFetch<T>(
    impl: (url: string, init: RequestInit) => Promise<Response>,
    body: () => Promise<T>,
  ): Promise<T> {
    const real = globalThis.fetch;
    globalThis.fetch = ((url: string, init: RequestInit) =>
      impl(url, init)) as unknown as typeof fetch;
    return body().finally(() => {
      globalThis.fetch = real;
    });
  }

  const triple = {
    accountId: "acc",
    instanceId: "no-such-instance",
    operationId: "no-such-operation",
  };

  test("AN ACCEPTED BEARER WITH A FABRICATED TRIPLE MAPS TO `forbidden`", async () => {
    // The provisioner answers HTTP 404 with this body for an unknown office.
    // `forbidden` reaching the caller therefore proves the bearer was ACCEPTED
    // - a rejected one never gets this far.
    let sawAuthorization = "";
    let calledUrl = "";
    const result = await withFetch(
      async (url, init) => {
        calledUrl = url;
        sawAuthorization = String(
          (init.headers as Record<string, string>).authorization,
        );
        return new Response(
          JSON.stringify({ status: "forbidden", reason: "no such office" }),
          { status: 404 },
        );
      },
      () =>
        fetchInviteFromSeam(
          { baseUrl: "https://provisioner.example", token: "the-bearer" },
          triple,
        ),
    );
    expect(result.status).toBe("forbidden");
    // It really made the call, rather than deciding locally.
    expect(calledUrl).toBe("https://provisioner.example/internal/invite");
    expect(sawAuthorization).toBe("Bearer the-bearer");
  });

  test("A REJECTED BEARER MAPS TO `failed`, which is why the two must differ", async () => {
    const result = await withFetch(
      async () => new Response("unauthorized\n", { status: 401 }),
      () =>
        fetchInviteFromSeam(
          { baseUrl: "https://provisioner.example", token: "wrong" },
          triple,
        ),
    );
    expect(result.status).toBe("failed");
  });

  test("an unreachable provisioner also maps to `failed`, never to forbidden", async () => {
    const result = await withFetch(
      async () => {
        throw new Error("connection refused");
      },
      () =>
        fetchInviteFromSeam(
          { baseUrl: "https://provisioner.example", token: "the-bearer" },
          triple,
        ),
    );
    expect(result.status).toBe("failed");
  });

  test("`forbidden` IS NOT SYNTHESIZED LOCALLY: with no call, there is no forbidden", async () => {
    // Every non-call path in the client produces `failed`. So a `forbidden`
    // in the transcript cannot have been invented on this side.
    for (const response of [
      new Response("not json", { status: 404 }),
      new Response(JSON.stringify({ status: "nonsense" }), { status: 200 }),
      new Response(JSON.stringify({ status: "ready" }), { status: 200 }),
    ]) {
      const result = await withFetch(
        async () => response,
        () =>
          fetchInviteFromSeam(
            { baseUrl: "https://provisioner.example", token: "t" },
            triple,
          ),
      );
      expect(result.status).not.toBe("forbidden");
    }
  });
});

describe("the two holes the second review found", () => {
  function rig2(overrides: Partial<Record<string, () => Promise<boolean>>>) {
    const calls: string[] = [];
    const step = (name: string) => async (): Promise<boolean> => {
      calls.push(name);
      const override = overrides[name];
      if (override) return override();
      return true;
    };
    return {
      calls,
      steps: {
        artifactCleanupHeld: step("cleanup"),
        correlateAndAwaitReady: step("correlate"),
        rowsZeroAfterDeploy: step("rows"),
        awaitCertificate: step("tls"),
        probe: step("probe"),
        finalStateHolds: step("final"),
        rollback: async (because: string) => {
          calls.push(`rollback:${because}`);
        },
      },
    };
  }

  test("A POST-SPAWN ARTIFACT-CLEANUP FAILURE DETACHES BEFORE ANYTHING ELSE", async () => {
    // The cleanup runs OUTSIDE the guard, in a `finally`, so its failure is
    // carried in as a value. Before this, a throwing rmSync after
    // `deploy --prod` exited the coordinator with the domain still attached.
    const r = rig2({ cleanup: async () => false });
    expect(await afterInvocation(r.steps)).toEqual({
      kind: "rolled-back",
      because: "the artifact could not be tidied after the deploy",
    });
    // The rollback is the NEXT external action: nothing else ran.
    expect(r.calls).toEqual([
      "cleanup",
      "rollback:the artifact could not be tidied after the deploy",
    ]);
    expect(r.calls).not.toContain("correlate");
  });

  test("a cleanup step that THROWS also detaches", async () => {
    const r = rig2({
      cleanup: async () => {
        throw new Error("rmSync failed");
      },
    });
    expect((await afterInvocation(r.steps)).kind).toBe("rolled-back");
    expect(r.calls.at(-1)).toBe(
      "rollback:an error was thrown after the deploy was invoked",
    );
  });

  test("EVERY SECRET HOLDER IS DROPPED, including the copies", async () => {
    // `values` holds independent copies of all four secrets; clearing the two
    // file maps and the generated box left those copies alive.
    const oauth = new Map([["GOOGLE_CLIENT_SECRET", "GOCSPX-secret"]]);
    const mint = new Map([["CONTROL_PLANE_MINT_TOKEN", "a".repeat(40)]]);
    const values = new Map([
      ["CONTROL_PLANE_DB", "postgres://user:pw@host/db"],
      ["AUTH_SECRET", "generated"],
      ["CONTROL_PLANE_MINT_TOKEN", "a".repeat(40)],
      ["AUTH_GOOGLE_SECRET", "GOCSPX-secret"],
    ]);
    const held = { authSecret: "generated" };

    dropHolders([oauth, mint, values], [held]);

    expect(oauth.size).toBe(0);
    expect(mint.size).toBe(0);
    expect(values.size).toBe(0);
    expect(held.authSecret).toBe("");
    // Nothing survives in any of them.
    for (const map of [oauth, mint, values]) {
      expect([...map.values()].join("")).toBe("");
    }
  });
});

describe("DETACH BEFORE DIAGNOSIS, at the orchestration level", () => {
  test("NO DIAGNOSTIC IS PRINTED BEFORE THE ROLLBACK when cleanup failed", async () => {
    // The defect this pins: the cleanup boolean used to be printed as soon as
    // it was known, which is before the guard runs - making a report, not the
    // detach, the next external action after a failure. The unit test on
    // `afterInvocation` could not see it, because the print lived in `main`.
    const order: string[] = [];
    const steps = {
      artifactCleanupHeld: async () => false,
      correlateAndAwaitReady: async () => true,
      rowsZeroAfterDeploy: async () => true,
      awaitCertificate: async () => true,
      probe: async () => true,
      finalStateHolds: async () => true,
      rollback: async (because: string) => {
        order.push(`rollback:${because}`);
      },
    };
    const outcome = await guardedRun(
      steps,
      (line) => order.push(line),
      [],
      true,
    );

    expect(outcome).toEqual({
      kind: "rolled-back",
      because: "the artifact could not be tidied after the deploy",
    });
    // The ORDER is the assertion: detach first, and only then the diagnostic.
    expect(order).toEqual([
      "rollback:the artifact could not be tidied after the deploy",
      "artifact_cleanup_failed: true",
    ]);
    expect(order[0].startsWith("rollback:")).toBe(true);
  });

  test("on the happy path the diagnostic still reports, and reports false", async () => {
    const order: string[] = [];
    const steps = {
      artifactCleanupHeld: async () => true,
      correlateAndAwaitReady: async () => true,
      rowsZeroAfterDeploy: async () => true,
      awaitCertificate: async () => true,
      probe: async () => true,
      finalStateHolds: async () => true,
      rollback: async () => {
        order.push("rollback");
      },
    };
    const outcome = await guardedRun(
      steps,
      (line) => order.push(line),
      [],
      false,
    );
    expect(outcome).toEqual({ kind: "held" });
    expect(order).toEqual(["artifact_cleanup_failed: false"]);
  });

  test("the TLS park reports without any rollback", async () => {
    const order: string[] = [];
    const outcome = await guardedRun(
      {
        artifactCleanupHeld: async () => true,
        correlateAndAwaitReady: async () => true,
        rowsZeroAfterDeploy: async () => true,
        awaitCertificate: async () => false,
        probe: async () => true,
        finalStateHolds: async () => true,
        rollback: async () => {
          order.push("rollback");
        },
      },
      (line) => order.push(line),
      [],
      false,
    );
    expect(outcome).toEqual({ kind: "parked-no-tls" });
    expect(order).toEqual(["artifact_cleanup_failed: false"]);
  });
});

describe("CONDITION 3(b) ACROSS EVERY POST-INVOCATION FAILURE PATH", () => {
  /**
   * The rig that matters: each callback writes its diagnostics into `notes`
   * exactly as the real ones do, the rollback writes into `order`, and
   * `guardedRun` flushes `notes` into `order` afterwards. So the assertion is
   * the SEQUENCE a reader of the transcript would actually see.
   *
   * The earlier seam test proved only the artifact-cleanup line. These prove
   * the paths that matter most - a failing probe used to print its whole
   * transcript, mismatches and all, before the domain came down.
   */
  function rig3(failing: string, diagnostics: string[]) {
    const order: string[] = [];
    const notes: string[] = [];
    const step = (name: string) => async (): Promise<boolean> => {
      if (name === failing) {
        for (const line of diagnostics) notes.push(line);
        return false;
      }
      return true;
    };
    return {
      order,
      notes,
      steps: {
        artifactCleanupHeld: step("cleanup"),
        correlateAndAwaitReady: step("correlate"),
        rowsZeroAfterDeploy: step("rows"),
        awaitCertificate: step("tls"),
        probe: step("probe"),
        finalStateHolds: step("final"),
        rollback: async (because: string) => {
          order.push(`rollback:${because}`);
        },
      },
    };
  }

  test("A FAILING PROBE DETACHES BEFORE ITS TRANSCRIPT IS PRINTED", async () => {
    const r = rig3("probe", [
      "  probe_home_status: 500",
      "probe_mismatched: 1",
      "  mismatched: home_status",
      "probes_ok: false",
    ]);
    const outcome = await guardedRun(
      r.steps,
      (line) => r.order.push(line),
      r.notes,
      false,
    );
    expect(outcome.kind).toBe("rolled-back");
    expect(r.order).toEqual([
      "rollback:a probe failed its acceptance predicate",
      "  probe_home_status: 500",
      "probe_mismatched: 1",
      "  mismatched: home_status",
      "probes_ok: false",
      "artifact_cleanup_failed: false",
    ]);
    // The first thing that happens is the detach. Nothing about WHY precedes it.
    expect(r.order[0].startsWith("rollback:")).toBe(true);
  });

  test("a failing row/attachment check detaches before its counts are printed", async () => {
    const r = rig3("final", [
      "  production_after_accounts: 1",
      "production_rows_zero_after_probes: false",
      "attachment_still_held: true",
    ]);
    const outcome = await guardedRun(
      r.steps,
      (line) => r.order.push(line),
      r.notes,
      false,
    );
    expect(outcome.kind).toBe("rolled-back");
    expect(r.order[0]).toBe(
      "rollback:a row count or the attachment did not hold",
    );
    expect(r.order.slice(1, 4)).toEqual([
      "  production_after_accounts: 1",
      "production_rows_zero_after_probes: false",
      "attachment_still_held: true",
    ]);
  });

  test("a correlation or build failure detaches before the build evidence", async () => {
    const r = rig3("correlate", [
      "deployment_found: true",
      "deployment_is_this_run: true",
      "deployment_state: ERROR",
      "build_evidence_all_hold: false",
    ]);
    const outcome = await guardedRun(
      r.steps,
      (line) => r.order.push(line),
      r.notes,
      false,
    );
    expect(outcome.kind).toBe("rolled-back");
    expect(r.order[0]).toBe("rollback:the production deployment did not hold");
    expect(r.order).toContain("deployment_state: ERROR");
    expect(
      r.order.indexOf("rollback:the production deployment did not hold"),
    ).toBeLessThan(r.order.indexOf("deployment_state: ERROR"));
  });

  test("THE TLS TIMEOUT FLUSHES ITS EVIDENCE WITH NO ROLLBACK AT ALL", async () => {
    // Ruled exception: Production never began serving, so there is nothing to
    // detach and the evidence is simply reported.
    const r = rig3("tls", [
      "tls_reads: 5",
      "tls_verified: false",
      "tls_within_deadline: true",
    ]);
    const outcome = await guardedRun(
      r.steps,
      (line) => r.order.push(line),
      r.notes,
      false,
    );
    expect(outcome).toEqual({ kind: "parked-no-tls" });
    expect(r.order.some((l) => l.startsWith("rollback:"))).toBe(false);
    expect(r.order).toEqual([
      "tls_reads: 5",
      "tls_verified: false",
      "tls_within_deadline: true",
      "artifact_cleanup_failed: false",
    ]);
  });

  test("on success the diagnostics are flushed and nothing was detached", async () => {
    const r = rig3("nothing-fails", []);
    r.notes.push("deployment_state: READY", "probes_ok: true");
    const outcome = await guardedRun(
      r.steps,
      (line) => r.order.push(line),
      r.notes,
      false,
    );
    expect(outcome).toEqual({ kind: "held" });
    expect(r.order.some((l) => l.startsWith("rollback:"))).toBe(false);
    expect(r.order).toContain("probes_ok: true");
  });
});

describe("REDEPLOY MODE writes nothing and claims less", () => {
  test("ARGUMENT PARSING IS CLOSED: an unrecognised argument refuses", () => {
    // Failing open here chose the ENVIRONMENT-WRITING path, so a typo was one
    // keystroke away from rewriting ten production values.
    expect(modeFrom(["bun", "production-phase.ts"])).toBe("first");
    expect(modeFrom(["bun", "production-phase.ts", "--redeploy"])).toBe(
      "redeploy",
    );
    for (const args of [
      ["--redeply"],
      ["--redeploy-later"],
      ["--redeploy", "--redeploy"],
      ["--redeploy", "extra"],
      ["extra"],
      ["--redeploy=true"],
      ["-r"],
    ]) {
      expect({ args, mode: modeFrom(["bun", "phase.ts", ...args]) }).toEqual({
        args,
        mode: null,
      });
    }
  });

  test("NO ENV MUTATION IS REACHABLE IN REDEPLOY MODE", () => {
    // The enforcement is structural rather than a guard: the loop that issues
    // createEnv iterates this list, and in redeploy mode it is empty, so no
    // create/PATCH/delete call is reached at all.
    expect(envWritesFor("redeploy")).toEqual([]);
    expect(envWritesFor("first").length).toBe(11);
  });

  test("a redeploy requires the environment ALREADY complete, not empty", () => {
    // The first deploy demanded preview-only; a redeploy demands the full 2+11,
    // which is why the unchanged coordinator refuses to run twice.
    expect(expectedProductionBefore("first")).toEqual([]);
    expect(expectedProductionBefore("redeploy").length).toBe(11);
  });

  test("a first deploy demands an empty database, exactly", () => {
    expect(EMPTY_ROWS).toEqual({
      accounts: 0,
      name_reservations: 0,
      instances: 0,
      operations: 0,
    });
    expect(beforeRowsAcceptable("first", { ...EMPTY_ROWS })).toBe(true);
    expect(beforeRowsAcceptable("first", { ...EMPTY_ROWS, accounts: 1 })).toBe(
      false,
    );
  });

  test("A REDEPLOY ACCEPTS A PRODUCTION THAT HAS BEEN USED (task f5ed4b60)", () => {
    // The bug: fixed {accounts: 1, ...zeros} was true only while Nil's sign-in
    // was the whole of production. The first customer office made it false and
    // would have blocked every later redeploy.
    const used = {
      accounts: 1,
      name_reservations: 1,
      instances: 1,
      operations: 12,
    };
    expect(beforeRowsAcceptable("redeploy", used)).toBe(true);
    expect(beforeRowsAcceptable("first", used)).toBe(false);
  });

  test("a redeploy still refuses an empty or unreadable database", () => {
    // Empty is not production: the account bound on 2026-08-11 is still there.
    expect(beforeRowsAcceptable("redeploy", { ...EMPTY_ROWS })).toBe(false);
    // rowCounts reports -1 for a count it could not read, and a reading nobody
    // could take is not a reading that passed.
    expect(
      beforeRowsAcceptable("redeploy", {
        accounts: 1,
        name_reservations: -1,
        instances: 0,
        operations: 0,
      }),
    ).toBe(false);
    expect(beforeRowsAcceptable("redeploy", {})).toBe(false);
  });

  test("A PARTIAL READING IS NOT A READING (reviewer finding, 2026-08-12)", () => {
    // The defect: iterating whatever keys the reading carried accepted
    // `{accounts: 1}`, so a live redeploy could proceed having established
    // nothing about three of the four tables.
    expect(beforeRowsAcceptable("redeploy", { accounts: 1 })).toBe(false);
    const used = {
      accounts: 1,
      name_reservations: 1,
      instances: 1,
      operations: 4,
    };
    for (const table of USER_TABLES) {
      const { [table]: _missing, ...partial } = used;
      expect({ table, ok: beforeRowsAcceptable("redeploy", partial) }).toEqual({
        table,
        ok: false,
      });
    }
    // And the whole reading still passes, so the cases above fail for the
    // missing key rather than for something else about the fixture.
    expect(beforeRowsAcceptable("redeploy", used)).toBe(true);
  });

  test("a count that is not a whole non-negative number is not readable", () => {
    const used = {
      accounts: 1,
      name_reservations: 0,
      instances: 0,
      operations: 0,
    };
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1.5,
      -1,
      "3" as unknown as number,
      null as unknown as number,
      undefined as unknown as number,
    ]) {
      expect(
        beforeRowsAcceptable("redeploy", { ...used, operations: bad }),
      ).toBe(false);
      // The account count is judged by the same rule, not by a bare comparison
      // that a non-number could slip through.
      expect(beforeRowsAcceptable("redeploy", { ...used, accounts: bad })).toBe(
        false,
      );
    }
  });

  test("the AFTER expectation is the before reading, whatever it held", () => {
    const before = {
      accounts: 3,
      name_reservations: 2,
      instances: 2,
      operations: 41,
    };
    const want = afterRowsExpected(before);
    expect(rowsMatch({ ...before }, want)).toBe(true);
    // Any movement during the deploy is still an acceptance failure.
    expect(rowsMatch({ ...before, accounts: 4 }, want)).toBe(false);
    expect(rowsMatch({ ...before, operations: 42 }, want)).toBe(false);
    // A missing table is not silently equal.
    expect(rowsMatch({ accounts: 3 }, want)).toBe(false);
    // The snapshot is a COPY: a later mutation of the reading cannot move the
    // expectation the run is judged against.
    before.accounts = 99;
    expect(want.accounts).toBe(3);
  });

  test("THE REDEPLOY CLAIMS NO AUTHENTICATED RESULT, and cannot", () => {
    const unauth = probeExpectationsFor("redeploy");
    expect(unauth).toBe(UNAUTH_PROBE_EXPECTATIONS);
    // Every authenticated claim is ABSENT rather than asserted false: without a
    // readable AUTH_SECRET there is no cookie to mint and nothing to check.
    for (const gone of [
      "home_status",
      "home_shows_identity",
      "home_shows_no_office",
      "office_fake_account_status",
      "ops_fake_account_status",
      "reveal_status",
      "reveal_is_forbidden",
      "reveal_is_failed",
      "reveal_has_url",
      "reveal_no_store",
    ]) {
      expect({ gone, present: gone in unauth }).toEqual({
        gone,
        present: false,
      });
    }
    // And the equality-based reflection canaries are gone too, replaced by the
    // weaker name-based one, under a DIFFERENT key so they cannot be confused.
    for (const gone of [
      "no_auth_secret_reflected",
      "no_dsn_reflected",
      "no_mint_token_reflected",
      "no_oauth_secret_reflected",
    ]) {
      expect({ gone, present: gone in unauth }).toEqual({
        gone,
        present: false,
      });
    }
    expect(unauth.no_credential_names_reflected).toBe(true);
    expect(unauth.no_bypass_reflected).toBe(true);
  });

  test("the unauthenticated subset still proves what an anonymous visitor sees", () => {
    const unauth = probeExpectationsFor("redeploy");
    expect(unauth.providers_only_google).toBe(true);
    expect(unauth.providers_has_dev).toBe(false);
    expect(unauth.signin_has_dev_form).toBe(false);
    expect(unauth.signin_has_google).toBe(true);
    expect(unauth.office_signed_out_redirects_to_signin).toBe(true);
    expect(unauth.office_signed_out_to_vercel).toBe(false);
  });

  test("A REDEPLOY TRANSCRIPT CARRYING AN AUTHENTICATED LINE IS REFUSED", () => {
    // If the child ever minted a cookie in redeploy mode, its extra lines are
    // outside the closed set for this mode and the run fails.
    const green = Object.entries(UNAUTH_PROBE_EXPECTATIONS)
      .map(([k, v]) => `${k}: ${v}`)
      .concat("office_signed_out_status: 307")
      .join("\n");
    expect(judgeProbe(green, 0, UNAUTH_PROBE_EXPECTATIONS).ok).toBe(true);
    const extra = judgeProbe(
      `${green}\nhome_shows_identity: true`,
      0,
      UNAUTH_PROBE_EXPECTATIONS,
    );
    expect(extra.unexpected).toEqual(["home_shows_identity"]);
    expect(extra.ok).toBe(false);
  });

  test("the first-deploy transcript is NOT accepted as a redeploy and vice versa", () => {
    const unauthGreen = Object.entries(UNAUTH_PROBE_EXPECTATIONS)
      .map(([k, v]) => `${k}: ${v}`)
      .concat("office_signed_out_status: 307")
      .join("\n");
    // Judged against the FULL expectations, the redeploy transcript is missing
    // every authenticated line.
    const asFull = judgeProbe(unauthGreen, 0, PROBE_EXPECTATIONS);
    expect(asFull.ok).toBe(false);
    expect(asFull.missing).toContain("home_status");
    expect(probeKeysFor(UNAUTH_PROBE_EXPECTATIONS).length).toBeLessThan(
      probeKeysFor(PROBE_EXPECTATIONS).length,
    );
  });
});

describe("A REDEPLOY TOUCHES NO CREDENTIAL", () => {
  /** Readers as spies, so "it did not open the files" is measured rather than
   * argued from control flow. */
  function spies() {
    const called: string[] = [];
    return {
      called,
      deps: {
        readOauth: () => {
          called.push("readOauth");
          return new Map([
            ["GOOGLE_CLIENT_ID", "id.apps.googleusercontent.com"],
            ["GOOGLE_CLIENT_SECRET", "GOCSPX-secret"],
          ]);
        },
        readMint: () => {
          called.push("readMint");
          return new Map([["CONTROL_PLANE_MINT_TOKEN", "a".repeat(40)]]);
        },
        readStripe: () => {
          called.push("readStripe");
          return new Map([
            ["STRIPE_LIVE_SECRET_KEY", "rk_live_public_shape"],
            ["CONTROL_PLANE_ENTRY_PRICE_ID", "price_entry_shape"],
            ["CONTROL_PLANE_POWERUSER_PRICE_ID", "price_poweruser_shape"],
          ]);
        },
        generate: () => {
          called.push("generate");
          return "generated-secret";
        },
        dsn: "postgres://user:pw@host/db",
      },
    };
  }

  test("REDEPLOY OPENS NO SECRET FILE AND GENERATES NO SECRET", () => {
    const s = spies();
    expect(buildHolders("redeploy", s.deps)).toBeNull();
    expect(s.called).toEqual([]);
  });

  test("the first deploy reads all files, generates once, and builds the eleven", () => {
    const s = spies();
    const holders = buildHolders("first", s.deps);
    expect(s.called.sort()).toEqual([
      "generate",
      "readMint",
      "readOauth",
      "readStripe",
    ]);
    expect(holders?.values.size).toBe(11);
    expect(holders?.values.get("AUTH_SECRET")).toBe("generated-secret");
  });

  test("THE PROBE CHILD IS SENT NO SECRET IN REDEPLOY MODE", () => {
    // The empty secret is what keeps the child on the anonymous path. A
    // non-empty one would run the authenticated branch, whose extra lines the
    // parent refuses as unexpected - and then detaches a healthy domain.
    const ids = {
      accountId: "a",
      email: "e@example.invalid",
      instanceId: "i",
      operationId: "o",
    };
    const input = probeInputFor("redeploy", null, ids);
    expect(input.secret).toBe("");
    expect(input.secrets).toEqual([]);
    // Even if holders somehow existed, redeploy still sends nothing.
    const s = spies();
    const holders = buildHolders("first", s.deps);
    expect(probeInputFor("redeploy", holders, ids).secret).toBe("");
    expect(probeInputFor("redeploy", holders, ids).secrets).toEqual([]);
  });

  test("the first deploy sends the secret and all five classes to scan", () => {
    const s = spies();
    const holders = buildHolders("first", s.deps);
    const input = probeInputFor("first", holders, {
      accountId: "a",
      email: "e@example.invalid",
      instanceId: "i",
      operationId: "o",
    });
    expect(input.secret).toBe("generated-secret");
    expect(input.secrets.length).toBe(5);
    // The OAuth CLIENT ID is public and deliberately absent from the scan set.
    expect(input.secrets).not.toContain("id.apps.googleusercontent.com");
  });
});

describe("post-deploy row checks compare against the run's own before reading", () => {
  test("ONE ACCOUNT PASSES A REDEPLOY AND FAILS A FIRST DEPLOY", () => {
    // The bug this pins: post-deploy checks that demanded zero would have
    // detached a healthy production the moment a real account existed.
    const live = {
      accounts: 1,
      name_reservations: 0,
      instances: 0,
      operations: 0,
    };
    expect(beforeRowsAcceptable("redeploy", live)).toBe(true);
    expect(beforeRowsAcceptable("first", live)).toBe(false);
    expect(rowsMatch(live, afterRowsExpected(live))).toBe(true);
  });

  test("an empty database fails a redeploy: the account must still be there", () => {
    const empty = {
      accounts: 0,
      name_reservations: 0,
      instances: 0,
      operations: 0,
    };
    expect(beforeRowsAcceptable("redeploy", empty)).toBe(false);
    expect(beforeRowsAcceptable("first", empty)).toBe(true);
  });

  test("ANY table growing DURING a deploy is an acceptance failure", () => {
    // The claim is that the deploy changed nothing, and it holds whatever the
    // starting counts were - here a production carrying one live office.
    const before = {
      accounts: 2,
      name_reservations: 1,
      instances: 1,
      operations: 9,
    };
    const want = afterRowsExpected(before);
    for (const table of [
      "accounts",
      "name_reservations",
      "instances",
      "operations",
    ]) {
      const grew = {
        ...before,
        [table]: before[table as keyof typeof before] + 1,
      };
      expect({ table, ok: rowsMatch(grew, want) }).toEqual({
        table,
        ok: false,
      });
    }
  });
});

describe("the environment is re-proved AFTER the deployment", () => {
  test("exact 2+11 passes", () => {
    expect(judge(THIRTEEN).exact).toBe(true);
  });

  test("a missing Preview twin, a tenth entry, a wrong target and a wrong type all fail", () => {
    expect(
      judge(
        THIRTEEN.filter(
          (f) => !(f.key === "AUTH_SECRET" && f.target[0] === "preview"),
        ),
      ).exact,
    ).toBe(false);
    expect(
      judge([...THIRTEEN, fact("EXTRA", "encrypted", ["production"])]).exact,
    ).toBe(false);
    expect(
      judge(
        THIRTEEN.map((f) =>
          f.key === "CONTROL_PLANE_MINT_URL"
            ? fact(f.key, f.type, ["preview"])
            : f,
        ),
      ).exact,
    ).toBe(false);
    expect(
      judge(
        THIRTEEN.map((f) =>
          f.key === "AUTH_GOOGLE_SECRET"
            ? fact(f.key, "encrypted", f.target)
            : f,
        ),
      ).exact,
    ).toBe(false);
  });
});
