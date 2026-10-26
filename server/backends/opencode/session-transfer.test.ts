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
} from "./session-transfer.ts";
import { openCodeSupervisorForEnvironment } from "./supervisor.ts";

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
