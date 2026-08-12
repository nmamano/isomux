// The coordinator, driven through every state a live run can reach.
//
// Provider EFFECTS cannot run here; orchestration can, and that is the half
// where a mistake strands a machine. So every seam is a fake that records what
// it was asked to do, and the cases below are the ones an operator would
// otherwise discover: a process that dies after the credential exists, a deploy
// that throws, a probe that fails, backends that will not reach zero.
//
// The property running through all of it: A CREDENTIAL THAT EXISTS IS NEVER
// DISABLED UNTIL THE DEPLOYMENT IS PROVED TO BE OFF IT.

import { describe, expect, test } from "bun:test";
import {
  type DeployResult,
  type Seams,
  moveProvisioner,
} from "./provisioner-move.ts";
import { DEPLOY_ARGV } from "./provisioner-role.ts";

interface Recorder {
  seams: Seams;
  lines: string[];
  sql: string[];
  staged: string[];
  openedDsns: string[];
  /** "start" before the sampled action ran and "end" after, so a test can show
   * the deploy happened INSIDE the sampling rather than beside it. */
  sampledAround: string[];
  deploys: number;
  /** How many times the baseline was captured - once per deploy, forward or
   * rollback, and never without one. */
  prepares: number;
  ownerDsn: string;
}

function rig(
  over: Partial<{
    sha: string | null;
    clean: boolean;
    canLogin: boolean;
    /** Backends BEFORE the run - what a resumed run inherits. */
    backends: number;
    /** What a successful FORWARD deploy leaves connected. */
    afterDeploy: number;
    /** The series the ROLLBACK watches before it may close a credential. */
    rollbackSamples: number[];
    /** How many of the forward series were taken while the deploy was pending. */
    during: number;
    ownerBoundsExact: boolean;
    branchProved: boolean;
    branchRejects: boolean;
    /** Reject only from this call onward, so the forward preflight can succeed
     * and the recovery's own read can fail - the only way to reach the
     * recovery preflight's catch. */
    branchRejectsFromCall: number;
    roleGoverned: boolean;
    roleGovernedRejects: boolean;
    ownerOpens: boolean;
    opensRejects: boolean;
    singleStartedMachine: boolean;
    topologyRejects: boolean;
    /** The mutation-boundary topology read + baseline capture, apart from the
     * deploy itself. */
    prepared: boolean;
    prepareRejects: boolean;
    roleDsnThrows: boolean;
    hostIsPooler: boolean;
    stageOk: boolean;
    stageThrows: boolean;
    valueEchoed: boolean;
    deploy: DeployResult;
    deployRejects: boolean;
    probeRejects: boolean;
    namesRejects: boolean;
    replacedRejects: boolean;
    factsRejects: boolean;
    /** Reject the phase-defining read from the very first call, which is the
     * case where nobody can say whether a credential exists. */
    factsRejectsAlways: boolean;
    openThrows: boolean;
    resolveThrows: boolean;
    samplesThrow: boolean;
    samples: number[];
    namesPresent: boolean;
    probe: boolean;
    replaced: boolean;
  }> = {},
): Recorder {
  const o = {
    sha: "84ceb3254dcbdfc2c65071ad071f130b0bfcc082",
    clean: true,
    canLogin: false,
    backends: 0,
    afterDeploy: 3,
    ownerBoundsExact: true,
    branchProved: true,
    branchRejects: false,
    branchRejectsFromCall: 0,
    roleGoverned: true,
    roleGovernedRejects: false,
    ownerOpens: true,
    opensRejects: false,
    singleStartedMachine: true,
    topologyRejects: false,
    prepared: true,
    prepareRejects: false,
    roleDsnThrows: false,
    hostIsPooler: false,
    stageOk: true,
    stageThrows: false,
    valueEchoed: false,
    deploy: { exitCode: 0, threw: false } as DeployResult,
    deployRejects: false,
    probeRejects: false,
    namesRejects: false,
    replacedRejects: false,
    factsRejects: false,
    factsRejectsAlways: false,
    openThrows: false,
    resolveThrows: false,
    samplesThrow: false,
    namesPresent: true,
    probe: true,
    replaced: true,
    ...over,
  };
  const lines: string[] = [];
  const sql: string[] = [];
  const staged: string[] = [];
  const openedDsns: string[] = [];
  const sampledAround: string[] = [];
  let deploys = 0;
  let prepares = 0;
  let branchCalls = 0;
  let canLogin = o.canLogin;
  let backends = o.backends;
  const ownerDsn = "postgres://owner:pw@direct.example/db";
  const seams: Seams = {
    source: {
      committedSha: async () => o.sha,
      treeIsClean: async () => o.clean,
    },
    db: {
      facts: async () => {
        if (o.factsRejectsAlways) throw new Error("catalog unreadable");
        // Only AFTER the credential exists: the point of the case is a world
        // that becomes unreadable mid-move, not one that never opened.
        if (
          o.factsRejects &&
          sql.some((x) => x.includes("with login password"))
        ) {
          throw new Error("catalog unreadable");
        }
        return {
          roleCanLogin: canLogin,
          roleBackends: backends,
          ownerBoundsExact: o.ownerBoundsExact,
        };
      },
      branchProved: async () => {
        branchCalls++;
        if (o.branchRejects) throw new Error("the branch query blew up");
        if (
          o.branchRejectsFromCall > 0 &&
          branchCalls >= o.branchRejectsFromCall
        ) {
          throw new Error("the branch query blew up");
        }
        return o.branchProved;
      },
      roleGovernedExactly: async () => {
        if (o.roleGovernedRejects) throw new Error("the catalog read blew up");
        return o.roleGoverned;
      },
      opens: async (dsn) => {
        if (o.opensRejects) throw new Error("the open blew up");
        openedDsns.push(dsn);
        return o.ownerOpens;
      },
      run: async (statement) => {
        if (o.openThrows && statement.includes("with login password")) {
          // The ambiguous case: the server may have applied it anyway.
          sql.push(statement);
          canLogin = true;
          throw new Error("connection died after the statement");
        }
        sql.push(statement);
        if (statement.includes("with login password")) canLogin = true;
        if (statement.includes("nologin")) canLogin = false;
      },
      backendSamples: async () => {
        if (o.samplesThrow) throw new Error("catalog unreadable");
        return o.rollbackSamples ?? [backends];
      },
      // The real adapter samples WHILE the action runs; the fake records that
      // the action was invoked from inside it, which is the property the
      // coordinator depends on, and returns the series the case asked for.
      sampleAcross: async (action) => {
        if (o.samplesThrow) throw new Error("catalog unreadable");
        sampledAround.push("start");
        const value = await action();
        sampledAround.push("end");
        const samples = o.samples ?? [backends];
        return { value, samples, during: o.during ?? 1 };
      },
    },
    api: {
      resolve: async () => {
        if (o.resolveThrows) throw new Error("api unreachable");
        return {
          hostIsPooler: o.hostIsPooler,
          ownerDsn,
          roleDsnFor: (password: string) => {
            if (o.roleDsnThrows) {
              throw new Error("the role connection string could not be built");
            }
            return `postgres://cp_provisioner:${password}@direct.example/db`;
          },
        };
      },
    },
    fly: {
      stage: async (value) => {
        if (o.stageThrows) throw new Error("flyctl died");
        staged.push(value);
        return { ok: o.stageOk, valueEchoed: o.valueEchoed };
      },
      deploy: async (argv) => {
        deploys++;
        if (o.deployRejects && deploys === 1) throw new Error("flyctl died");
        expect(argv).toEqual(DEPLOY_ARGV);
        // WHICH deploy this is, told apart the way the world would tell them
        // apart: a rollback deploy is the one that follows the owner DSN being
        // staged. A forward deploy puts the machine on the new role; a rollback
        // one takes it off.
        const rollback = staged[staged.length - 1] === ownerDsn;
        if (rollback) {
          backends = 0;
          return { exitCode: 0, threw: false };
        }
        if (o.deploy.exitCode === 0 && !o.deploy.threw)
          backends = o.afterDeploy;
        return o.deploy;
      },
      secretNamesPresent: async () => {
        if (o.namesRejects) throw new Error("flyctl died");
        return o.namesPresent;
      },
      machineReplaced: async () => {
        if (o.replacedRejects) throw new Error("flyctl died");
        return o.replaced;
      },
      singleStartedMachine: async () => {
        if (o.topologyRejects) throw new Error("flyctl died");
        return o.singleStartedMachine;
      },
      prepareDeploy: async () => {
        if (o.prepareRejects) throw new Error("flyctl died");
        prepares++;
        return o.prepared;
      },
    },
    probe: async () => {
      if (o.probeRejects) throw new Error("probe blew up");
      return o.probe;
    },
    report: (line) => lines.push(line),
  };
  return {
    seams,
    lines,
    sql,
    staged,
    openedDsns,
    sampledAround,
    get deploys() {
      return deploys;
    },
    get prepares() {
      return prepares;
    },
    ownerDsn,
  };
}

const disabled = (r: Recorder): boolean =>
  r.sql.some((s) => s.includes("nologin"));
const opened = (r: Recorder): boolean =>
  r.sql.some((s) => s.includes("with login password"));

describe("what refuses before a credential exists", () => {
  test("an unreadable commit or a dirty tree refuses", async () => {
    for (const over of [{ sha: null }, { clean: false }]) {
      const r = rig(over);
      expect(await moveProvisioner(r.seams)).toBe("refused_precondition");
      expect(opened(r)).toBe(false);
      expect(r.staged).toEqual([]);
      expect(r.deploys).toBe(0);
    }
  });

  test("each database and endpoint precondition refuses on its own", async () => {
    for (const over of [
      { branchProved: false },
      { roleGoverned: false },
      { ownerOpens: false },
      { hostIsPooler: true },
      { ownerBoundsExact: false },
    ]) {
      const r = rig(over);
      expect(await moveProvisioner(r.seams)).toBe("refused_precondition");
      expect(opened(r)).toBe(false);
    }
  });

  // The owner's bounds are required BEFORE the forward run, not only before a
  // rollback: the rollback is the only way back, and it deploys an owner DSN
  // that the committed runtime would refuse to open if they had drifted.
  test("drifted owner bounds refuse before anything is generated", async () => {
    const r = rig({ ownerBoundsExact: false });
    expect(await moveProvisioner(r.seams)).toBe("refused_precondition");
    expect(r.lines).toContain("ownerBoundsExact: false");
  });
});

describe("a run that inherits a credential", () => {
  // THE CASE THAT WAS WRONG. A deploy can apply the staged DSN and leave the
  // machine stopped, crash-looping or between boots - LOGIN true with zero
  // backends, which looks exactly like a stage that never went live. The
  // recovery must still DEPLOY the owner DSN, or the next machine start reads a
  // role it cannot authenticate as.
  test("LOGIN with zero backends still deploys the owner DSN before disabling", async () => {
    const r = rig({ canLogin: true, backends: 0 });
    expect(await moveProvisioner(r.seams)).toBe("rolled_back");
    expect(r.staged).toEqual([r.ownerDsn]);
    expect(r.deploys).toBe(1);
    expect(disabled(r)).toBe(true);
    // And in that order: the credential goes last.
    expect(r.lines.indexOf("credential_disabled: true")).toBeGreaterThan(
      r.lines.indexOf("owner_path_probe: true"),
    );
  });

  test("LOGIN with live backends takes the same path", async () => {
    const r = rig({ canLogin: true, backends: 2 });
    expect(await moveProvisioner(r.seams)).toBe("rolled_back");
    expect(r.deploys).toBe(1);
    expect(disabled(r)).toBe(true);
  });

  test("a session under a role that cannot log in escalates and touches nothing", async () => {
    const r = rig({ canLogin: false, backends: 2 });
    expect(await moveProvisioner(r.seams)).toBe("escalate");
    expect(r.staged).toEqual([]);
    expect(r.deploys).toBe(0);
    expect(disabled(r)).toBe(false);
  });

  test("drifted owner bounds stop a recovery rather than deploying into them", async () => {
    const r = rig({ canLogin: true, backends: 1, ownerBoundsExact: false });
    expect(await moveProvisioner(r.seams)).toBe("escalate");
    expect(r.deploys).toBe(0);
    expect(disabled(r)).toBe(false);
  });
});

describe("every failure after the credential exists recovers", () => {
  const cases: [string, Parameters<typeof rig>[0]][] = [
    ["the stage throws", { stageThrows: true }],
    ["the stage fails", { stageOk: false }],
    ["flyctl echoed the value", { valueEchoed: true }],
    ["the deploy returns non-zero", { deploy: { exitCode: 1, threw: false } }],
    [
      "the deploy throws or times out",
      { deploy: { exitCode: null, threw: true } },
    ],
    ["the probe is not green", { probe: false }],
    ["the secret names are not all present", { namesPresent: false }],
    ["fly cannot show the machine was replaced", { replaced: false }],
  ];

  for (const [name, over] of cases) {
    test(`${name} -> recovery, and the credential is closed last`, async () => {
      const r = rig({ ...over });
      const outcome = await moveProvisioner(r.seams);
      expect(["rolled_back", "escalate"]).toContain(outcome);
      expect(opened(r)).toBe(true);
      if (outcome === "rolled_back") {
        expect(disabled(r)).toBe(true);
        expect(r.staged[r.staged.length - 1]).toBe(r.ownerDsn);
      }
    });
  }

  // A deploy's exit code is not evidence about what changed, so the rollback
  // arm runs after the deploy was INVOKED even when it reported failure.
  test("a failed deploy is still treated as possibly live", async () => {
    const r = rig({ deploy: { exitCode: 1, threw: false } });
    await moveProvisioner(r.seams);
    expect(r.staged[r.staged.length - 1]).toBe(r.ownerDsn);
    expect(r.deploys).toBeGreaterThan(1);
  });
});

describe("a rollback that cannot finish leaves the credential enabled", () => {
  test("backends that will not reach zero escalate WITHOUT disabling", async () => {
    const r = rig({ canLogin: true, backends: 4, rollbackSamples: [4, 4] });
    expect(await moveProvisioner(r.seams)).toBe("escalate");
    expect(disabled(r)).toBe(false);
  });

  // ONE ZERO IS NOT PROOF. A machine still configured for the role reads zero
  // between two opens, through a restart and while it crash-loops, so the
  // series has to be zero all the way through before a credential is closed.
  test("a series that dips back above zero escalates without disabling", async () => {
    for (const rollbackSamples of [[0, 1, 0], [0, 0, 2], [1, 0, 0], []]) {
      const r = rig({ canLogin: true, backends: 1, rollbackSamples });
      expect(await moveProvisioner(r.seams)).toBe("escalate");
      expect(disabled(r)).toBe(false);
      expect(r.lines).toContain("rollback_backends_all_zero: false");
    }
  });

  test("an all-zero series closes the credential", async () => {
    const r = rig({ canLogin: true, backends: 1, rollbackSamples: [0, 0, 0] });
    expect(await moveProvisioner(r.seams)).toBe("rolled_back");
    expect(disabled(r)).toBe(true);
  });

  // The rollback deploy's exit code says flyctl finished, not that the machine
  // running now is the one it deployed.
  test("a rollback deploy that cannot be shown to have landed escalates", async () => {
    const r = rig({ canLogin: true, backends: 1, replaced: false });
    expect(await moveProvisioner(r.seams)).toBe("escalate");
    expect(r.lines).toContain("rollback_machine_replaced: false");
    expect(disabled(r)).toBe(false);
    // And it stopped there: no probe, no closing statement.
    expect(r.lines).not.toContain("owner_path_probe: true");
  });

  test("an unreadable machine state after a rollback deploy escalates", async () => {
    const r = rig({ canLogin: true, backends: 1, replacedRejects: true });
    expect(await moveProvisioner(r.seams)).toBe("escalate");
    expect(disabled(r)).toBe(false);
  });

  test("a failed rollback probe escalates without disabling", async () => {
    const r = rig({ canLogin: true, backends: 1, probe: false });
    expect(await moveProvisioner(r.seams)).toBe("escalate");
    expect(disabled(r)).toBe(false);
  });
});

describe("a real rejection after the credential exists is not a different failure", () => {
  // The tests used to model a "throw" as a RETURNED flag, which proves nothing
  // about a rejected promise. These reject for real: flyctl dying, a probe
  // blowing up, a catalog read failing. Every one must drop the free text,
  // re-read the world and recover - not escape.
  const rejections: [string, Parameters<typeof rig>[0]][] = [
    ["the deploy call rejects", { deployRejects: true }],
    ["the probe rejects", { probeRejects: true }],
    ["the secret-name read rejects", { namesRejects: true }],
    ["the machine-state read rejects", { replacedRejects: true }],
    ["the backend sampling rejects", { samplesThrow: true }],
  ];

  for (const [name, over] of rejections) {
    test(`${name} -> recovery, never an escaped exception`, async () => {
      const r = rig(over);
      const outcome = await moveProvisioner(r.seams);
      expect(["rolled_back", "escalate"]).toContain(outcome);
      expect(opened(r)).toBe(true);
      // The child's error text never reaches the transcript.
      for (const line of r.lines) expect(line).not.toContain("flyctl died");
    });
  }

  // ALTER ROLE can commit and the client still see a failure, so a throw at P1
  // is ambiguous rather than a refusal: the recovery re-reads whether the
  // credential exists.
  test("an ambiguous P1 goes to recovery, not to a refusal", async () => {
    const r = rig({ openThrows: true });
    const outcome = await moveProvisioner(r.seams);
    expect(outcome).not.toBe("refused_precondition");
    expect(r.lines).toContain("open_credential_threw: true");
  });

  // If the world cannot be read, nothing about it may be asserted - including
  // that a rollback happened.
  test("a world that cannot be read at all refuses before writing anything", async () => {
    const r = rig({ resolveThrows: true });
    expect(await moveProvisioner(r.seams)).toBe("refused_precondition");
    expect(r.lines).toContain("preflight_unreadable: true");
    expect(opened(r)).toBe(false);
    expect(r.staged).toEqual([]);
  });

  test("a world that cannot be re-read escalates with a fixed line", async () => {
    const r = rig({ deployRejects: true, factsRejects: true });
    expect(await moveProvisioner(r.seams)).toBe("escalate");
    expect(r.lines).toContain("recovery_state_unreadable: true");
    expect(disabled(r)).toBe(false);
  });
});

describe("a recovery has its own preflight, because it writes too", () => {
  // An inherited credential used to reach the rollback deploy on the strength
  // of the owner's BOUNDS alone - so an owner DSN already proved unusable, an
  // unproved branch or a dirty tree would still have been staged and deployed.
  const cases: [string, Parameters<typeof rig>[0]][] = [
    ["the owner DSN does not open", { ownerOpens: false }],
    ["the branch is not proved", { branchProved: false }],
    ["the source is not a readable commit", { sha: null }],
    ["the runtime tree is dirty", { clean: false }],
    ["the host is pooled", { hostIsPooler: true }],
  ];

  for (const [name, over] of cases) {
    test(`${name} -> no fly write, credential left enabled`, async () => {
      const r = rig({ ...over, canLogin: true, backends: 1 });
      expect(await moveProvisioner(r.seams)).toBe("escalate");
      expect(r.staged).toEqual([]);
      expect(r.deploys).toBe(0);
      expect(disabled(r)).toBe(false);
    });
  }

  // The proof has to be about the value that gets used.
  test("the DSN proved to open is the DSN staged", async () => {
    const r = rig({ canLogin: true, backends: 1 });
    await moveProvisioner(r.seams);
    expect(r.openedDsns).toContain(r.ownerDsn);
    expect(r.staged).toEqual([r.ownerDsn]);
  });

  // Ruling 8 applies to the rollback: a child that repeated the value has put a
  // DSN somewhere this program does not control.
  test("an echoed owner DSN stops the rollback with the credential enabled", async () => {
    const r = rig({ canLogin: true, backends: 1, valueEchoed: true });
    expect(await moveProvisioner(r.seams)).toBe("escalate");
    expect(r.deploys).toBe(0);
    expect(disabled(r)).toBe(false);
  });
});

describe("a preflight read that REJECTS, before and after a credential exists", () => {
  // The tests used to cover false answers only. A rejected promise is a
  // different code path: it used to leave the coordinator entirely, which in a
  // clean world is an exception instead of a refusal, and with an inherited
  // credential is an exception instead of an escalation - with nothing said
  // about the credential that exists.
  const reads: [string, Parameters<typeof rig>[0]][] = [
    ["the branch query rejects", { branchRejects: true }],
    ["the owner-DSN open rejects", { opensRejects: true }],
    ["the catalog read rejects", { roleGovernedRejects: true }],
    ["the machine listing rejects", { topologyRejects: true }],
  ];

  for (const [name, over] of reads) {
    test(`${name} -> refusal in a clean world, nothing written`, async () => {
      const r = rig(over);
      expect(await moveProvisioner(r.seams)).toBe("refused_precondition");
      expect(r.lines).toContain("preflight_unreadable: true");
      expect(opened(r)).toBe(false);
      expect(r.staged).toEqual([]);
      expect(r.deploys).toBe(0);
    });

    test(`${name} -> escalation with an inherited credential, no fly write`, async () => {
      const r = rig({ ...over, canLogin: true, backends: 1 });
      expect(await moveProvisioner(r.seams)).toBe("escalate");
      expect(r.lines).toContain("inherited_credential_unreadable_world: true");
      expect(r.staged).toEqual([]);
      expect(r.deploys).toBe(0);
      expect(disabled(r)).toBe(false);
    });
  }

  // A rollback writes too, so its own preflight has to survive a rejection the
  // same way - and leave the credential alone.
  test("a recovery precondition that rejects escalates without writing", async () => {
    // The world holds together for the forward preflight and comes apart when
    // the recovery asks its own questions - the only path that reaches the
    // recovery preflight's catch.
    const r = rig({ canLogin: true, backends: 1, branchRejectsFromCall: 2 });
    expect(await moveProvisioner(r.seams)).toBe("escalate");
    expect(r.lines).toContain("recovery_preconditions_unreadable: true");
    expect(r.staged).toEqual([]);
    expect(r.deploys).toBe(0);
    expect(disabled(r)).toBe(false);
  });
});

describe("the phase-defining read is never a refusal", () => {
  // It is the only fact that can tell a fresh G2 state from an interrupted G3
  // one. "Refused, nothing was written" would be a claim about exactly the
  // thing the run failed to read; a person has to look instead.
  test("a catalog read that cannot say whether a credential exists escalates", async () => {
    const r = rig({ factsRejectsAlways: true });
    expect(await moveProvisioner(r.seams)).toBe("escalate");
    expect(r.lines).toContain("credential_state_unknown: true");
    expect(r.sql).toEqual([]);
    expect(r.staged).toEqual([]);
    expect(r.deploys).toBe(0);
  });

  test("a later read that fails after the facts proved clean is still a refusal", async () => {
    const r = rig({ branchRejects: true });
    expect(await moveProvisioner(r.seams)).toBe("refused_precondition");
    expect(r.lines).toContain("preflight_unreadable: true");
    expect(r.lines).not.toContain("credential_state_unknown: true");
  });
});

describe("a rollback deploy needs the same ground the forward one needs", () => {
  test("it captures a baseline of its own before deploying", async () => {
    const r = rig({ canLogin: true, backends: 1 });
    expect(await moveProvisioner(r.seams)).toBe("rolled_back");
    expect(r.prepares).toBe(1);
    expect(r.deploys).toBe(1);
    expect(r.lines).toContain("rollback_deploy_baseline: true");
  });

  test("a baseline it cannot capture escalates without deploying", async () => {
    const r = rig({ canLogin: true, backends: 1, prepared: false });
    expect(await moveProvisioner(r.seams)).toBe("escalate");
    expect(r.deploys).toBe(0);
    expect(r.lines).toContain("rollback_deploy_baseline: false");
    expect(disabled(r)).toBe(false);
  });
});

describe("no credential value exists until the run may go forward", () => {
  test("a refused clean run generates no password", async () => {
    const r = rig({ branchProved: false });
    expect(await moveProvisioner(r.seams)).toBe("refused_precondition");
    expect(r.sql).toEqual([]);
  });

  // The role string used to be built before the phase was known, on a path
  // where a throw from it escaped before the recovery could run.
  test("an inherited credential recovers without building a role string", async () => {
    const r = rig({ canLogin: true, backends: 1, roleDsnThrows: true });
    expect(await moveProvisioner(r.seams)).toBe("rolled_back");
    expect(r.staged).toEqual([r.ownerDsn]);
    expect(disabled(r)).toBe(true);
  });

  test("a role string that cannot be built refuses before P1", async () => {
    const r = rig({ roleDsnThrows: true });
    expect(await moveProvisioner(r.seams)).toBe("refused_precondition");
    expect(r.lines).toContain("role_dsn_buildable: false");
    expect(opened(r)).toBe(false);
  });
});

describe("the machine topology, before anything is written", () => {
  test("anything but one started machine refuses, with no credential", async () => {
    const r = rig({ singleStartedMachine: false });
    expect(await moveProvisioner(r.seams)).toBe("refused_precondition");
    expect(r.lines).toContain("singleStartedMachine: false");
    expect(opened(r)).toBe(false);
    expect(r.staged).toEqual([]);
    expect(r.deploys).toBe(0);
  });
});

describe("the sampled backend series", () => {
  // The overlap the budget was sized against only exists while the deploy is in
  // flight, so the deploy has to happen INSIDE the sampling.
  test("the deploy runs inside the sampling", async () => {
    const r = rig({ afterDeploy: 3, samples: [4, 5, 3] });
    expect(await moveProvisioner(r.seams)).toBe("moved");
    expect(r.sampledAround).toEqual(["start", "end"]);
    expect(r.lines).toContain("overlap_observed: true");
    // One baseline, captured outside the sampled window and before the deploy.
    expect(r.prepares).toBe(1);
    expect(r.lines).toContain("deploy_baseline_captured: true");
  });

  test("a series with nothing taken during the deploy is not a success", async () => {
    const r = rig({ afterDeploy: 3, samples: [3, 3], during: 0 });
    expect(await moveProvisioner(r.seams)).not.toBe("moved");
    expect(r.lines).toContain("overlap_observed: false");
  });

  test("an empty series is not a success, and does not claim to be", async () => {
    const r = rig({ afterDeploy: 3, samples: [] });
    expect(await moveProvisioner(r.seams)).not.toBe("moved");
    // "every one of no readings was inside the cap" is true and useless; the
    // transcript must not carry it.
    expect(r.lines).toContain("every_sample_inside_cap: false");
  });
});

describe("the sampled backend series, judged", () => {
  test("a transient sample above the cap is not a success", async () => {
    const r = rig({ samples: [3, 13, 4], afterDeploy: 4 });
    expect(await moveProvisioner(r.seams)).not.toBe("moved");
  });

  test("a series that never settles inside the band is not a success", async () => {
    const r = rig({ samples: [8, 9, 8], afterDeploy: 8 });
    expect(await moveProvisioner(r.seams)).not.toBe("moved");
  });

  test("a series that settles inside the band passes", async () => {
    const r = rig({ samples: [7, 5, 3], afterDeploy: 3 });
    expect(await moveProvisioner(r.seams)).toBe("moved");
    expect(r.lines).toContain("every_sample_inside_cap: true");
    expect(r.lines).toContain("settled_backends: 3");
  });
});

describe("a successful move", () => {
  test("reports acceptance, one deploy, and steady backends", async () => {
    const r = rig({ afterDeploy: 3 });
    expect(await moveProvisioner(r.seams)).toBe("moved");
    expect(r.deploys).toBe(1);
    expect(r.lines).toContain("acceptance: true");
    expect(r.lines).toContain("settled_backends_steady: true");
    expect(r.lines).toContain("every_sample_inside_cap: true");
    expect(disabled(r)).toBe(false);
  });

  test("a backend count outside the steady band is not a success", async () => {
    const r = rig({ afterDeploy: 9 });
    expect(await moveProvisioner(r.seams)).not.toBe("moved");
  });

  test("the password reaches the statement and the stage, and nothing else", async () => {
    const r = rig({ afterDeploy: 3 });
    await moveProvisioner(r.seams);
    const statement = r.sql.find((s) => s.includes("with login password"))!;
    const password = statement.match(/'([0-9a-f]+)'/)![1];
    expect(r.staged.some((v) => v.includes(password))).toBe(true);
    // Not in a single reported line - not the DSN, not the statement, nothing.
    for (const line of r.lines) expect(line).not.toContain(password);
  });

  test("there is no second forward attempt", async () => {
    const r = rig({ afterDeploy: 3 });
    await moveProvisioner(r.seams);
    expect(r.deploys).toBe(1);
  });
});
