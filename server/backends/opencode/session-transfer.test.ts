// Moving a stored OpenCode session from an older profile into the owner's
// profile (task df0e7b51), through a stand-in for OpenCode's own export and
// import: the move reads the source only when it is v2-ready, never throws,
// and the backend recovers a session only from a profile that stores it
// durable.

import { afterEach, describe, expect, it } from "bun:test";

import { createOpenCodeBackend } from "./adapter.ts";
import {
  cleanUpProfileFixtures,
  fakeCli,
  profile,
  v1OnlyProfile,
} from "./profile-fixture.ts";
import { openCodeProfilePaths } from "./profile-paths.ts";
import {
  findOpenCodeSessionProfile,
  moveOpenCodeSession,
  moveOpenCodeSessionAcross,
  setOpenCodeSessionCliForTests,
  type OpenCodeSessionSides,
} from "./session-transfer.ts";
import {
  openCodeSupervisorForEnvironment,
  type OpenCodeSupervisor,
} from "./supervisor.ts";
import { openCodeProfileKey } from "./access.ts";
import type { AgentAccess } from "../../../shared/agent-access.ts";

afterEach(cleanUpProfileFixtures);

const target = (key: string) =>
  openCodeSupervisorForEnvironment(key, {}, "rev", []);

describe("moveOpenCodeSession", () => {
  it("exports from the source profile and imports that export into the target's server", async () => {
    const from = profile("source-key", { ses_a: "durable" });
    const cli = fakeCli();
    const result = await moveOpenCodeSession({
      sessionId: "ses_a",
      fromProfileDir: from,
      target: target("target-key"),
      targetEnvironmentKey: "target-key",
    });
    expect(result).toBe("moved");
    expect(cli.exports).toEqual([{ profileDir: from, sessionId: "ses_a" }]);
    expect(cli.imports).toHaveLength(1);
    expect(cli.imports[0].profileDir).toBe(
      openCodeProfilePaths("target-key").profileDir,
    );
    expect(JSON.parse(cli.imports[0].exported)).toEqual({
      info: { id: "ses_a" },
      from,
    });
  });

  // MUTANT: run the export on a source with no ready marker. OpenCode would
  // read an empty or half-imported v2 database there.
  it("does not touch a source that is not v2-ready", async () => {
    const from = v1OnlyProfile("source-key");
    const cli = fakeCli();
    const result = await moveOpenCodeSession({
      sessionId: "ses_a",
      fromProfileDir: from,
      target: target("target-key"),
      targetEnvironmentKey: "target-key",
    });
    expect(result).toBe("source-not-v2");
    expect(cli.exports).toEqual([]);
    expect(cli.imports).toEqual([]);
  });

  for (const step of ["export", "import"] as const)
    it(`reports a failed ${step} as failed and does not throw`, async () => {
      const from = profile("source-key", { ses_a: "durable" });
      const fail = async () => {
        throw new Error(`${step} exited 1`);
      };
      const cli = fakeCli(
        step === "export" ? { exportSession: fail } : { importSession: fail },
      );
      const result = await moveOpenCodeSession({
        sessionId: "ses_a",
        fromProfileDir: from,
        target: target("target-key"),
        targetEnvironmentKey: "target-key",
      });
      expect(result).toBe("failed");
      if (step === "export") expect(cli.imports).toEqual([]);
    });
});

describe("findOpenCodeSessionProfile", () => {
  it("finds the other profile that stores the session durable", () => {
    profile("own-key", { ses_a: "durable" });
    profile("empty-key", { ses_a: "empty" });
    const holder = profile("holder-key", { ses_a: "durable" });
    profile("other-key", { ses_b: "durable" });
    expect(findOpenCodeSessionProfile("ses_a", "own-key")).toBe(holder);
  });

  // MUTANT: count the excepted profile, or an empty copy, as a source.
  it("finds none when only the excepted profile or an empty copy holds it", () => {
    profile("own-key", { ses_a: "durable" });
    profile("empty-key", { ses_a: "empty" });
    expect(findOpenCodeSessionProfile("ses_a", "own-key")).toBeNull();
    expect(findOpenCodeSessionProfile("ses_none", "own-key")).toBeNull();
  });
});

describe("OpenCode recoverStoredSession", () => {
  const opts = (environmentKey: string) => ({
    cwd: "/work/repo",
    env: {},
    environmentKey,
    environmentRevision: "rev",
    mcpServers: [],
  });

  it("moves a session from another profile into the owner's profile", async () => {
    const holder = profile("old-key", { ses_a: "durable" });
    profile("owner-key");
    const cli = fakeCli();
    const backend = createOpenCodeBackend();
    expect(
      await backend.recoverStoredSession!("ses_a", opts("owner-key")),
    ).toBe(true);
    expect(cli.exports).toEqual([{ profileDir: holder, sessionId: "ses_a" }]);
    expect(cli.imports.map((call) => call.profileDir)).toEqual([
      openCodeProfilePaths("owner-key").profileDir,
    ]);
  });

  it("reports no recovery when no other profile stores the session, or the move fails", async () => {
    profile("owner-key");
    profile("empty-key", { ses_a: "empty" });
    const cli = fakeCli();
    const backend = createOpenCodeBackend();
    expect(
      await backend.recoverStoredSession!("ses_a", opts("owner-key")),
    ).toBe(false);
    expect(cli.imports).toEqual([]);

    profile("old-key", { ses_b: "durable" });
    fakeCli({
      importSession: async () => {
        throw new Error("import exited 1");
      },
    });
    expect(
      await backend.recoverStoredSession!("ses_b", opts("owner-key")),
    ).toBe(false);
  });
});

// Task e77304b1 (merge C2): a session crosses the Standard line between the
// member's server and the member's limited server. One copy exists at a
// time: 2.1.4 answers an import of a session the target already holds with
// "Session already exists" and exit 0, keeping its stale copy (probe 1c).
describe("moveOpenCodeSessionAcross", () => {
  type Side = OpenCodeSupervisor;
  const side = (profileDir: string) => ({ profileDir }) as unknown as Side;

  function world(start: { from?: string[]; to?: string[] }) {
    const from = side("/profiles/from");
    const to = side("/profiles/to");
    const held = new Map<Side, string[]>();
    if (start.from) held.set(from, start.from);
    if (start.to) held.set(to, start.to);
    const steps: string[] = [];
    const name = (s: Side) => (s === from ? "from" : "to");
    const sides: OpenCodeSessionSides = {
      messageIds: async (s, sessionId) => {
        expect(sessionId).toBe("ses_x");
        return held.get(s) ? [...held.get(s)!] : null;
      },
      deleteSession: async (s) => {
        steps.push(`delete ${name(s)}`);
        held.delete(s);
      },
    };
    const byDir = (dir: string) => (dir === "/profiles/from" ? from : to);
    const cli = fakeCli({
      exportSession: async (profileDir, sessionId) => {
        steps.push(`export ${name(byDir(profileDir))}`);
        return JSON.stringify({
          id: sessionId,
          ids: held.get(byDir(profileDir)),
        });
      },
      importSession: async (target, exported) => {
        steps.push(`import ${name(target)}`);
        // As 2.1.4: a session the target holds stays as it is.
        if (held.has(target)) return;
        held.set(target, (JSON.parse(exported) as { ids: string[] }).ids);
      },
    });
    return { from, to, held, steps, sides, cli };
  }

  const move = (w: ReturnType<typeof world>) =>
    moveOpenCodeSessionAcross({
      sessionId: "ses_x",
      from: w.from,
      to: w.to,
      sides: w.sides,
    });

  it("leaves things alone when the other side does not hold the session", async () => {
    const w = world({ to: ["m1"] });
    expect(await move(w)).toBe("absent");
    expect(w.steps).toEqual([]);
    expect(w.held.get(w.to)).toEqual(["m1"]);
  });

  it("moves the session, checks the copy, then deletes the source", async () => {
    const w = world({ from: ["m1", "m2"] });
    expect(await move(w)).toBe("moved");
    expect(w.steps).toEqual(["export from", "import to", "delete from"]);
    expect(w.held.get(w.to)).toEqual(["m1", "m2"]);
    expect(w.held.has(w.from)).toBe(false);
  });

  // Down, up, down again: the copy left on the target is stale.
  it("deletes a leftover copy on the target before the import", async () => {
    const w = world({ from: ["m1", "m2", "m3"], to: ["m1"] });
    expect(await move(w)).toBe("moved");
    expect(w.steps).toEqual([
      "delete to",
      "export from",
      "import to",
      "delete from",
    ]);
    expect(w.held.get(w.to)).toEqual(["m1", "m2", "m3"]);
    expect(w.held.has(w.from)).toBe(false);
  });

  // Each failure throws, so the start is refused, and the source keeps the
  // latest history: it is never deleted before the copy is checked.
  it("throws and keeps the source when a step fails or the copy differs", async () => {
    const cases: [string, (w: ReturnType<typeof world>) => void][] = [
      [
        "the import fails",
        (w) => {
          w.cli.importSession = async () => {
            throw new Error("import exited 1");
          };
          setOpenCodeSessionCliForTests(w.cli);
        },
      ],
      [
        "the import drops a message",
        (w) => {
          const held = w.held;
          w.cli.importSession = async (target) => {
            held.set(target, ["m1"]);
          };
          setOpenCodeSessionCliForTests(w.cli);
        },
      ],
      [
        "the export fails",
        (w) => {
          w.cli.exportSession = async () => {
            throw new Error("export exited 1");
          };
          setOpenCodeSessionCliForTests(w.cli);
        },
      ],
      [
        "the leftover cannot be deleted",
        (w) => {
          w.held.set(w.to, ["m1"]);
          w.sides.deleteSession = async () => {
            throw new Error("delete 500");
          };
        },
      ],
    ];
    for (const [label, arrange] of cases) {
      const w = world({ from: ["m1", "m2"] });
      arrange(w);
      const error = await move(w).then(
        () => null,
        (e: unknown) => e,
      );
      expect({ label, threw: error instanceof Error }).toEqual({
        label,
        threw: true,
      });
      expect({ label, source: w.held.get(w.from) }).toEqual({
        label,
        source: ["m1", "m2"],
      });
    }
  });

  it("throws when the source copy cannot be deleted after the move", async () => {
    const w = world({ from: ["m1", "m2"] });
    w.sides.deleteSession = async (s) => {
      if (s === w.from) throw new Error("delete 500");
    };
    const error = await move(w).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
  });
});

// The agent manager asks whether a session can resume with the agent's
// stop: a session on the other side of the Standard line counts, and the
// start moves it. Without this, an access change drops the session.
describe("OpenCode stored sessions across the Standard line", () => {
  const opts = (access: AgentAccess | undefined) => ({
    cwd: "/work/repo",
    env: {},
    environmentKey: "member-key",
    environmentRevision: "rev",
    mcpServers: [],
    ...(access ? { access } : {}),
  });

  it("finds a session on either side, and not one neither side holds", () => {
    const backend = createOpenCodeBackend();
    profile(openCodeProfileKey("member-key", "standard"), {
      ses_std: "durable",
    });
    profile(openCodeProfileKey("member-key", "office"), { ses_low: "durable" });
    for (const access of [
      undefined,
      "standard",
      "chat",
      "office",
      "folder",
      "web",
    ] as const)
      for (const id of ["ses_std", "ses_low"]) {
        expect({
          access,
          id,
          state: backend.inspectStoredSession(id, opts(access)),
          resumable: backend.checkSessionResumable(id, opts(access)),
        }).toEqual({ access, id, state: "durable", resumable: null });
      }
    expect(
      backend.checkSessionResumable("ses_none", opts("office")),
    ).not.toBeNull();
  });
});
