// The arming step: what it refuses to do, and what it refuses to conclude.
//
// Every case drives the real `activate` with seams, because the two properties
// that matter are both about ORDER and INTERPRETATION rather than about flyctl:
// nothing deploys without fresh observations, and no post-spawn outcome is ever
// read as more than it is.

import { describe, expect, test } from "bun:test";
import { DEPLOY_ARGV } from "./provisioner-role.ts";
import { APP, FLYCTL, type BoundedResult } from "./fly-cli.ts";
import {
  DEPLOY_DEADLINE_MS,
  activate,
  classifyActivation,
} from "./activate.ts";
import { PROVIDER_ONLY_NAMES } from "./provider-secrets.ts";

/** What `git ls-tree` names: the rules file, and a runtime path that ships. */
const HEAD_FILES = ".dockerignore\ncontrol-plane/tick.ts";

const CLEAN_RUN: BoundedResult = {
  code: 0,
  timedOut: false,
  groupSurvived: false,
  groupEmpty: true,
  stdout: "deployed",
  stderr: "",
};

function seams(
  over: {
    safe?: boolean;
    targetProved?: boolean;
    present?: boolean;
    readable?: boolean;
    result?: BoundedResult;
  } = {},
) {
  const calls: { argv: string[]; env: Record<string, string> }[] = [];
  const lines: string[] = [];
  return {
    calls,
    lines,
    seams: {
      spawn: async (
        argv: string[],
        env: Record<string, string>,
      ): Promise<BoundedResult> => {
        calls.push({ argv, env });
        return over.result ?? CLEAN_RUN;
      },
      listSpawn: async () => ({ code: 0, stdout: "[]", stderr: "" }),
      // HEAD carries the rules file and one shipped path; the tree is clean.
      git: async (argv: string[]) => ({
        code: 0,
        stdout: argv[0] === "ls-tree" ? HEAD_FILES : "",
      }),
      machines: async () => ({
        readable: true,
        count: 1,
        generation: "g1",
        allStarted: true,
      }),
      flyToken: "fly-token-value",
      preflight: async () => ({
        verdict: { safe: over.safe ?? true },
        targetProved: over.targetProved ?? true,
      }),
      names: async () => ({
        present: over.present ?? true,
        readable: over.readable ?? true,
      }),
      report: (line: string) => lines.push(line),
    },
  };
}

describe("nothing deploys without FRESH observations", () => {
  test("an unsafe production stops it, and no child runs", async () => {
    const s = seams({ safe: false });
    const out = await activate(s.seams);
    expect(out).toEqual({ ran: false, outcome: null });
    expect(s.calls).toEqual([]);
    expect(s.lines.join("\n")).toContain("may_activate: false");
  });

  test("an unproved target is treated as unsafe, not as unknown-but-fine", async () => {
    const s = seams({ targetProved: false, safe: true });
    expect(await activate(s.seams)).toEqual({ ran: false, outcome: null });
    expect(s.calls).toEqual([]);
  });

  test("MISSING PROVIDER NAMES STOP IT", async () => {
    const s = seams({ present: false });
    expect(await activate(s.seams)).toEqual({ ran: false, outcome: null });
    expect(s.calls).toEqual([]);
  });

  test("an UNREADABLE name listing stops it too - not observed is not fine", async () => {
    const s = seams({ readable: false, present: false });
    expect(await activate(s.seams)).toEqual({ ran: false, outcome: null });
    expect(s.calls).toEqual([]);
    expect(s.lines.join("\n")).toContain("have not been read");
  });

  test("both green: it deploys, once, with the COMMITTED argv", async () => {
    const s = seams();
    const out = await activate(s.seams);
    expect(out).toEqual({ ran: true, outcome: "completed" });
    expect(s.calls.length).toBe(1);
    expect(s.calls[0].argv).toEqual([FLYCTL, ...DEPLOY_ARGV]);
    // No app, config, dockerfile or flag from outside the repository.
    expect(s.calls[0].argv).toContain(APP);
    expect(s.calls[0].argv).toContain("--ha=false");
    // The token reaches the child's environment and nothing else.
    expect(s.calls[0].env.FLY_API_TOKEN).toBe("fly-token-value");
    expect(s.calls[0].argv.join(" ")).not.toContain("fly-token-value");
  });

  test("it asks about exactly the four provider names", async () => {
    const asked: readonly string[][] = [];
    const s = seams();
    let seen: readonly string[] = [];
    await activate({
      ...s.seams,
      names: async (args) => {
        seen = args.required;
        return { present: true, readable: true };
      },
    });
    expect([...seen]).toEqual([...PROVIDER_ONLY_NAMES]);
    expect(asked).toEqual([]);
  });
});

describe("EVERY post-spawn outcome that is not a clean exit is AMBIGUOUS", () => {
  test("the classification has two values, and failure is not one of them", () => {
    expect(classifyActivation(CLEAN_RUN)).toBe("completed");
    expect(classifyActivation({ ...CLEAN_RUN, code: 1 })).toBe("ambiguous");
    expect(classifyActivation({ ...CLEAN_RUN, code: null })).toBe("ambiguous");
    expect(classifyActivation({ ...CLEAN_RUN, timedOut: true })).toBe(
      "ambiguous",
    );
    expect(classifyActivation({ ...CLEAN_RUN, groupSurvived: true })).toBe(
      "ambiguous",
    );
    expect(classifyActivation({ ...CLEAN_RUN, groupEmpty: false })).toBe(
      "ambiguous",
    );
  });

  test("A ZERO EXIT WITH A SURVIVING GROUP IS AMBIGUOUS", async () => {
    // The exit code says what the leader thought, not what its children are
    // still doing - and a deploy's children can still be replacing a machine.
    const s = seams({
      result: { ...CLEAN_RUN, groupSurvived: true, groupEmpty: false },
    });
    expect(await activate(s.seams)).toEqual({
      ran: true,
      outcome: "ambiguous",
    });
  });

  test("an ambiguous outcome tells the operator to STOP, and never to retry", async () => {
    const s = seams({ result: { ...CLEAN_RUN, code: 1 } });
    await activate(s.seams);
    const said = s.lines.join("\n");
    expect(said).toContain("STOP");
    expect(said).toContain("Do not re-run this program");
    expect(said).toContain("do not deploy a rollback");
  });

  test("even a COMPLETED deploy is not called a proved deployment", async () => {
    const s = seams();
    await activate(s.seams);
    expect(s.lines.join("\n")).toContain(
      "a completed deploy command is not a proved deployment",
    );
  });

  test("the deploy is bounded", () => {
    expect(DEPLOY_DEADLINE_MS).toBe(900_000);
  });
});

describe("what the program may not become", () => {
  test("it deploys ONCE per invocation - there is no retry path", async () => {
    for (const result of [
      { ...CLEAN_RUN, code: 1 },
      { ...CLEAN_RUN, timedOut: true },
      { ...CLEAN_RUN, groupEmpty: false },
    ]) {
      const s = seams({ result });
      await activate(s.seams);
      expect(s.calls.length).toBe(1);
    }
  });

  test("it never spawns anything but the committed deploy", async () => {
    const s = seams();
    await activate(s.seams);
    for (const call of s.calls) {
      expect(call.argv[0]).toBe(FLYCTL);
      expect(call.argv[1]).toBe("deploy");
    }
  });
});

describe("the source and the topology, re-read before the spawn", () => {
  // Both were missing entirely in the first version, and both are the class of
  // omission that only shows up live: `fly deploy .` ships the WORKING
  // DIRECTORY, so a dirty tree is an artifact nobody can rebuild from a commit,
  // and `--ha=false` reasons about replacing ONE machine (reviewer finding,
  // 2026-08-12).
  const ONE_STARTED = {
    readable: true,
    count: 1,
    generation: "g1",
    allStarted: true,
  };

  test("A DIRTY SHIPPED PATH STOPS THE DEPLOY", async () => {
    const s = seams();
    const out = await activate({
      ...s.seams,
      git: async (argv: string[]) => ({
        code: 0,
        stdout: argv[0] === "ls-tree" ? HEAD_FILES : " M control-plane/tick.ts",
      }),
      machines: async () => ONE_STARTED,
    });
    expect(out).toEqual({ ran: false, outcome: null });
    expect(s.calls).toEqual([]);
    expect(s.lines.join("\n")).toContain("not reconstructible");
  });

  test("UNREADABLE SOURCE STOPS IT - not readable is not clean", async () => {
    const s = seams();
    const out = await activate({
      ...s.seams,
      git: async () => ({ code: 1, stdout: "" }),
      machines: async () => ONE_STARTED,
    });
    expect(out).toEqual({ ran: false, outcome: null });
    expect(s.calls).toEqual([]);
  });

  test("ANY TOPOLOGY BUT ONE STARTED MACHINE STOPS IT", async () => {
    for (const machines of [
      { readable: true, count: 2, generation: "g", allStarted: true },
      { readable: true, count: 1, generation: "g", allStarted: false },
      { readable: true, count: 0, generation: "g", allStarted: true },
      { readable: false, count: -1, generation: "", allStarted: false },
    ]) {
      const s = seams();
      const out = await activate({
        ...s.seams,
        machines: async () => machines,
      });
      expect({ count: machines.count, ran: out.ran }).toEqual({
        count: machines.count,
        ran: false,
      });
      expect(s.calls).toEqual([]);
    }
  });
});

describe("a throw is an outcome, never an escape", () => {
  const ONE_STARTED = {
    readable: true,
    count: 1,
    generation: "g1",
    allStarted: true,
  };
  const clean = {
    git: async (argv: string[]) => ({
      code: 0,
      stdout: argv[0] === "ls-tree" ? HEAD_FILES : "",
    }),
    machines: async () => ONE_STARTED,
  };

  test("A THROWING PREFLIGHT IS A REFUSAL, and no child runs", async () => {
    const s = seams();
    const out = await activate({
      ...s.seams,
      ...clean,
      preflight: async () => {
        throw new Error("postgresql://owner:pw@host/db unreachable");
      },
    });
    expect(out).toEqual({ ran: false, outcome: null });
    expect(s.calls).toEqual([]);
    // The error object is DISCARDED: it carried a connection string here, and
    // that is exactly why nothing from it may be printed.
    const said = s.lines.join("\n");
    expect(said).toContain("preflight_threw: true");
    expect(said).not.toContain("postgresql://");
    expect(said).not.toContain("unreachable");
  });

  test("a throwing name listing is a refusal", async () => {
    const s = seams();
    const out = await activate({
      ...s.seams,
      ...clean,
      names: async () => {
        throw new Error("fly token rejected");
      },
    });
    expect(out).toEqual({ ran: false, outcome: null });
    expect(s.calls).toEqual([]);
    expect(s.lines.join("\n")).not.toContain("token rejected");
  });

  test("a throwing git or machine read is a refusal", async () => {
    for (const broken of [
      {
        git: async () => {
          throw new Error("git exploded");
        },
        machines: clean.machines,
      },
      {
        git: clean.git,
        machines: async () => {
          throw new Error("fly exploded");
        },
      },
    ]) {
      const s = seams();
      const out = await activate({ ...s.seams, ...broken });
      expect(out).toEqual({ ran: false, outcome: null });
      expect(s.calls).toEqual([]);
      expect(s.lines.join("\n")).not.toContain("exploded");
    }
  });

  test("A THROW AT THE SPAWN IS AMBIGUOUS, because the child may have run", async () => {
    const s = seams();
    const out = await activate({
      ...s.seams,
      ...clean,
      spawn: async () => {
        throw new Error("flyctl vanished");
      },
    });
    // NOT a refusal: the deploy may have happened. This is the case where
    // reporting "nothing ran" would be the dangerous answer.
    expect(out).toEqual({ ran: true, outcome: "ambiguous" });
    const said = s.lines.join("\n");
    expect(said).toContain("deploy_threw: true");
    expect(said).toContain("STOP");
    expect(said).not.toContain("vanished");
  });
});
