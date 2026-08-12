// The separation that keeps a provider credential from moving a database one.
//
// The defect this file exists for was live-reachable: the provider names were
// added to the FIRST-DEPLOY importer's allowlist, and that program builds
// CONTROL_PLANE_DB from the operator's env file - the break-glass OWNER string
// since D3.5. Importing its set and deploying would have moved the provisioner
// off its capped role and back onto the owner, as a side effect of a step about
// provider credentials.
//
// So the property under test is not "the new program works". It is that
// NEITHER PROGRAM CAN NAME THE OTHER'S SECRETS, and that the guard is
// structural - the allowlist reaches `validatePairs` before a child exists.

import { describe, expect, test } from "bun:test";
import { CONTABO_SECRET_NAMES, boundedAdapter } from "./fly-cli.ts";
import {
  SECRET_NAMES,
  namesPresent,
  pushSecrets,
  validatePairs,
} from "./secrets.ts";
import {
  NOT_THIS_PROGRAM_S_NAMES,
  PROVIDER_ONLY_NAMES,
  classifyStage,
} from "./provider-secrets.ts";
import type { Spawn } from "./fly-cli.ts";

/** A flyctl that records what it was asked to do and answers success. */
function fakeFly(): {
  spawn: Spawn;
  calls: { argv: string[]; stdin: string }[];
} {
  const calls: { argv: string[]; stdin: string }[] = [];
  return {
    calls,
    spawn: async (argv, _env, stdin) => {
      calls.push({ argv, stdin });
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

describe("THE TWO ALLOWLISTS ARE DISJOINT", () => {
  // This is the mutation guard, and it is permanent rather than a one-off
  // exercise: widening either allowlist to include one of the other's names
  // fails here, whatever else still passes.
  test("no name appears in both", () => {
    for (const name of PROVIDER_ONLY_NAMES) {
      expect({
        name,
        inFullImporter: (SECRET_NAMES as readonly string[]).includes(name),
      }).toEqual({
        name,
        inFullImporter: false,
      });
    }
    for (const name of SECRET_NAMES) {
      expect({
        name,
        inProviderImporter: (PROVIDER_ONLY_NAMES as readonly string[]).includes(
          name,
        ),
      }).toEqual({ name, inProviderImporter: false });
    }
  });

  test("each list is exactly what its program is for", () => {
    expect([...PROVIDER_ONLY_NAMES]).toEqual([...CONTABO_SECRET_NAMES]);
    expect([...SECRET_NAMES]).toEqual([...NOT_THIS_PROGRAM_S_NAMES]);
  });
});

describe("the provider importer cannot set a database or seam credential", () => {
  test("EVERY name it must not touch is refused BEFORE a child exists", async () => {
    for (const name of NOT_THIS_PROGRAM_S_NAMES) {
      const fly = fakeFly();
      const outcome = await pushSecrets({
        pairs: [{ name, value: "postgresql://someone:secret@host/db" }],
        allowed: PROVIDER_ONLY_NAMES,
        flyToken: "t",
        spawn: fly.spawn,
      });
      expect({ name, spawned: outcome.spawned }).toEqual({
        name,
        spawned: false,
      });
      expect(outcome.problems).toEqual([`not an allowed secret name: ${name}`]);
      // The value never reached a process, which is the guarantee: a refusal
      // that happened after the spawn would have already handed it over.
      expect(fly.calls).toEqual([]);
    }
  });

  test("a mixed batch is refused WHOLE, not filtered down to the allowed part", async () => {
    // Filtering would be the dangerous kindness: the operator would see a
    // success for a command that quietly did less than it was asked.
    const fly = fakeFly();
    const outcome = await pushSecrets({
      pairs: [
        { name: "CONTABO_API_USER", value: "user" },
        { name: "CONTROL_PLANE_DB", value: "postgresql://owner:pw@host/db" },
      ],
      allowed: PROVIDER_ONLY_NAMES,
      flyToken: "t",
      spawn: fly.spawn,
    });
    expect(outcome.spawned).toBe(false);
    expect(fly.calls).toEqual([]);
  });

  test("the four it IS for go over stdin, never in argv", async () => {
    const fly = fakeFly();
    const pairs = PROVIDER_ONLY_NAMES.map((name) => ({
      name,
      value: `value-for-${name}`,
    }));
    const outcome = await pushSecrets({
      pairs,
      allowed: PROVIDER_ONLY_NAMES,
      flyToken: "t",
      spawn: fly.spawn,
    });
    expect(outcome.spawned).toBe(true);
    const call = fly.calls[0];
    for (const pair of pairs) {
      expect(call.stdin).toContain(`${pair.name}=${pair.value}`);
      expect(call.argv.join(" ")).not.toContain(pair.value);
    }
    expect(call.argv).toContain("import");
    expect(call.argv).toContain("--stage");
  });
});

describe("the full importer cannot set a provider credential", () => {
  test("every provider name is refused by the first-deploy allowlist", async () => {
    for (const name of PROVIDER_ONLY_NAMES) {
      const fly = fakeFly();
      const outcome = await pushSecrets({
        pairs: [{ name, value: "provider-secret" }],
        allowed: SECRET_NAMES,
        flyToken: "t",
        spawn: fly.spawn,
      });
      expect({ name, spawned: outcome.spawned }).toEqual({
        name,
        spawned: false,
      });
      expect(fly.calls).toEqual([]);
    }
  });

  test("validatePairs is where it happens, for both directions", () => {
    // Named explicitly because the guarantee is about WHERE the refusal is: in
    // a pure function over the pairs, reachable by tests, ahead of any process.
    expect(
      validatePairs(
        [{ name: "CONTROL_PLANE_DB", value: "x" }],
        PROVIDER_ONLY_NAMES,
      ),
    ).toEqual(["not an allowed secret name: CONTROL_PLANE_DB"]);
    expect(
      validatePairs([{ name: "CONTABO_CLIENT_ID", value: "x" }], SECRET_NAMES),
    ).toEqual(["not an allowed secret name: CONTABO_CLIENT_ID"]);
  });
});

describe("the arguments are exact, and refuse before anything is read", () => {
  // `--verfiy` is the case that matters: with a permissive check it falls
  // through to the branch that stages live credentials (reviewer finding,
  // 2026-08-12). The refusal has to happen before the token or the credential
  // file is opened, so a typo cannot even cause a read.
  const SCRIPT = new URL("./provider-secrets.ts", import.meta.url).pathname;

  test("A TYPO REFUSES, reads nothing and spawns nothing", () => {
    for (const args of [
      ["--verfiy"],
      ["--verify", "--verify"],
      ["--stage"],
      ["verify"],
      ["--verify", "extra"],
      ["-v"],
    ]) {
      const proc = Bun.spawnSync(["bun", SCRIPT, ...args], {
        env: { ...process.env, HOME: "/nonexistent-home-for-this-test" },
      });
      const said = `${proc.stdout.toString()}${proc.stderr.toString()}`;
      expect({ args: args.join(" "), code: proc.exitCode }).toEqual({
        args: args.join(" "),
        code: 2,
      });
      expect(said).toContain("refusing: unrecognised arguments");
      // Nothing was read: no file check ran, so no file boolean was printed.
      expect(said).not.toContain("contabo_file_present");
      expect(said).not.toContain("may_stage");
    }
  });
});

describe("the child that carries the credentials is BOUNDED", () => {
  // `realSpawn` waits forever, and fly-cli.ts says itself that is the wrong
  // shape for anything after a credential exists: a hung import holds the four
  // values, may leave descendants alive, and returns nothing to escalate
  // (reviewer finding, 2026-08-12).
  const RESULT = {
    code: 0,
    timedOut: false,
    groupSurvived: false,
    groupEmpty: true,
    stdout: "",
    stderr: "",
  };

  function adapterOver(over: Partial<typeof RESULT> | "throw") {
    let runs = 0;
    const bounded = async () => {
      runs += 1;
      if (over === "throw") throw new Error("flyctl vanished with the values");
      return { ...RESULT, ...over };
    };
    const child = boundedAdapter(bounded, 1000);
    return { child, runs: () => runs };
  }

  test("a clean import is completed, and starts ONE child", async () => {
    const { child, runs } = adapterOver({});
    const outcome = await pushSecrets({
      pairs: [{ name: "CONTABO_API_USER", value: "u" }],
      allowed: PROVIDER_ONLY_NAMES,
      flyToken: "t",
      spawn: child.spawn,
    });
    const lines: string[] = [];
    expect(classifyStage(outcome, child, (l) => lines.push(l))).toBe(0);
    expect(runs()).toBe(1);
    expect(child.runs()).toBe(1);
  });

  test("A TIMEOUT, A SURVIVING GROUP, A NON-EMPTY GROUP OR A NON-ZERO EXIT IS AMBIGUOUS", async () => {
    for (const over of [
      { timedOut: true },
      { groupSurvived: true },
      { groupEmpty: false },
      { code: 1 },
      { code: null as unknown as number },
    ]) {
      const { child } = adapterOver(over);
      const outcome = await pushSecrets({
        pairs: [{ name: "CONTABO_API_USER", value: "u" }],
        allowed: PROVIDER_ONLY_NAMES,
        flyToken: "t",
        spawn: child.spawn,
      });
      const lines: string[] = [];
      const code = classifyStage(outcome, child, (l) => lines.push(l));
      expect({ over: JSON.stringify(over), code }).toEqual({
        over: JSON.stringify(over),
        code: 3,
      });
      const said = lines.join("\n");
      expect(said).toContain("AMBIGUOUS");
      expect(said).toContain("STOP");
      expect(said).toContain("Do not re-run");
      // The import may have taken effect, so it is NEVER retried here.
      expect(child.runs()).toBe(1);
    }
  });

  test("A THROW IS AMBIGUOUS TOO, and the error is discarded", async () => {
    const { child } = adapterOver("throw");
    const outcome = await pushSecrets({
      pairs: [{ name: "CONTABO_API_USER", value: "u" }],
      allowed: PROVIDER_ONLY_NAMES,
      flyToken: "t",
      spawn: child.spawn,
    });
    const lines: string[] = [];
    expect(classifyStage(outcome, child, (l) => lines.push(l))).toBe(3);
    expect(child.threw()).toBe(true);
    expect(lines.join("\n")).not.toContain("vanished");
  });

  test("a validation refusal never started a child, and says so", async () => {
    const { child } = adapterOver({});
    const outcome = await pushSecrets({
      pairs: [{ name: "CONTROL_PLANE_DB", value: "x" }],
      allowed: PROVIDER_ONLY_NAMES,
      flyToken: "t",
      spawn: child.spawn,
    });
    const lines: string[] = [];
    expect(classifyStage(outcome, child, (l) => lines.push(l))).toBe(2);
    expect(child.runs()).toBe(0);
    expect(lines.join("\n")).toContain("before any child ran");
  });

  test("an unclean read reports UNREADABLE rather than absent names", async () => {
    // The verify path's version of the same rule: a name listing nobody could
    // take is not a listing that found nothing.
    const { child } = adapterOver({ timedOut: true });
    const answer = await namesPresent({
      required: PROVIDER_ONLY_NAMES,
      flyToken: "t",
      spawn: child.spawn,
    });
    expect(answer).toEqual({ present: false, readable: false });
  });
});
