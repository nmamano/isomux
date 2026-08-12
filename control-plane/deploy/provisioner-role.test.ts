// The provisioner's credential move, as properties rather than as a runbook.
//
// The live half of G3 cannot be unit tested - it moves a fly secret and
// replaces a machine - so what is tested here is everything that DECIDES: which
// phase an interrupted run inherits, what each phase's recovery is, what may
// start a forward run at all, and the two configuration facts the overlap
// arithmetic rests on.
//
// The reason the phase reading is worth a test of its own: a resumed run has no
// memory of the run before it, so if `classifyPhase` is wrong about a state,
// the recovery it chooses is wrong about a live deployment.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEPLOY_ARGV,
  classifyPhase,
  closeCredentialSql,
  generatedPassword,
  mayGoForward,
  openCredentialSql,
  recoveryFor,
  roleIsGovernedExactly,
} from "./provisioner-role.ts";
import { GOVERNED_SETTINGS } from "../store.ts";
import { PROVISIONER_BUDGET, PROVISIONER_POOL } from "../roles.ts";

const BOUNDS = GOVERNED_SETTINGS;
const EXACT = BOUNDS.map(([n, v]) => `${n}=${v}`);

describe("what an interrupted run inherits", () => {
  test("nothing done reads as clean", () => {
    expect(
      classifyPhase({
        roleCanLogin: false,
        roleBackends: 0,
        ownerBoundsExact: true,
      }),
    ).toBe("clean");
  });

  test("a credential with nothing connected reads as credential_set", () => {
    expect(
      classifyPhase({
        roleCanLogin: true,
        roleBackends: 0,
        ownerBoundsExact: true,
      }),
    ).toBe("credential_set");
  });

  // The distinction that matters: a connected backend means the deploy took
  // effect, whatever the interrupted run had reported about itself.
  test("anything connected as the role reads as credential_live", () => {
    expect(
      classifyPhase({
        roleCanLogin: true,
        roleBackends: 1,
        ownerBoundsExact: true,
      }),
    ).toBe("credential_live");
  });

  // Postgres checks LOGIN at connect, so a session can outlive the NOLOGIN that
  // was supposed to end it. That is not a state to reason out of.
  test("a backend under a role that cannot log in is contradictory", () => {
    expect(
      classifyPhase({
        roleCanLogin: false,
        roleBackends: 2,
        ownerBoundsExact: true,
      }),
    ).toBe("contradictory");
  });
});

describe("what each phase's recovery is", () => {
  test("clean needs nothing", () => {
    expect(recoveryFor("clean")).toEqual([]);
  });

  // No deploy has necessarily run, so no deploy is needed - but the staged
  // value is overwritten rather than assumed absent, because an unseen stage is
  // the case being recovered from.
  // ZERO BACKENDS IS NOT EVIDENCE. A deploy can apply the staged DSN and leave
  // the machine stopped, crash-looping or between boots, which reads exactly
  // like a stage that never went live - so both credential phases take the same
  // full path, deploy included. A recovery that skipped it would leave the next
  // machine start pointed at a role it cannot authenticate as.
  test("credential_set takes the SAME full path as credential_live", () => {
    expect(recoveryFor("credential_set")).toEqual(
      recoveryFor("credential_live"),
    );
    expect(recoveryFor("credential_set")).toContain("deploy");
  });

  test("credential_live goes all the way back through a deploy and a probe", () => {
    expect(recoveryFor("credential_live")).toEqual([
      "stage_owner_dsn",
      "deploy",
      "prove_machine_replaced",
      "probe_owner_path",
      "prove_role_backends_zero",
      "disable_role_credential",
    ]);
  });

  test("contradictory stops", () => {
    expect(recoveryFor("contradictory")).toEqual(["stop_and_escalate"]);
  });

  // THE ORDERING RULE, stated as a property over every recovery: the credential
  // is closed last, and never before the deployment has been proved to be off
  // it. Closing it first is how a rollback becomes an outage.
  test("no recovery disables the credential before restoring the owner path", () => {
    for (const phase of ["credential_set", "credential_live"] as const) {
      const steps = recoveryFor(phase);
      const disable = steps.indexOf("disable_role_credential");
      expect(disable).toBe(steps.length - 1);
      expect(steps.indexOf("stage_owner_dsn")).toBeLessThan(disable);
    }
  });

  test("only the live phase proves the backends are gone before closing", () => {
    expect(recoveryFor("credential_live")).toContain(
      "prove_role_backends_zero",
    );
  });

  // A rollback deploy's exit code says flyctl finished, not that the machine
  // running now is the one it deployed - and every reading after it is a
  // statement about that machine.
  test("a rollback proves its own deploy landed, before it probes", () => {
    for (const phase of ["credential_set", "credential_live"] as const) {
      const steps = recoveryFor(phase);
      expect(steps).toContain("prove_machine_replaced");
      expect(steps.indexOf("deploy")).toBeLessThan(
        steps.indexOf("prove_machine_replaced"),
      );
      expect(steps.indexOf("prove_machine_replaced")).toBeLessThan(
        steps.indexOf("probe_owner_path"),
      );
      expect(steps.indexOf("prove_role_backends_zero")).toBeLessThan(
        steps.indexOf("disable_role_credential"),
      );
    }
  });
});

describe("what may start a forward run", () => {
  const ok = {
    branchProved: true,
    ownerDsnReconstructsAndOpens: true,
    ownerBoundsExact: true,
    hostIsPooler: false,
    roleGovernedExactly: true,
    singleStartedMachine: true,
    sourceIsCommitted: true,
    treeIsClean: true,
    phase: "clean" as const,
  };

  test("everything proved, and a clean phase", () => {
    expect(mayGoForward(ok)).toBe(true);
  });

  test("each precondition can refuse on its own", () => {
    expect(mayGoForward({ ...ok, branchProved: false })).toBe(false);
    expect(mayGoForward({ ...ok, ownerDsnReconstructsAndOpens: false })).toBe(
      false,
    );
    expect(mayGoForward({ ...ok, roleGovernedExactly: false })).toBe(false);
    expect(mayGoForward({ ...ok, ownerBoundsExact: false })).toBe(false);
    // A deploy ships the working DIRECTORY, so an uncommitted tree would put
    // source on a machine nobody can reconstruct from git.
    expect(mayGoForward({ ...ok, sourceIsCommitted: false })).toBe(false);
    expect(mayGoForward({ ...ok, treeIsClean: false })).toBe(false);
    // The provisioner is DIRECT. A pooled host is not a preference here: the
    // machine is one always-on process and the pooler's server backends would
    // sit inside its budget for nothing.
    expect(mayGoForward({ ...ok, hostIsPooler: true })).toBe(false);
    // The overlap arithmetic is one pool replacing one pool. Two machines
    // already running would make a replacement three pools - fifteen requested
    // against a cap of twelve.
    expect(mayGoForward({ ...ok, singleStartedMachine: false })).toBe(false);
  });

  test("a run that inherited any other phase does not go forward", () => {
    for (const phase of [
      "credential_set",
      "credential_live",
      "contradictory",
    ] as const) {
      expect(mayGoForward({ ...ok, phase })).toBe(false);
    }
  });
});

describe("the role has to be what G2 approved", () => {
  test("the exact budget and the exact bounds pass", () => {
    expect(
      roleIsGovernedExactly({
        connectionLimit: PROVISIONER_BUDGET,
        config: EXACT,
        bounds: BOUNDS,
      }),
    ).toBe(true);
  });

  // A drifted cap is a different aggregate from the one that was approved, so a
  // credential against it deploys a posture nobody agreed to.
  test("a drifted cap or a stale setting refuses", () => {
    expect(
      roleIsGovernedExactly({
        connectionLimit: 99,
        config: EXACT,
        bounds: BOUNDS,
      }),
    ).toBe(false);
    expect(
      roleIsGovernedExactly({
        connectionLimit: PROVISIONER_BUDGET,
        config: [...EXACT, "lock_timeout=5s"],
        bounds: BOUNDS,
      }),
    ).toBe(false);
  });
});

describe("the credential statements", () => {
  test("the generated value is hex, and long", () => {
    const value = generatedPassword();
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(generatedPassword()).not.toBe(value);
  });

  test("the open statement takes only what this program generates", () => {
    expect(openCredentialSql(generatedPassword())).toContain(
      "with login password",
    );
    expect(() => openCredentialSql("not-hex'; drop role cp_web --")).toThrow();
    expect(() => openCredentialSql("")).toThrow();
  });

  // NOLOGIN alone would leave a password nobody is watching.
  test("the close statement nulls the password as well as the login", () => {
    expect(closeCredentialSql()).toContain("nologin");
    expect(closeCredentialSql()).toContain("password null");
  });
});

describe("the two configuration facts the overlap arithmetic rests on", () => {
  const flyToml = fs.readFileSync(
    path.join(import.meta.dir, "fly.toml"),
    "utf8",
  );

  // A bluegreen or canary strategy stands a SECOND machine up beside the first,
  // which would put four process pools against a budget sized for two.
  test("fly.toml names no strategy that doubles the machines", () => {
    expect(flyToml).not.toContain("bluegreen");
    expect(flyToml).not.toContain("canary");
    expect(flyToml).not.toMatch(/strategy\s*=/);
  });

  test("the deploy argv keeps it to one machine", () => {
    expect(DEPLOY_ARGV).toContain("--ha=false");
    expect(DEPLOY_ARGV).toContain("-a");
    expect(DEPLOY_ARGV).toContain("isomux-provisioner");
  });

  // The number the budget is sized against: two overlapping process pools.
  test("two provisioner pools fit inside the role's engine cap", () => {
    expect(PROVISIONER_POOL.max * 2).toBeLessThan(PROVISIONER_BUDGET);
  });

  // And the deployed caller must actually ASK for that pool. A budget sized
  // against a cap the process does not use is arithmetic about nothing.
  test("the deployed command passes the provisioner pool to the runtime open", () => {
    const cli = fs.readFileSync(
      path.join(import.meta.dir, "..", "cli.ts"),
      "utf8",
    );
    expect(cli).toContain("Store.openRuntime(");
    expect(cli).toContain("PROVISIONER_POOL");
    // The tick loop is the one command the machine runs, and it is the one that
    // must take the runtime path.
    expect(cli).toMatch(/cmdRun[\s\S]{0,400}openStoreForRuntime\(\)/);
  });
});
