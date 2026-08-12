// The adapters, driven the way a live run would drive them, with no provider.
//
// `provisioner-move.test.ts` proves the ORCHESTRATION - what a run does after a
// deploy throws, which step disables the credential, what a resumed run
// inherits. None of that says a word about what the seams actually do, and the
// seams are where a live run meets flyctl's argv, the driver's error text and
// the probe's verdict. So each adapter is exercised here against fake
// primitives: the exact command line, the exact bytes on a child's stdin, what
// happens to a rejected promise, and what is left on the transcript.
//
// THE PROPERTIES THAT DO NOT SHOW UP IN THE ORCHESTRATION TESTS:
//   - the source checks ask about the paths THE IMAGE CARRIES, so an untracked
//     file under the copied tree blocks a deploy and a change under
//     control-plane/web does not;
//   - one Neon resolution supplies every string, and the role's differs from
//     the owner's in its credentials alone;
//   - a driver error crossing the database seam is redacted, not reported;
//   - the stage sets ONE name, over stdin, staged;
//   - the deploy runs exactly `DEPLOY_ARGV`, once, and turns a dead child into
//     the coordinator's ambiguity rather than an exception;
//   - the probe reads the verdict LINE, so an exit-zero `accepted: false` fails;
//   - replacement evidence comes from fly's own state;
//   - and only `moved` exits zero.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROVISIONER_ROLE, PROVISIONER_BUDGET } from "../roles.ts";
import { GOVERNED_SETTINGS } from "../store.ts";
import type { Target } from "../exercises/neon-api.ts";
import {
  APP,
  type BoundedResult,
  FLYCTL,
  classifyGroupProbe,
  realBoundedSpawn,
  streamSink,
} from "./fly-cli.ts";
import { DEPLOY_ARGV } from "./provisioner-role.ts";
import { SECRET_NAMES } from "./secrets.ts";
import { type Seams, moveProvisioner } from "./provisioner-move.ts";
import { contextRules } from "./build-context.ts";
import {
  BACKEND_SAMPLES,
  BACKEND_SAMPLE_GAP_MS,
  CONTEXT_RULES_PATH,
  IMAGE_PATHSPEC,
  DEPLOY_DEADLINE_MS,
  LIGHT_DEADLINE_MS,
  PROBE_SCRIPT,
  machineStateExitCode,
  SAMPLES_DURING_CAP,
  type Primitives,
  exitCodeFor,
  generationOf,
  readMachineListing,
  realSeams,
  roleDsnFrom,
} from "./provisioner-move-run.ts";

const HOST = "ep-plain-sun-123.eu-central-1.aws.neon.tech";
const OWNER_ROLE = "neondb_owner";
const OWNER_PASSWORD = "npg_ownerpassword";
const OWNER_DSN = `postgresql://${OWNER_ROLE}:${OWNER_PASSWORD}@${HOST}/neondb?sslmode=verify-full`;
const BRANCH_ID = "br-still-water-42";
const SHA = "84ceb3254dcbdfc2c65071ad071f130b0bfcc082";
const REPO = "/repo";

const GOVERNED_CONFIG = GOVERNED_SETTINGS.map(([n, v]) => `${n}=${v}`);

function target(dsn: string): Target {
  return {
    dsn,
    branch: {
      id: BRANCH_ID,
      name: "production",
      isDefault: true,
      hasParent: false,
    },
    projectId: "prj-1",
    hostFromApi: true,
  };
}

const machine = (over: Record<string, unknown> = {}) => ({
  id: "080e977db16d18",
  state: "started",
  instance_id: "01JINSTANCEA",
  image_ref: { digest: "sha256:aaaa" },
  ...over,
});

const listing = (...rows: Record<string, unknown>[]) => JSON.stringify(rows);

interface Options {
  dsn: string;
  cwd: string;
  gitTop: { code: number; stdout: string };
  gitHead: { code: number; stdout: string };
  status: { code: number; stdout: string };
  lsTree: { code: number; stdout: string };
  /** An error factory, so every call throws a fresh one the way a driver does. */
  sqlThrows: (() => unknown) | null;
  canLogin: boolean;
  /** The count BEFORE any deploy. Non-zero with `canLogin: false` is the
   * contradictory phase, which escalates at the preflight - so a run meant to
   * reach P2 and beyond starts at zero and moves after the deploy. */
  backends: number;
  backendsAfterDeploy: number;
  badCount: boolean;
  roleMissing: boolean;
  roleLimit: number;
  roleConfig: string[];
  ownerConfig: string[];
  liveBranch: string | null;
  machinesBefore: string;
  machinesAfter: string;
  machinesCode: number;
  machinesThrows: boolean;
  deployCode: number;
  deployThrows: boolean;
  stageCode: number;
  stageEcho: boolean;
  secretsListCode: number;
  secretsList: string;
  probeCode: number;
  probeStdout: string;
  probeThrows: boolean;
  resolveCalls: { n: number };
  /** The deploy child's answer, and how long the test makes it take. */
  deployTimesOut: boolean;
  deployGroupSurvived: boolean;
  deployBlocks: (() => Promise<void>) | null;
  /** Which children hit their deadline: "machines", "stage", "names", "probe". */
  timeouts: string[];
}

interface Rig {
  seams: Seams;
  p: Primitives;
  lines: string[];
  spawns: { argv: string[]; env: Record<string, string>; stdin: string }[];
  gits: string[][];
  sqls: { dsn: string; statement: string; args?: unknown[] }[];
  sleeps: number[];
  resolves: () => number;
  /** Everything that happened, in order: which child ran and when each backend
   * reading was taken. The only way to say a sample fell inside the deploy. */
  events: string[];
  bounded: { argv: string[]; deadlineMs: number }[];
}

function rig(over: Partial<Options> = {}): Rig {
  const o: Options = {
    dsn: OWNER_DSN,
    cwd: REPO,
    gitTop: { code: 0, stdout: `${REPO}\n` },
    gitHead: { code: 0, stdout: `${SHA}\n` },
    status: { code: 0, stdout: "" },
    lsTree: {
      code: 0,
      stdout: ".dockerignore\ncontrol-plane/store.ts\ncontrol-plane/cli.ts\n",
    },
    sqlThrows: null,
    canLogin: false,
    backends: 0,
    backendsAfterDeploy: 3,
    badCount: false,
    roleMissing: false,
    roleLimit: PROVISIONER_BUDGET,
    roleConfig: GOVERNED_CONFIG,
    ownerConfig: GOVERNED_CONFIG,
    liveBranch: BRANCH_ID,
    machinesBefore: listing(machine()),
    machinesAfter: listing(machine({ instance_id: "01JINSTANCEB" })),
    machinesCode: 0,
    machinesThrows: false,
    deployCode: 0,
    deployThrows: false,
    stageCode: 0,
    stageEcho: false,
    secretsListCode: 0,
    secretsList: JSON.stringify(SECRET_NAMES.map((Name) => ({ Name }))),
    probeCode: 0,
    probeStdout: "bearer_enforced: true\naccepted: true\n",
    probeThrows: false,
    resolveCalls: { n: 0 },
    deployTimesOut: false,
    deployGroupSurvived: false,
    deployBlocks: null,
    timeouts: [],
    ...over,
  };

  const lines: string[] = [];
  const spawns: Rig["spawns"] = [];
  const gits: string[][] = [];
  const sqls: Rig["sqls"] = [];
  const sleeps: number[] = [];
  const events: string[] = [];
  const bounded: { argv: string[]; deadlineMs: number }[] = [];
  let canLogin = o.canLogin;
  let deploys = 0;

  const p: Primitives = {
    git: async (args) => {
      gits.push([...args]);
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return o.gitTop;
      }
      if (args[0] === "rev-parse") return o.gitHead;
      if (args[0] === "status") return o.status;
      if (args[0] === "ls-tree") return o.lsTree;
      return { code: 1, stdout: "" };
    },
    boundedSpawn: async (argv, env, stdin, deadlineMs) => {
      spawns.push({ argv: [...argv], env: { ...env }, stdin });
      bounded.push({ argv: [...argv], deadlineMs });
      const kind = argv.slice(1).join(" ");
      const unclean = (over: Partial<BoundedResult> = {}): BoundedResult => ({
        code: null,
        timedOut: true,
        groupSurvived: false,
        groupEmpty: true,
        stdout: "",
        stderr: "",
        ...over,
      });
      const clean = (code: number, stdout: string): BoundedResult => ({
        code,
        timedOut: false,
        groupSurvived: false,
        groupEmpty: true,
        stdout,
        stderr: "",
      });

      if (kind.startsWith("machines list")) {
        events.push("machines_list");
        if (o.machinesThrows) throw new Error(`flyctl died at ${HOST}`);
        if (o.timeouts.includes("machines")) return unclean();
        return clean(
          o.machinesCode,
          deploys === 0 ? o.machinesBefore : o.machinesAfter,
        );
      }
      if (kind.startsWith("secrets import")) {
        if (o.timeouts.includes("stage")) return unclean();
        return clean(o.stageCode, o.stageEcho ? stdin : "");
      }
      if (kind.startsWith("secrets list")) {
        if (o.timeouts.includes("names")) return unclean();
        return clean(o.secretsListCode, o.secretsList);
      }
      if (argv[1] === PROBE_SCRIPT) {
        if (o.probeThrows) throw new Error("the probe child never started");
        if (o.timeouts.includes("probe")) return unclean();
        return clean(o.probeCode, o.probeStdout);
      }
      if (kind.startsWith("deploy")) {
        deploys++;
        events.push("deploy_spawned");
        if (o.deployThrows) throw new Error(`flyctl died at ${HOST}`);
        if (o.deployBlocks) await o.deployBlocks();
        events.push("deploy_finished");
        if (o.deployGroupSurvived) {
          return unclean({ timedOut: false, groupSurvived: true });
        }
        if (o.deployTimesOut) return unclean();
        return clean(o.deployCode, "");
      }
      return clean(127, "");
    },
    flyToken: () => "fly-token-value",
    resolveTarget: async () => {
      o.resolveCalls.n++;
      return target(o.dsn);
    },
    liveBranchId: async () => o.liveBranch,
    sql: async (dsn, statement, args) => {
      sqls.push({ dsn, statement, args });
      if (o.sqlThrows) throw o.sqlThrows();
      if (statement.includes("current_user as role")) {
        return [{ role: OWNER_ROLE }];
      }
      if (statement.includes("pg_stat_activity")) {
        events.push("backend_read");
        const now = deploys > 0 ? o.backendsAfterDeploy : o.backends;
        return [{ n: o.badCount ? "several" : now }];
      }
      if (statement.includes("pg_roles r")) {
        const wanted = ((args?.[0] as string[] | undefined) ?? []).slice();
        const rows: Record<string, unknown>[] = [];
        if (wanted.includes(PROVISIONER_ROLE) && !o.roleMissing) {
          rows.push({
            role: PROVISIONER_ROLE,
            connection_limit: o.roleLimit,
            can_login: canLogin,
            config: o.roleConfig,
            memberships: "0",
            write_grants: "0",
          });
        }
        if (wanted.includes(OWNER_ROLE)) {
          rows.push({
            role: OWNER_ROLE,
            connection_limit: -1,
            can_login: true,
            config: o.ownerConfig,
            memberships: "0",
            write_grants: "12",
          });
        }
        return rows;
      }
      if (statement.startsWith("alter role")) {
        if (statement.includes("login password")) canLogin = true;
        if (statement.includes("nologin")) canLogin = false;
        return [];
      }
      return [{ one: 1 }];
    },
    contextRules,
    cwd: () => o.cwd,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    interpreter: "/usr/bin/bun",
  };

  return {
    p,
    seams: realSeams(p, (line) => lines.push(line)),
    lines,
    spawns,
    gits,
    sqls,
    sleeps,
    events,
    bounded,
    resolves: () => o.resolveCalls.n,
  };
}

const porcelain = (...entries: string[]) => ({
  code: 0,
  stdout: `${entries.join("\n")}\n`,
});

describe("the source checks ask about the tree fly would ship", () => {
  test("the commit is the one HEAD is at", async () => {
    const r = rig();
    expect(await r.seams.source.committedSha()).toBe(SHA);
  });

  // `fly deploy .` sends the CURRENT DIRECTORY. A HEAD read from a repository
  // that is not the build context is an answer about a different tree.
  test("a working directory that is not the build context reads as no commit", async () => {
    const r = rig({ cwd: "/repo/control-plane" });
    expect(await r.seams.source.committedSha()).toBe(null);
  });

  test("an unreadable HEAD and a non-sha both read as no commit", async () => {
    for (const over of [
      { gitHead: { code: 128, stdout: "" } },
      { gitHead: { code: 0, stdout: "not-a-sha\n" } },
      { gitTop: { code: 128, stdout: "" } },
    ]) {
      expect(await rig(over).seams.source.committedSha()).toBe(null);
    }
  });

  test("the status is taken under the pathspec the image copies", async () => {
    const r = rig();
    await r.seams.source.treeIsClean();
    expect(r.gits[0]).toEqual([
      "status",
      "--porcelain",
      "-uall",
      "--",
      IMAGE_PATHSPEC,
      CONTEXT_RULES_PATH,
    ]);
    expect(r.gits[1]).toEqual([
      "ls-tree",
      "-r",
      "--name-only",
      "HEAD",
      "--",
      IMAGE_PATHSPEC,
      CONTEXT_RULES_PATH,
    ]);
  });

  test("a modified runtime file the image carries blocks the deploy", async () => {
    const r = rig({ status: porcelain(" M control-plane/store.ts") });
    expect(await r.seams.source.treeIsClean()).toBe(false);
    expect(r.lines).toContain("shipped_paths_uncommitted: 1");
  });

  // The archive question and this one differ here, and the difference is the
  // whole reason the check is its own adapter: a fly deploy ships the working
  // DIRECTORY, so a file no commit carries travels with it.
  test("an untracked file under the copied tree blocks the deploy", async () => {
    const r = rig({ status: porcelain("?? control-plane/deploy/scratch.ts") });
    expect(await r.seams.source.treeIsClean()).toBe(false);
  });

  test("an intent-to-add entry counts the same way", async () => {
    const r = rig({ status: porcelain("A  control-plane/deploy/scratch.ts") });
    expect(await r.seams.source.treeIsClean()).toBe(false);
  });

  // Documentation is not runtime, but the image carries it, so the image would
  // not be reconstructible from HEAD either.
  test("a modified document the image carries blocks the deploy", async () => {
    // HEAD carries it, so this is the docOnly arm of the classifier rather
    // than the untracked one - the arm the archive question forgives.
    const r = rig({
      status: porcelain(" M control-plane/README.md"),
      lsTree: { code: 0, stdout: ".dockerignore\ncontrol-plane/README.md\n" },
    });
    expect(await r.seams.source.treeIsClean()).toBe(false);
    expect(r.lines).toContain("shipped_paths_uncommitted: 1");
  });

  test("what the rules drop does not block anything", async () => {
    const r = rig({
      status: porcelain(
        " M control-plane/web/app/page.tsx",
        " M control-plane/store.test.ts",
        "?? control-plane/web/node_modules/next/index.js",
      ),
      lsTree: {
        code: 0,
        stdout:
          ".dockerignore\ncontrol-plane/web/app/page.tsx\ncontrol-plane/store.test.ts\n",
      },
    });
    expect(await r.seams.source.treeIsClean()).toBe(true);
    expect(r.lines).toContain("shipped_paths_uncommitted: 0");
  });

  // The rules file sits OUTSIDE the copied path, so the shipped-path count can
  // never see it - while its working-tree bytes decide what that count is
  // allowed to ignore. A modified one can put control-plane/web, the tests or
  // node_modules into the image and still answer "reconstructible".
  test("rules that are not committed are not trusted", async () => {
    const dirty: { code: number; stdout: string }[] = [
      porcelain(" M .dockerignore"),
      porcelain(" D .dockerignore"),
      porcelain("R  .dockerignore -> .dockerignore.bak"),
      porcelain("?? .dockerignore"),
      porcelain("A  .dockerignore"),
      porcelain("MM .dockerignore"),
    ];
    for (const status of dirty) {
      const r = rig({ status });
      expect(await r.seams.source.treeIsClean()).toBe(false);
      expect(r.lines).toContain("context_rules_committed: false");
    }
  });

  test("rules HEAD does not carry are not trusted either", async () => {
    const r = rig({
      lsTree: { code: 0, stdout: "control-plane/store.ts\n" },
    });
    expect(await r.seams.source.treeIsClean()).toBe(false);
    expect(r.lines).toContain("context_rules_committed: false");
  });

  test("a clean tree passes and an unreadable git refuses", async () => {
    expect(await rig().seams.source.treeIsClean()).toBe(true);
    const broken = rig({ status: { code: 128, stdout: "" } });
    expect(await broken.seams.source.treeIsClean()).toBe(false);
    expect(broken.lines).toContain("source_readable: false");
  });
});

describe("one Neon resolution supplies every string", () => {
  test("the owner string is the target's, unchanged, on a direct host", async () => {
    const resolved = await rig().seams.api.resolve();
    expect(resolved.ownerDsn).toBe(OWNER_DSN);
    expect(resolved.hostIsPooler).toBe(false);
  });

  // The host is classified from the string that will be used, not from a flag
  // somebody set beside it: the pooled endpoint refuses the store's bounds
  // channel, so a run that reached it would deploy something that cannot open.
  test("a pooled host is reported as one", async () => {
    const pooled = OWNER_DSN.replace(
      HOST,
      `${HOST.split(".")[0]}-pooler.aws.neon.tech`,
    );
    const r = rig({ dsn: pooled });
    const resolved = await r.seams.api.resolve();
    expect(resolved.hostIsPooler).toBe(true);
    expect(resolved.roleDsnFor("a".repeat(32))).toContain("-pooler");
  });

  // `URL` drops credentials without a word when the string carries no host, so
  // the "role" string would come out byte for byte the OWNER's - staged and
  // deployed as though the move had happened.
  test("a string that cannot carry credentials is refused, not returned", () => {
    expect(() => roleDsnFrom("postgresql:///neondb", "a".repeat(32))).toThrow(
      "did not take the credentials",
    );
  });

  test("a connection string that is not one is a fixed sentence", async () => {
    const r = rig({ dsn: "not a connection string" });
    const err = await r.seams.api.resolve().then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toBe("a connection string could not be parsed");
  });

  test("the role string differs from the owner's in its credentials alone", async () => {
    const password = "f".repeat(64);
    const roleDsn = (await rig().seams.api.resolve()).roleDsnFor(password);
    const role = new URL(roleDsn);
    const owner = new URL(OWNER_DSN);
    expect(role.host).toBe(owner.host);
    expect(role.pathname).toBe(owner.pathname);
    expect(role.search).toBe(owner.search);
    expect(role.protocol).toBe(owner.protocol);
    expect(role.username).toBe(PROVISIONER_ROLE);
    expect(role.password).toBe(password);
    expect(roleDsn).not.toContain(OWNER_PASSWORD);
    expect(roleDsn).not.toContain(OWNER_ROLE);
  });

  test("the target is resolved once for the whole run", async () => {
    const r = rig();
    await r.seams.api.resolve();
    await r.seams.db.facts();
    await r.seams.db.branchProved();
    await r.seams.db.backendSamples();
    await r.seams.db.roleGovernedExactly();
    expect(r.resolves()).toBe(1);
  });

  test("the branch is proved by the engine against the API's id", async () => {
    expect(await rig().seams.db.branchProved()).toBe(true);
    expect(
      await rig({ liveBranch: "br-something-else" }).seams.db.branchProved(),
    ).toBe(false);
    expect(await rig({ liveBranch: null }).seams.db.branchProved()).toBe(false);
  });
});

describe("the database seam is the ruling-8 boundary", () => {
  /** What a driver actually throws: the host on a refused socket, and the ROLE
   * on a bad password (both measured 2026-08-11). */
  const leaky = () => {
    const err = new Error(
      `password authentication failed for user "${OWNER_ROLE}" at ${HOST}`,
    ) as Error & { code: string };
    err.code = "28P01";
    return err;
  };

  const clean = (message: string): boolean =>
    !message.includes(HOST) &&
    !message.includes(OWNER_ROLE) &&
    !message.includes(OWNER_PASSWORD) &&
    !message.includes("password authentication failed");

  test("a driver error crossing a read is redacted, SQLSTATE kept", async () => {
    const r = rig({ sqlThrows: leaky });
    for (const call of [
      () => r.seams.db.facts(),
      () => r.seams.db.backendSamples(),
      () => r.seams.db.sampleAcross(async () => 1),
      () => r.seams.db.roleGovernedExactly(),
      () =>
        r.seams.db.run("alter role cp_provisioner with nologin password null"),
    ]) {
      const err = await call().then(
        () => null,
        (e: Error) => e,
      );
      expect(err).not.toBe(null);
      expect(clean(err!.message)).toBe(true);
      expect(err!.message).toContain("28P01");
      expect(err!.stack ?? "").not.toContain(HOST);
      expect((err as { cause?: unknown }).cause).toBe(undefined);
    }
  });

  test("a connection that does not open is a boolean, not an error", async () => {
    const r = rig({ sqlThrows: leaky });
    expect(await r.seams.db.opens(OWNER_DSN)).toBe(false);
    for (const line of r.lines) expect(clean(line)).toBe(true);
  });

  test("the string proved is the string asked about", async () => {
    const r = rig();
    expect(await r.seams.db.opens(OWNER_DSN)).toBe(true);
    expect(r.sqls[r.sqls.length - 1].dsn).toBe(OWNER_DSN);
  });
});

describe("the fixed shape of what the database is asked and reports", () => {
  test("the catalog's booleans arrive as booleans", async () => {
    const facts = await rig({ canLogin: true, backends: 3 }).seams.db.facts();
    expect(facts).toEqual({
      roleCanLogin: true,
      roleBackends: 3,
      ownerBoundsExact: true,
    });
  });

  test("a role the catalog does not carry cannot log in", async () => {
    const facts = await rig({ roleMissing: true }).seams.db.facts();
    expect(facts.roleCanLogin).toBe(false);
  });

  test("drifted or absent owner bounds read as not exact", async () => {
    for (const ownerConfig of [
      [],
      ["statement_timeout=1min"],
      [...GOVERNED_CONFIG, "search_path=public"],
    ]) {
      expect(
        (await rig({ ownerConfig }).seams.db.facts()).ownerBoundsExact,
      ).toBe(false);
    }
  });

  test("the role is governed only at the exact budget and the exact bounds", async () => {
    expect(await rig().seams.db.roleGovernedExactly()).toBe(true);
    expect(
      await rig({
        roleLimit: PROVISIONER_BUDGET + 1,
      }).seams.db.roleGovernedExactly(),
    ).toBe(false);
    expect(await rig({ roleConfig: [] }).seams.db.roleGovernedExactly()).toBe(
      false,
    );
    expect(
      await rig({ roleMissing: true }).seams.db.roleGovernedExactly(),
    ).toBe(false);
  });

  test("the backend series is bounded, whole and spaced", async () => {
    const r = rig({ backends: 4 });
    const series = await r.seams.db.backendSamples();
    expect(series).toHaveLength(BACKEND_SAMPLES);
    expect(series.every((n) => Number.isInteger(n))).toBe(true);
    expect(r.sleeps).toEqual(
      Array(BACKEND_SAMPLES - 1).fill(BACKEND_SAMPLE_GAP_MS),
    );
    expect(r.lines).toContain(`backend_sample_count: ${BACKEND_SAMPLES}`);
  });

  test("a count that is not a whole number is a failure, not a reading", async () => {
    const r = rig({ badCount: true });
    const err = await r.seams.db.backendSamples().then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain("whole number");
  });

  test("the count is asked about the provisioner's role", async () => {
    const r = rig();
    await r.seams.db.backendSamples();
    const call = r.sqls.find((c) => c.statement.includes("pg_stat_activity"))!;
    expect(call.args).toEqual([PROVISIONER_ROLE]);
  });
});

describe("the stage sets one name, over stdin", () => {
  const importCall = (r: Rig) =>
    r.spawns.find((s) => s.argv.join(" ").includes("secrets import"))!;

  test("the exact command line, the exact bytes, and nothing else set", async () => {
    const r = rig();
    const value = `postgresql://${PROVISIONER_ROLE}:abc@${HOST}/neondb`;
    expect(await r.seams.fly.stage(value)).toEqual({
      ok: true,
      valueEchoed: false,
    });
    const call = importCall(r);
    expect(call.argv).toEqual([
      FLYCTL,
      "secrets",
      "import",
      "-a",
      APP,
      "--stage",
    ]);
    expect(call.stdin).toBe(`CONTROL_PLANE_DB=${value}\n`);
    expect(call.stdin.trim().split("\n")).toHaveLength(1);
    expect(call.env.FLY_API_TOKEN).toBe("fly-token-value");
    // The value is never an argument: the process table shows argv to everyone.
    expect(call.argv.some((a) => a.includes(value))).toBe(false);
  });

  test("a non-zero import is not ok", async () => {
    const r = rig({ stageCode: 1 });
    expect((await r.seams.fly.stage("postgresql://x:y@z/db")).ok).toBe(false);
  });

  test("a child that repeated the value says so", async () => {
    const r = rig({ stageEcho: true });
    const staged = await r.seams.fly.stage("postgresql://x:y@z/db");
    expect(staged.valueEchoed).toBe(true);
  });

  // A newline would end one NAME=VALUE line and begin another, so a value
  // carrying one could set a name nobody asked for. It never reaches a child.
  test("a value carrying a line break is refused before a child exists", async () => {
    const r = rig();
    const staged = await r.seams.fly.stage("postgresql://x:y@z/db\nOTHER=1");
    expect(staged).toEqual({ ok: false, valueEchoed: false });
    expect(r.spawns).toEqual([]);
  });

  test("the secret names read reports presence and readability together", async () => {
    expect(await rig().seams.fly.secretNamesPresent()).toBe(true);
    expect(
      await rig({ secretsListCode: 1 }).seams.fly.secretNamesPresent(),
    ).toBe(false);
    expect(
      await rig({
        secretsList: JSON.stringify([{ Name: "CONTROL_PLANE_DB" }]),
      }).seams.fly.secretNamesPresent(),
    ).toBe(false);
  });
});

describe("the deploy runs one exact command and hides nothing", () => {
  // Every child now goes through the bounded primitive, so a deploy is
  // identified by its argv rather than by being the only one recorded.
  const deployCall = (r: Rig) =>
    r.bounded.filter((c) => c.argv[1] === "deploy");
  /** Every real deploy is preceded by the baseline capture; the two are
   * adjacent by construction, which is what keeps the sampled window around
   * the CHILD rather than around a machine listing. */
  const prepared = async (r: Rig) => {
    expect(await r.seams.fly.prepareDeploy()).toBe(true);
    return r;
  };

  test("exactly the reviewed argv, once, with the token and the deadline", async () => {
    const r = await prepared(rig());
    expect(await r.seams.fly.deploy(DEPLOY_ARGV)).toEqual({
      exitCode: 0,
      threw: false,
    });
    expect(deployCall(r)).toHaveLength(1);
    expect(deployCall(r)[0].argv).toEqual([FLYCTL, ...DEPLOY_ARGV]);
    expect(deployCall(r)[0].deadlineMs).toBe(DEPLOY_DEADLINE_MS);
    const spawned = r.spawns.filter((c) => c.argv[1] === "deploy");
    expect(spawned[0].env.FLY_API_TOKEN).toBe("fly-token-value");
    expect(spawned[0].stdin).toBe("");
  });

  test("a non-zero exit is reported as itself", async () => {
    const r = await prepared(rig({ deployCode: 1 }));
    expect(await r.seams.fly.deploy(DEPLOY_ARGV)).toEqual({
      exitCode: 1,
      threw: false,
    });
  });

  // A dead child is the same situation as a non-zero exit: the world may have
  // changed and this process does not know how. It becomes the flag, not an
  // exception, and the child's text goes nowhere.
  test("a child that dies becomes the coordinator's ambiguity", async () => {
    const r = await prepared(rig({ deployThrows: true }));
    expect(await r.seams.fly.deploy(DEPLOY_ARGV)).toEqual({
      exitCode: null,
      threw: true,
    });
    for (const line of r.lines) expect(line).not.toContain("flyctl died");
  });

  // A child terminated for running past its deadline is ambiguous, not failed:
  // it was killed and reaped, so the world stopped changing - but what it
  // changed first is unknown, which is the recovery's whole job.
  test("a deploy that passes its deadline is an ambiguity with fixed evidence", async () => {
    const r = await prepared(rig({ deployTimesOut: true }));
    expect(await r.seams.fly.deploy(DEPLOY_ARGV)).toEqual({
      exitCode: null,
      threw: true,
    });
    expect(r.lines).toContain("deploy_timed_out: true");
    expect(deployCall(r)).toHaveLength(1);
  });

  // The leader's exit code says what IT thought, not what the processes it
  // started are still doing.
  test("a deploy whose group outlived it is an ambiguity too", async () => {
    const r = await prepared(rig({ deployGroupSurvived: true }));
    expect(await r.seams.fly.deploy(DEPLOY_ARGV)).toEqual({
      exitCode: null,
      threw: true,
    });
    expect(r.lines).toContain("deploy_group_survived: true");
  });

  // Replacement can only be shown as a difference, so the evidence has to exist
  // before the thing it is evidence about - and the shape the overlap
  // arithmetic assumes has to hold AT the mutation, not only at the preflight
  // it was checked in.
  test("a topology that is not one started machine refuses BEFORE the deploy", async () => {
    for (const over of [
      { machinesCode: 1 },
      { machinesBefore: "not json" },
      { machinesBefore: listing({ id: "x", state: "started" }) },
      { machinesThrows: true },
      { machinesBefore: "[]" },
      { machinesBefore: listing(machine(), machine({ id: "second" })) },
      { machinesBefore: listing(machine({ state: "stopped" })) },
    ]) {
      const r = rig(over);
      const ok = await r.seams.fly.prepareDeploy().then(
        (v) => v,
        () => false,
      );
      expect(ok).toBe(false);
      expect(deployCall(r)).toHaveLength(0);
      expect(await r.seams.fly.machineReplaced()).toBe(false);
    }
  });

  // The baseline is a precondition of the child, not a step inside it: a deploy
  // whose replacement could never be proved is one this program does not start.
  test("a deploy with no captured baseline never spawns a child", async () => {
    const r = rig();
    const err = await r.seams.fly.deploy(DEPLOY_ARGV).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain("no machine baseline");
    expect(deployCall(r)).toHaveLength(0);
  });
});

describe("machine replacement comes from fly's state", () => {
  test("a machine listing is read as counts and one generation", () => {
    expect(readMachineListing(listing(machine())).count).toBe(1);
    expect(readMachineListing(listing(machine())).allStarted).toBe(true);
    expect(readMachineListing("{}").readable).toBe(false);
    expect(readMachineListing("[]").count).toBe(0);
    // Whichever of the two fields fly carries is enough, and a row carrying
    // neither is unreadable rather than silently equal to the next one.
    expect(generationOf({ instance_id: "a" })).toBe("a");
    expect(generationOf({ image_ref: { digest: "d" } })).toBe("d");
    expect(generationOf({ instance_id: "a", image_ref: { digest: "d" } })).toBe(
      "a|d",
    );
    expect(generationOf({ id: "m", state: "started" })).toBe(null);
  });

  test("a new instance on one started machine is a replacement", async () => {
    const r = rig();
    expect(await r.seams.fly.prepareDeploy()).toBe(true);
    await r.seams.fly.deploy(DEPLOY_ARGV);
    expect(await r.seams.fly.machineReplaced()).toBe(true);
    expect(r.lines).toContain("machines_before_deploy: 1");
    expect(r.lines).toContain("machines_after_deploy: 1");
  });

  test("an unchanged generation, a second machine or a stopped one is not", async () => {
    for (const over of [
      { machinesAfter: listing(machine()) },
      {
        machinesAfter: listing(
          machine({ instance_id: "01JB" }),
          machine({ id: "second", instance_id: "01JC" }),
        ),
      },
      {
        machinesAfter: listing(
          machine({ instance_id: "01JB", state: "stopped" }),
        ),
      },
      { machinesAfter: "not json" },
    ]) {
      const r = rig(over);
      expect(await r.seams.fly.prepareDeploy()).toBe(true);
      await r.seams.fly.deploy(DEPLOY_ARGV);
      expect(await r.seams.fly.machineReplaced()).toBe(false);
    }
  });

  test("no deploy means no evidence", async () => {
    expect(await rig().seams.fly.machineReplaced()).toBe(false);
  });

  test("the topology precondition answers before anything is written", async () => {
    expect(await rig().seams.fly.singleStartedMachine()).toBe(true);
    for (const over of [
      { machinesBefore: "[]" },
      { machinesBefore: listing(machine(), machine({ id: "second" })) },
      { machinesBefore: listing(machine({ state: "stopped" })) },
      { machinesBefore: "not json" },
      { machinesCode: 1 },
    ]) {
      const r = rig(over);
      expect(await r.seams.fly.singleStartedMachine()).toBe(false);
      expect(r.lines).toContain("single_started_machine: false");
    }
  });
});

describe("the backends are counted while the deploy runs", () => {
  test("a reading is taken before the action settles, and after it", async () => {
    const r = rig({ backends: 2 });
    let released = () => {};
    const pending = new Promise<void>((resolve) => {
      released = resolve;
    });
    // The action stays pending until the sampler has taken a reading, which is
    // the only way to show a sample was taken WHILE it ran.
    const run = r.seams.db.sampleAcross(async () => {
      await pending;
      return "deployed";
    });
    await Promise.resolve();
    released();
    const answer = await run;
    expect(answer.value).toBe("deployed");
    expect(answer.during).toBeGreaterThanOrEqual(1);
    expect(answer.samples).toHaveLength(answer.during + BACKEND_SAMPLES);
    expect(answer.samples.every((n) => n === 2)).toBe(true);
    expect(r.lines).toContain(`backend_samples_during: ${answer.during}`);
  });

  /**
   * A deploy that hangs must not sample forever.
   *
   * The action settles on a TIMER, and the sampler's own waiting is all
   * microtasks (the fake sleep resolves at once). A timer cannot run until the
   * microtask queue drains, so a bounded loop reaches its cap, parks on the
   * action, and lets the timer through - while a loop with no bound starves the
   * timer and never finishes. The assertion is the cap; the hang is what a
   * missing bound looks like, and the test's own timeout is what reports it.
   */
  test("a long action stops the sampler at its fixed cap", async () => {
    const r = rig();
    const answer = await r.seams.db.sampleAcross(
      () => new Promise<number>((resolve) => setTimeout(() => resolve(1), 0)),
    );
    expect(answer.during).toBe(SAMPLES_DURING_CAP);
    expect(answer.samples).toHaveLength(SAMPLES_DURING_CAP + BACKEND_SAMPLES);
  }, 2000);

  test("a rejected action is not turned into a measurement", async () => {
    const r = rig();
    const err = await r.seams.db
      .sampleAcross(() => Promise.reject(new Error("the deploy never started")))
      .then(
        () => null,
        (e: Error) => e,
      );
    expect(err).not.toBe(null);
  });

  test("a driver failure during sampling is redacted", async () => {
    const r = rig({ sqlThrows: () => new Error(`refused at ${HOST}`) });
    const err = await r.seams.db
      .sampleAcross(async () => 1)
      .then(
        () => null,
        (e: Error) => e,
      );
    expect(err?.message).not.toContain(HOST);
  });

  /**
   * A FAILED READING MUST NOT HAND CONTROL BACK WHILE THE DEPLOY RUNS.
   *
   * If it did, the coordinator would take the rejection as ambiguity and start
   * a recovery - staging the owner DSN and running a SECOND deploy over the
   * first one, because a database hiccup happened to land mid-flight.
   */
  test("a sampling failure waits for the action before it returns", async () => {
    let release: (v: number) => void = () => {};
    const pending = new Promise<number>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const r = rig({
      // The FIRST reading fails; every later one would too, but the first is
      // the one that used to end the call.
      sqlThrows: null,
    });
    const failing: Primitives = {
      ...r.p,
      sql: async (dsn, statement, args) => {
        if (statement.includes("pg_stat_activity")) {
          reads++;
          throw new Error(`refused at ${HOST}`);
        }
        return r.p.sql(dsn, statement, args);
      },
    };
    const lines: string[] = [];
    const seams = realSeams(failing, (line) => lines.push(line));

    let settled = false;
    const run = seams.db
      .sampleAcross(() => pending)
      .then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
    // Give the sampler every chance to return early.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(reads).toBeGreaterThanOrEqual(1);
    expect(settled).toBe(false);

    release(1);
    await run;
    expect(settled).toBe(true);
    expect(lines).toContain("backend_sampling_failed: true");
  });

  /**
   * "During the deploy" has to mean during the CHILD.
   *
   * The topology listing used to run inside the deploy adapter, so the
   * sampler's first reading could fall between `machines list` and the child -
   * a reading that proves nothing about overlap while still counting as one.
   * The event log is what settles it: a counted reading has to appear after the
   * spawn and before the child finished.
   */
  test("a counted reading falls between the deploy's spawn and its finish", async () => {
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = rig({ deployBlocks: () => blocked });
    expect(await r.seams.fly.prepareDeploy()).toBe(true);
    const run = r.seams.db.sampleAcross(() => r.seams.fly.deploy(DEPLOY_ARGV));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    release();
    const answer = await run;

    const spawned = r.events.indexOf("deploy_spawned");
    const finished = r.events.indexOf("deploy_finished");
    const inside = r.events
      .map((name, i) => ({ name, i }))
      .filter(
        (e) => e.name === "backend_read" && e.i > spawned && e.i < finished,
      );
    expect(spawned).toBeGreaterThanOrEqual(0);
    expect(inside.length).toBeGreaterThanOrEqual(1);
    expect(answer.during).toBeGreaterThanOrEqual(1);
    // And the machine listing is NOT inside that window: it happened before the
    // spawn, so no reading beside it could ever be counted as overlap.
    expect(r.events.indexOf("machines_list")).toBeLessThan(spawned);
  });
});

describe("a child's whole process GROUP is bounded, terminated and proved gone", () => {
  const marker = (name: string) =>
    path.join("/tmp", `isomux-g3-${name}-${process.pid}`);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * The claim under test is not "the leader died" - it is "nothing it started
   * can still act". A descendant that outlives the kill could hold credentials
   * and keep talking to a provider AFTER the coordinator has begun recovering
   * on the strength of this answer.
   */
  test("a descendant cannot perform a delayed effect after the call returns", async () => {
    const file = marker("descendant");
    fs.rmSync(file, { force: true });
    const started = Date.now();
    // The leader traps SIGTERM; the descendant would write the file a second
    // later. Only a GROUP kill stops it.
    const answer = await realBoundedSpawn(
      ["sh", "-c", `trap '' TERM; (sleep 1; echo late > ${file}) & sleep 30`],
      {},
      "",
      150,
      200,
    );
    expect(answer.code).toBe(null);
    expect(answer.timedOut).toBe(true);
    expect(answer.groupEmpty).toBe(true);
    // It returned because the GROUP is gone, not because a timer fired.
    expect(Date.now() - started).toBeLessThan(5_000);

    // Well past when the descendant would have written it.
    await wait(2_000);
    expect(fs.existsSync(file)).toBe(false);
  }, 20_000);

  /**
   * The other half of the same problem, and the one the deadline cannot catch:
   * the leader exits 0 promptly while something it started keeps the inherited
   * pipe open. Waiting for end-of-stream would wait for a process nobody is
   * tracking, and reporting exit 0 would call that a success.
   */
  test("a leader that exits while its group lives is terminated, not believed", async () => {
    const file = marker("outlived");
    fs.rmSync(file, { force: true });
    const started = Date.now();
    const answer = await realBoundedSpawn(
      ["sh", "-c", `(sleep 1; echo late > ${file}) & exit 0`],
      {},
      "",
      30_000,
      200,
    );
    expect(answer.groupSurvived).toBe(true);
    expect(answer.code).toBe(null);
    expect(answer.timedOut).toBe(false);
    expect(answer.groupEmpty).toBe(true);
    // Bounded by the group, not by the descendant's own lifetime.
    expect(Date.now() - started).toBeLessThan(5_000);

    await wait(2_000);
    expect(fs.existsSync(file)).toBe(false);
  }, 20_000);

  /**
   * The polite half of termination has to reach the descendants too.
   *
   * The leader ignores SIGTERM; the descendant handles it and records that it
   * arrived. Signalling only the leader would leave the descendant to be
   * SIGKILLed, which it cannot observe - so the file is the difference between
   * terminating a GROUP and terminating a process.
   */
  test("SIGTERM reaches a descendant, not only the leader", async () => {
    const file = marker("termed");
    fs.rmSync(file, { force: true });
    const answer = await realBoundedSpawn(
      [
        "sh",
        "-c",
        `trap '' TERM; (trap 'echo termed > ${file}; exit 0' TERM; sleep 30) & sleep 30`,
      ],
      {},
      "",
      150,
      3_000,
    );
    expect(answer.timedOut).toBe(true);
    expect(answer.groupEmpty).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    fs.rmSync(file, { force: true });
  }, 20_000);

  /**
   * A writer that LEFT the group can hold the pipe open after the group is
   * gone, so end-of-stream is a promise this program cannot wait on. `setsid`
   * is that writer: quiescence says the group is empty and the pipe stays open
   * anyway.
   */
  test("an out-of-group writer holding the pipe cannot stall the answer", async () => {
    const started = Date.now();
    const answer = await realBoundedSpawn(
      ["sh", "-c", "setsid sleep 30 & exit 0"],
      {},
      "",
      30_000,
      200,
    );
    expect(answer.groupEmpty).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  test("a child that exits cleanly reports its own code and its output", async () => {
    const answer = await realBoundedSpawn(
      ["sh", "-c", "echo hello; exit 3"],
      {},
      "",
      10_000,
    );
    expect(answer.code).toBe(3);
    expect(answer.timedOut).toBe(false);
    expect(answer.groupSurvived).toBe(false);
    expect(answer.groupEmpty).toBe(true);
    expect(answer.stdout.trim()).toBe("hello");
  });

  test("stdin reaches the child", async () => {
    const answer = await realBoundedSpawn(["cat"], {}, "one line\n", 10_000);
    expect(answer.stdout).toBe("one line\n");
    expect(answer.code).toBe(0);
  });

  // The office's own processes share a group with this test runner; a signal to
  // that group would take the session down. The child must not be in it.
  test("the child runs in a group of its own", async () => {
    const answer = await realBoundedSpawn(
      ["sh", "-c", "cut -d' ' -f5 /proc/self/stat"],
      {},
      "",
      10_000,
    );
    const childGroup = Number(answer.stdout.trim());
    const ourGroup = Number(
      fs
        .readFileSync(`/proc/${process.pid}/stat`, "utf8")
        .split(") ")[1]
        .split(" ")[2],
    );
    expect(Number.isInteger(childGroup)).toBe(true);
    expect(childGroup).not.toBe(ourGroup);
  });
});

describe("what a group probe is allowed to conclude", () => {
  // ONLY ESRCH IS ABSENCE. EPERM is a process that exists and cannot be
  // signalled - the opposite of empty, and what an earlier version reported as
  // proof the group was gone.
  test("only ESRCH reads as empty", () => {
    const withCode = (code: string) => Object.assign(new Error("x"), { code });
    expect(classifyGroupProbe(withCode("ESRCH"))).toBe("empty");
    for (const code of ["EPERM", "EINVAL", "EACCES", "ENOSYS"]) {
      expect(classifyGroupProbe(withCode(code))).toBe("alive");
    }
    expect(classifyGroupProbe(new Error("no code at all"))).toBe("alive");
    expect(classifyGroupProbe(null)).toBe("alive");
    expect(classifyGroupProbe(undefined)).toBe("alive");
  });

  // A probe that can never say "empty" must not produce a proof, and must not
  // produce a hang either.
  test("a group that cannot be proved empty is reported, not assumed", async () => {
    const started = Date.now();
    const answer = await realBoundedSpawn(
      ["sh", "-c", "sleep 30"],
      {},
      "",
      100,
      200,
      () => "alive",
    );
    expect(answer.timedOut).toBe(true);
    expect(answer.groupEmpty).toBe(false);
    // Bounded even though the probe never concedes: the polls are counted.
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  test("the reconnaissance verdict is the predicate --execute enforces", () => {
    const reading = (over: Record<string, unknown>) => ({
      readable: true,
      count: 1,
      generation: "g",
      allStarted: true,
      ...over,
    });
    expect(machineStateExitCode(reading({}))).toBe(0);
    // The case that used to exit zero and then be refused by the run.
    expect(machineStateExitCode(reading({ allStarted: false }))).toBe(1);
    expect(machineStateExitCode(reading({ count: 2 }))).toBe(1);
    expect(machineStateExitCode(reading({ count: 0 }))).toBe(1);
    expect(machineStateExitCode(reading({ readable: false }))).toBe(1);
  });
});

describe("two streams, two decoders", () => {
  /** A stream that hands over exactly these chunks, so a multi-byte character
   * can be split across two reads on purpose. */
  const chunks = (...parts: number[][]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(new Uint8Array(part));
        controller.close();
      },
    });

  // A shared streaming decoder holds the tail of a split character, so bytes
  // from one stream complete a character begun on the other - corrupting the
  // JSON listing and the probe verdict this program parses.
  test("a character split across reads survives on both streams at once", async () => {
    // "€" is E2 82 AC; "ü" is C3 BC.
    const out = streamSink(chunks([0xe2, 0x82], [0xac, 0x41]));
    const err = streamSink(chunks([0xc3], [0xbc, 0x42]));
    await Promise.all([out.drain, err.drain]);
    expect(out.text()).toBe("€A");
    expect(err.text()).toBe("üB");
  });

  test("a stream that ends mid-character does not swallow it silently", async () => {
    const out = streamSink(chunks([0x41], [0xe2, 0x82]));
    await out.drain;
    // The flush turns the dangling bytes into a replacement character rather
    // than dropping them, so a truncated capture cannot look like a clean one.
    expect(out.text().startsWith("A")).toBe(true);
    expect(out.text().length).toBeGreaterThan(1);
  });
});

describe("the probe is read by its verdict, not its exit code", () => {
  test("the child is this interpreter running the reviewed script", async () => {
    const r = rig();
    expect(await r.seams.probe()).toBe(true);
    const call = r.spawns[r.spawns.length - 1];
    expect(call.argv).toEqual(["/usr/bin/bun", PROBE_SCRIPT]);
    expect(path.basename(PROBE_SCRIPT)).toBe("probe.ts");
  });

  // The case exit-code-only checking gets wrong.
  test("an exit-zero child that printed a refusal is not green", async () => {
    const r = rig({ probeStdout: "accepted: false\n" });
    expect(await r.seams.probe()).toBe(false);
    expect(r.lines).toContain("probe_verdict_line: false");
  });

  test("a verdict without a zero exit is not green either", async () => {
    expect(await rig({ probeCode: 1 }).seams.probe()).toBe(false);
  });

  test("no verdict line at all is not green", async () => {
    expect(await rig({ probeStdout: "" }).seams.probe()).toBe(false);
    expect(
      await rig({ probeStdout: "accepted: true, mostly\n" }).seams.probe(),
    ).toBe(false);
  });

  test("a child that never started is not green and says nothing more", async () => {
    const r = rig({ probeThrows: true });
    expect(await r.seams.probe()).toBe(false);
    for (const line of r.lines) expect(line).not.toContain("never started");
  });

  test("the child's output is not repeated onto the transcript", async () => {
    const r = rig({
      probeStdout: `health_with_credential: 200\naccepted: true\n${HOST}\n`,
    });
    await r.seams.probe();
    for (const line of r.lines) expect(line).not.toContain(HOST);
  });
});

describe("every child reachable after P1 is bounded", () => {
  /**
   * The recovery guarantee starts at the credential, not at P3.
   *
   * Each case hangs ONE post-P1 child until its deadline. The run must reach a
   * fixed outcome - never wait forever holding a live credential - and the
   * child's own text must not reach the transcript.
   */
  const forward: [string, string[]][] = [
    ["the staged secret import", ["stage"]],
    ["the pre-deploy machine listing", ["machines"]],
    ["the secret-name verification", ["names"]],
    ["the probe", ["probe"]],
  ];

  for (const [name, timeouts] of forward) {
    test(`${name} times out -> a fixed outcome, not a hang`, async () => {
      const r = rig({ timeouts });
      const outcome = await moveProvisioner(r.seams);
      expect(["rolled_back", "escalate", "refused_precondition"]).toContain(
        outcome,
      );
      expect(outcome).not.toBe("moved");
      for (const line of r.lines) {
        expect(line).not.toContain(HOST);
        expect(line).not.toContain(OWNER_PASSWORD);
        expect(line).not.toContain("flyctl");
      }
    });
  }

  test("an unclean child is never read as a successful one", async () => {
    // The staged import is the sharpest case: a timeout that arrived as exit 0
    // with empty output would look like a clean stage that echoed nothing, and
    // the run would deploy a secret it never proved was set.
    const r = rig({ timeouts: ["stage"] });
    await moveProvisioner(r.seams);
    expect(r.lines).toContain("new_dsn_staged: false");
  });

  test("a probe that times out is not a green probe", async () => {
    const r = rig({ timeouts: ["probe"] });
    expect(await moveProvisioner(r.seams)).not.toBe("moved");
    expect(r.lines).toContain("probe_timed_out: true");
    expect(r.lines).toContain("probe_green: false");
  });

  test("a stage that times out is measured and recovered from", async () => {
    const r = rig({ timeouts: ["stage"] });
    const outcome = await moveProvisioner(r.seams);
    expect(r.lines).toContain("stage_timed_out: true");
    // The credential existed, so this is a recovery rather than a refusal.
    expect(["rolled_back", "escalate"]).toContain(outcome);
  });

  test("a machine listing that times out never becomes a deploy", async () => {
    const r = rig({ timeouts: ["machines"] });
    await moveProvisioner(r.seams);
    expect(r.lines).toContain("machine_listing_timed_out: true");
    expect(r.bounded.filter((c) => c.argv[1] === "deploy")).toHaveLength(0);
  });

  // A rollback's children are bounded too, and a rollback that cannot finish
  // leaves the credential enabled.
  test("a rollback child that times out escalates with LOGIN enabled", async () => {
    for (const timeouts of [["stage"], ["machines"], ["probe"]]) {
      const r = rig({ canLogin: true, backends: 1, timeouts });
      expect(await moveProvisioner(r.seams)).toBe("escalate");
      expect(r.sqls.some((c) => c.statement.includes("nologin"))).toBe(false);
    }
  });

  test("every child carries a deadline, and the deploy's is its own", async () => {
    const r = rig();
    expect(await moveProvisioner(r.seams)).toBe("moved");
    // Not a vacuous pass: the run reached the stage, the deploy and the probe.
    const kinds = r.bounded.map((c) => c.argv[1]);
    expect(kinds).toContain("secrets");
    expect(kinds).toContain("deploy");
    expect(kinds).toContain(PROBE_SCRIPT);
    for (const call of r.bounded) {
      expect(call.deadlineMs).toBeGreaterThan(0);
      expect(call.deadlineMs).toBe(
        call.argv[1] === "deploy" ? DEPLOY_DEADLINE_MS : LIGHT_DEADLINE_MS,
      );
    }
  });
});

describe("what the process tells its caller", () => {
  test("only a completed move exits zero", () => {
    expect(exitCodeFor("moved")).toBe(0);
    const failures = (
      ["refused_precondition", "rolled_back", "escalate"] as const
    ).map(exitCodeFor);
    for (const code of failures) expect(code).toBeGreaterThan(0);
    expect(new Set(failures).size).toBe(3);
  });
});

describe("the binding, driven by the coordinator", () => {
  test("a clean world moves, with one deploy of the exact argv", async () => {
    const r = rig({ backends: 0 });
    // The deploy's backends are the one thing a fake database cannot produce -
    // the count moves because a machine started - so the series stands in for
    // a pool that settles at three.
    const seams: Seams = {
      ...r.seams,
      db: {
        ...r.seams.db,
        sampleAcross: async (action) => ({
          value: await action(),
          samples: [5, 4, 3],
          during: 2,
        }),
      },
    };
    expect(await moveProvisioner(seams)).toBe("moved");
    const deploys = r.spawns.filter((s) => s.argv[1] === "deploy");
    expect(deploys).toHaveLength(1);
    expect(deploys[0].argv).toEqual([FLYCTL, ...DEPLOY_ARGV]);
    expect(r.lines).toContain("acceptance: true");

    // The password reached one statement and one stdin, and nothing else.
    const statement = r.sqls.find((c) =>
      c.statement.includes("with login password"),
    )!.statement;
    const password = statement.match(/'([0-9a-f]+)'/)![1];
    const staged = r.spawns.find((s) =>
      s.argv.join(" ").includes("secrets import"),
    )!;
    expect(staged.stdin).toContain(password);
    for (const line of r.lines) expect(line).not.toContain(password);
    for (const line of r.lines) expect(line).not.toContain(OWNER_PASSWORD);
    for (const line of r.lines) expect(line).not.toContain(HOST);
  });

  test("a dirty shipped path refuses before a credential exists", async () => {
    const r = rig({ status: porcelain(" M control-plane/cli.ts") });
    expect(await moveProvisioner(r.seams)).toBe("refused_precondition");
    expect(r.sqls.some((c) => c.statement.includes("login password"))).toBe(
      false,
    );
    // The preflight reads fly's machine listing, which is why "nothing was
    // written" is stated as no WRITE rather than no child at all.
    expect(r.spawns.map((s) => s.argv[1])).toEqual(["machines"]);
  });
});
