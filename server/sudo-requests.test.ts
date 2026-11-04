// The sudo request core (task 43a28eed), with a fake runner: what an agent
// may ask and who may answer, that one run per agent goes at a time, what
// closes the ask, the run row a restart needs, what the agent hears, and that
// the password reaches only the runner.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AskEntry } from "../shared/types.ts";
import type { LogMessage } from "../shared/i18n/log-message.ts";
import {
  askShownToOwnerAsOther,
  askVisibleTo,
  createAskFilePersistence,
  createAskStore,
  type AskChange,
} from "./asks.ts";
import {
  createSudoRequests,
  SUDO_PASSWORD_MAX,
  SUDO_REQUEST_REASON_MAX,
  SUDO_REQUESTS_OPEN_MAX,
  SUDO_WRONG_PASSWORD_MAX,
  type SudoOutcome,
} from "./sudo-requests.ts";
import type { SudoProbe, SudoRunResult, SudoStart } from "./sudo-runner.ts";
import { createSudoRunStore, type SudoRunStore } from "./sudo-run-store.ts";

const PASSWORD = "Mark3r-pa55word-43a28eed";
const COMMAND = "apt-get install -y jq";
const REASON = "To parse the API output.";
const NOW = 1_780_000_000_000;

const MEMBERS: Record<string, string> = {
  Nil: "u-owner",
  Dana: "u-owner2",
  Alice: "u-alice",
  Eve: "u-eve",
};
// a1 and a3 belong to owners, a2 to a member who is no owner; a4 reads text
// from strangers (below Standard).
const AGENTS: Record<string, { manager: string; cwd: string }> = {
  a1: { manager: "u-owner", cwd: "/work/a1" },
  a2: { manager: "u-alice", cwd: "/work/a2" },
  a3: { manager: "u-owner", cwd: "/work/a3" },
  a4: { manager: "u-owner", cwd: "/work/a4" },
};

type Report = {
  agentId: string;
  requestId: string;
  outcome: SudoOutcome;
  line: LogMessage;
  member: string;
  notice: string | null;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const RESULT: SudoRunResult = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  durationMs: 1234,
  output: "Setting up jq (1.7.1-3) ...\n",
};

const roots: string[] = [];
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  // Bun ends the server on a rejection no one handles.
  expect(unhandled).toEqual([]);
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "isomux-sudo-requests-"));
  roots.push(root);
  const asksPath = join(root, "asks.json");
  const runsPath = join(root, "sudo-runs.json");
  const owners = new Set(["u-owner", "u-owner2"]);
  const limited = new Set(["a4"]);
  const audience = {
    isOfficeOwner: (userId: string) => owners.has(userId),
    agentRoomId: (agentId: string) =>
      Object.hasOwn(AGENTS, agentId) ? "r1" : null,
    canSeeRoom: (userId: string) => userId !== "u-eve",
  };
  const events: AskChange[] = [];
  const reports: Report[] = [];
  const control = {
    probe: "available" as SudoProbe,
    // What start answers next; by default a run that ends when the test
    // resolves its done.
    next: [] as (() => Promise<SudoStart>)[],
    reportThrows: false,
    removeThrows: false,
  };
  const starts: { command: string; cwd: string; password: string }[] = [];
  const done: ReturnType<typeof deferred<SudoRunResult>>[] = [];
  let probes = 0;

  function boot() {
    const asks = createAskStore({
      persistence: createAskFilePersistence(asksPath),
      onChange: (change) => events.push(change),
    });
    const store = createSudoRunStore(runsPath);
    const runs: SudoRunStore = {
      add: (row) => store.add(row),
      remove: (requestId) => {
        if (control.removeThrows) throw new Error("disk full");
        store.remove(requestId);
      },
      list: () => store.list(),
    };
    const requests = createSudoRequests({
      asks,
      audience,
      agentUserId: (agentId) =>
        Object.hasOwn(AGENTS, agentId) ? AGENTS[agentId].manager : undefined,
      agentCwd: (agentId) =>
        Object.hasOwn(AGENTS, agentId) ? AGENTS[agentId].cwd : null,
      agentLimited: (agentId) => limited.has(agentId),
      isOfficeOwner: (userId) => owners.has(userId),
      memberByName: (name) => {
        const found = Object.keys(MEMBERS).find(
          (m) => m.toLowerCase() === name.toLowerCase(),
        );
        return found ? { id: MEMBERS[found], name: found } : null;
      },
      memberName: (userId) =>
        Object.keys(MEMBERS).find((m) => MEMBERS[m] === userId) ?? null,
      probe: async () => {
        probes++;
        return control.probe;
      },
      start: (opts) => {
        starts.push({
          command: opts.command,
          cwd: opts.cwd,
          password: opts.password,
        });
        const next = control.next.shift();
        if (next) return next();
        const d = deferred<SudoRunResult>();
        done.push(d);
        return Promise.resolve({ kind: "started", done: d.promise });
      },
      runs,
      report: (agentId, requestId, outcome, line, member, notice) => {
        reports.push({ agentId, requestId, outcome, line, member, notice });
        if (control.reportThrows) throw new Error("agent gone");
      },
      now: () => NOW,
    });
    return { asks, requests, runs: store };
  }
  const first = boot();
  return {
    ...first,
    boot,
    asksPath,
    runsPath,
    owners,
    audience,
    events,
    reports,
    control,
    starts,
    done,
    probes: () => probes,
  };
}

type T = ReturnType<typeof setup>;
type Result = {
  ok: boolean;
  status?: number;
  code?: string;
  detail?: Record<string, unknown>;
};
const failure = (r: Result) => (r.ok ? "ok" : `${r.status} ${r.code}`);
const status = (r: Result) => (r.ok ? 200 : r.status);
const outcomes = (t: T) =>
  t.reports.map((r) => [r.agentId, r.outcome, r.member]);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function open(
  t: T,
  agentId = "a1",
  body: Record<string, unknown> = { command: COMMAND, reason: REASON },
): Promise<string> {
  const r = await t.requests.open(agentId, body);
  if (!r.ok) throw new Error(`open refused: ${r.status} ${r.code}`);
  return r.requestId;
}

// `password` absent sends PASSWORD; present (even undefined) sends it as is.
const run = (
  t: T,
  requestId: string,
  opts: { user?: string; agent?: string; password?: unknown } = {},
) =>
  t.requests.run(opts.user ?? "u-owner", opts.agent ?? "a1", requestId, {
    password: "password" in opts ? opts.password : PASSWORD,
  });

const refused =
  (reason = "sudo: 1 incorrect password attempt") =>
  () =>
    Promise.resolve<SudoStart>({ kind: "auth_failed", reason });

describe("the agent's request", () => {
  it("opens an ask for the manager with the command, the agent's cwd and the reason", async () => {
    const t = setup();
    const requestId = await open(t);
    const entries = t.asks.listAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      agentId: "a1",
      memberUserId: "u-owner",
      prompt: REASON,
      sudo: { requestId, command: COMMAND, cwd: "/work/a1" },
    });
    // A sudo ask is answered by its form, never by an option or a link.
    expect(entries[0].options).toBeUndefined();
    expect(entries[0].link).toBeUndefined();
    expect(entries[0].secret).toBeUndefined();
  });

  it("goes to another owner the agent names", async () => {
    const t = setup();
    await open(t, "a1", { command: COMMAND, reason: REASON, member: "dana" });
    expect(t.asks.listAll()[0].memberUserId).toBe("u-owner2");
  });

  it("only an office owner answers: the box account's password is theirs", async () => {
    const t = setup();
    // The manager of a2 is no owner, and neither is a named member.
    const byManager = await t.requests.open("a2", {
      command: COMMAND,
      reason: REASON,
    });
    const byName = await t.requests.open("a1", {
      command: COMMAND,
      reason: REASON,
      member: "Alice",
    });
    const unknown = await t.requests.open("a1", {
      command: COMMAND,
      reason: REASON,
      member: "Zed",
    });
    expect([byManager, byName, unknown].map(failure)).toEqual([
      "403 member_not_allowed",
      "403 member_not_allowed",
      "422 unknown_member",
    ]);
    expect(t.asks.listAll()).toEqual([]);
  });

  it("an agent below Standard may not ask", async () => {
    const t = setup();
    const r = await t.requests.open("a4", { command: COMMAND, reason: REASON });
    expect(failure(r)).toBe("403 agent_limited");
    expect(t.asks.listAll()).toEqual([]);
  });

  it("refuses a command the card could not show as it runs", async () => {
    const t = setup();
    for (const [command, reason] of [
      ["sudo apt-get update", "leading_sudo"],
      ["apt-get update\nrm -rf /", "forbidden_character"],
      ["echo \u202eevil", "forbidden_character"],
      ["echo a\u200bb", "forbidden_character"],
      ["x".repeat(2001), "too_long"],
      ["", "missing"],
    ] as const) {
      const r = await t.requests.open("a1", { command, reason: REASON });
      expect({
        command,
        result: failure(r),
        reason: r.ok ? null : r.detail?.reason,
      }).toEqual({
        command,
        result: "400 invalid_command",
        reason,
      });
    }
    expect(t.asks.listAll()).toEqual([]);
  });

  it("needs a reason the card can show", async () => {
    const t = setup();
    for (const reason of [
      undefined,
      "",
      "x".repeat(SUDO_REQUEST_REASON_MAX + 1),
    ]) {
      const r = await t.requests.open("a1", { command: COMMAND, reason });
      expect(failure(r)).toBe("400 invalid_reason");
    }
    await open(t, "a1", {
      command: COMMAND,
      reason: "x".repeat(SUDO_REQUEST_REASON_MAX),
    });
  });

  it("is not offered where the account has no sudo, or needs no password", async () => {
    const t = setup();
    t.control.probe = "unavailable";
    const none = await t.requests.open("a1", {
      command: COMMAND,
      reason: REASON,
    });
    t.control.probe = "no_password_needed";
    const free = await t.requests.open("a1", {
      command: COMMAND,
      reason: REASON,
    });
    expect([none, free].map(failure)).toEqual([
      "409 sudo_unavailable",
      "409 no_password_needed",
    ]);
    expect(t.asks.listAll()).toEqual([]);
  });

  it(`keeps at most ${SUDO_REQUESTS_OPEN_MAX} open requests per agent`, async () => {
    const t = setup();
    for (let i = 0; i < SUDO_REQUESTS_OPEN_MAX; i++) await open(t);
    const over = await t.requests.open("a1", {
      command: COMMAND,
      reason: REASON,
    });
    expect(failure(over)).toBe("429 too_many_requests");
    // Another agent's requests are its own.
    await open(t, "a3");
  });

  it("is seen and answered by its member only, not shown to other owners", async () => {
    const t = setup();
    await open(t);
    const [entry] = t.asks.listAll();
    expect(askVisibleTo(entry, "u-owner", t.audience)).toBe(true);
    expect(askVisibleTo(entry, "u-owner2", t.audience)).toBe(false);
    expect(askShownToOwnerAsOther(entry, "u-owner2", t.audience)).toBe(false);
  });

  it("survives a restart as an open ask", async () => {
    const t = setup();
    const requestId = await open(t);
    const again = t.boot();
    expect(again.asks.listAll()[0]?.sudo).toEqual({
      requestId,
      command: COMMAND,
      cwd: "/work/a1",
    });
  });

  it("the asks file drops a sudo ask with a bad shape", async () => {
    const t = setup();
    await open(t);
    const [good] = JSON.parse(readFileSync(t.asksPath, "utf8")) as AskEntry[];
    const bad: [string, Record<string, unknown>][] = [
      ["no command", { ...good, sudo: { ...good.sudo, command: undefined } }],
      ["no cwd", { ...good, sudo: { ...good.sudo, cwd: 7 } }],
      ["no member", { ...good, memberUserId: undefined }],
      ["options", { ...good, options: ["Run", "Decline"] }],
    ];
    for (const [label, entry] of bad) {
      writeFileSync(t.asksPath, JSON.stringify([entry]));
      const { asks } = t.boot();
      let listed: number;
      try {
        listed = asks.listAll().length;
      } catch {
        listed = 0;
      }
      expect({ label, listed }).toEqual({ label, listed: 0 });
    }
  });
});

describe("the owner runs it", () => {
  it("starts the command once with the password, closes the ask and keeps a run row", async () => {
    const t = setup();
    const requestId = await open(t);
    const r = await run(t, requestId);
    expect(failure(r)).toBe("ok");
    expect(t.starts).toEqual([
      { command: COMMAND, cwd: "/work/a1", password: PASSWORD },
    ]);
    expect(t.asks.listAll()).toEqual([]);
    expect(t.runs.list()).toEqual([
      {
        requestId,
        agentId: "a1",
        command: COMMAND,
        startedAt: NOW,
        memberUserId: "u-owner",
      },
    ]);
    // "started" is a chat line; the agent hears at the end.
    expect(t.reports.map((x) => [x.outcome, x.member, x.notice])).toEqual([
      ["started", "u-owner", null],
    ]);
  });

  it("tells the agent the exit and the output when the run ends, and drops the row", async () => {
    const t = setup();
    const requestId = await open(t);
    await run(t, requestId);
    t.done[0].resolve({
      ...RESULT,
      exitCode: 2,
      output: "E: Unable to locate package",
    });
    await flush();
    expect(outcomes(t)).toEqual([
      ["a1", "started", "u-owner"],
      ["a1", "finished", "u-owner"],
    ]);
    const notice = t.reports[1].notice ?? "";
    expect(notice).toContain("E: Unable to locate package");
    expect(notice).toMatch(/\b2\b/);
    expect(t.reports[1].requestId).toBe(requestId);
    expect(t.runs.list()).toEqual([]);
  });

  it("a timed-out run reads differently from one that ended", async () => {
    const t = setup();
    await run(t, await open(t));
    t.done[0].resolve({
      ...RESULT,
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
    });
    await flush();
    await run(t, await open(t));
    t.done[1].resolve({
      ...RESULT,
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
    });
    await flush();
    const notices = t.reports
      .filter((x) => x.outcome === "finished")
      .map((x) => x.notice);
    expect(notices).toHaveLength(2);
    expect(notices[0]).not.toBe(notices[1]);
  });

  it("the password is one line of at most SUDO_PASSWORD_MAX characters", async () => {
    const t = setup();
    const requestId = await open(t);
    // sudo -S reads a line per attempt and hands the rest of stdin to the
    // command, which could echo it to the agent.
    for (const password of [
      undefined,
      "",
      7,
      "wrong\nright",
      "pass\rword",
      "pass\0word",
      "x".repeat(SUDO_PASSWORD_MAX + 1),
    ]) {
      const r = await run(t, requestId, { password });
      expect({ password, result: failure(r) }).toEqual({
        password,
        result: "400 invalid_password",
      });
    }
    expect(t.starts).toEqual([]);
    expect(t.asks.listAll()).toHaveLength(1);
    expect(
      failure(
        await run(t, requestId, { password: "x".repeat(SUDO_PASSWORD_MAX) }),
      ),
    ).toBe("ok");
  });

  it("no one but the ask's member runs or declines it", async () => {
    const t = setup();
    const requestId = await open(t);
    const results = [
      await run(t, requestId, { user: "u-owner2" }),
      await run(t, requestId, { user: "u-alice" }),
      await t.requests.run(null, "a1", requestId, { password: PASSWORD }),
      t.requests.decline("u-owner2", "a1", requestId),
    ];
    expect(results.map(status)).toEqual([403, 403, 403, 403]);
    // The request is the agent's: another agent id finds nothing.
    expect(failure(await run(t, requestId, { agent: "a3" }))).toBe(
      "404 not_found",
    );
    expect(failure(await run(t, "no-such-request"))).toBe("404 not_found");
    expect(t.starts).toEqual([]);
    expect(t.asks.listAll()).toHaveLength(1);
  });

  it("an owner who lost the role since the ask opened no longer runs it", async () => {
    const t = setup();
    const requestId = await open(t);
    t.owners.delete("u-owner");
    expect(status(await run(t, requestId))).toBe(403);
    expect(t.starts).toEqual([]);
  });

  it("a room-limited audience does not answer", async () => {
    const t = setup();
    const requestId = await open(t);
    const roomLimited = {
      ...t.audience,
      isOfficeOwner: () => false,
      canSeeRoom: () => false,
    };
    const r = await t.requests.run(
      "u-owner",
      "a1",
      requestId,
      { password: PASSWORD },
      roomLimited,
    );
    expect(status(r)).toBe(403);
    expect(t.starts).toEqual([]);
  });
});

describe("one run per agent", () => {
  it("a second run while sudo checks the password is refused, and start runs once", async () => {
    const t = setup();
    const requestId = await open(t);
    const other = await open(t);
    const auth = deferred<SudoStart>();
    t.control.next.push(() => auth.promise);
    // No await between the calls: the lock is taken before the first await.
    const first = run(t, requestId);
    const same = run(t, requestId, { password: "another-try" });
    const second = run(t, other);
    const decline = t.requests.decline("u-owner", "a1", requestId);
    expect(failure(await same)).toBe("409 run_in_progress");
    expect(failure(await second)).toBe("409 run_in_progress");
    expect(failure(decline)).toBe("409 run_in_progress");
    const d = deferred<SudoRunResult>();
    auth.resolve({ kind: "started", done: d.promise });
    expect(failure(await first)).toBe("ok");
    expect(t.starts).toHaveLength(1);
    // The lock holds until the run ends.
    expect(failure(await run(t, other))).toBe("409 run_in_progress");
    d.resolve(RESULT);
    await flush();
    expect(failure(await run(t, other))).toBe("ok");
  });

  it("another agent's run is not held by it", async () => {
    const t = setup();
    await run(t, await open(t));
    expect(failure(await run(t, await open(t, "a3"), { agent: "a3" }))).toBe(
      "ok",
    );
  });

  it("a run whose done rejects still frees the agent and drops the row", async () => {
    const t = setup();
    await run(t, await open(t));
    t.done[0].reject(new Error("spawn lost"));
    await flush();
    expect(t.runs.list()).toEqual([]);
    // The agent still hears that the run ended, with an unknown result.
    const lost = t.reports.find((x) => x.outcome === "finished");
    expect(lost?.notice).toContain(COMMAND);
    expect(failure(await run(t, await open(t)))).toBe("ok");
  });

  it("a throw in report or in the run store frees the agent and crashes nothing", async () => {
    const t = setup();
    await run(t, await open(t));
    t.control.reportThrows = true;
    t.done[0].resolve(RESULT);
    await flush();
    expect(t.runs.list()).toEqual([]);
    t.control.reportThrows = false;
    expect(failure(await run(t, await open(t)))).toBe("ok");
    t.control.removeThrows = true;
    t.done[1].resolve(RESULT);
    await flush();
    t.control.removeThrows = false;
    // The agent still hears its result.
    expect(t.reports.filter((x) => x.outcome === "finished")).toHaveLength(2);
    expect(failure(await run(t, await open(t)))).toBe("ok");
  });
});

describe("sudo does not start the command", () => {
  it("answers with sudo's reason and the attempts left; the ask stays open and the agent is free", async () => {
    const t = setup();
    const requestId = await open(t);
    t.control.next.push(refused());
    const r = await run(t, requestId, { password: "wrong" });
    expect(failure(r)).toBe("422 not_started");
    expect(r.ok ? null : r.detail).toEqual({
      reason: "sudo: 1 incorrect password attempt",
      attemptsLeft: SUDO_WRONG_PASSWORD_MAX - 1,
    });
    expect(t.asks.listAll()).toHaveLength(1);
    expect(t.runs.list()).toEqual([]);
    expect(t.reports).toEqual([]);
    expect(failure(await run(t, requestId))).toBe("ok");
  });

  it(`closes the ask after ${SUDO_WRONG_PASSWORD_MAX} attempts`, async () => {
    const t = setup();
    const requestId = await open(t);
    const left: unknown[] = [];
    for (let i = 0; i < SUDO_WRONG_PASSWORD_MAX; i++) {
      t.control.next.push(refused());
      const r = await run(t, requestId, { password: `wrong-${i}` });
      expect(failure(r)).toBe("422 not_started");
      left.push(r.ok ? null : r.detail?.attemptsLeft);
    }
    expect(left).toEqual([2, 1, 0]);
    expect(t.asks.listAll()).toEqual([]);
    expect(outcomes(t)).toEqual([["a1", "locked_out", "u-owner"]]);
    expect(failure(await run(t, requestId))).toBe("404 not_found");
  });

  it("a start that throws: 500 run_failed, the ask stays open, no row, the agent is free", async () => {
    const t = setup();
    const requestId = await open(t);
    t.control.next.push(() => Promise.reject(new Error("ENOENT: cwd")));
    const r = await run(t, requestId);
    expect(failure(r)).toBe("500 run_failed");
    expect(t.asks.listAll()).toHaveLength(1);
    expect(t.runs.list()).toEqual([]);
    expect(failure(await run(t, requestId))).toBe("ok");
  });

  it("the run row is written only once sudo started the command", async () => {
    const t = setup();
    const requestId = await open(t);
    const auth = deferred<SudoStart>();
    t.control.next.push(() => auth.promise);
    const pending = run(t, requestId);
    await flush();
    // During auth: no row, so a restart now tells the agent nothing false.
    expect(t.runs.list()).toEqual([]);
    auth.resolve({ kind: "started", done: new Promise(() => {}) });
    await pending;
    expect(t.runs.list().map((row) => row.requestId)).toEqual([requestId]);
  });
});

describe("the owner declines", () => {
  it("closes the ask and tells the agent; nothing runs", async () => {
    const t = setup();
    const requestId = await open(t);
    expect(failure(t.requests.decline("u-owner", "a1", requestId))).toBe("ok");
    expect(t.asks.listAll()).toEqual([]);
    expect(t.starts).toEqual([]);
    expect(outcomes(t)).toEqual([["a1", "declined", "u-owner"]]);
    expect(t.reports[0].requestId).toBe(requestId);
  });
});

describe("a restart during a run", () => {
  it("tells the agent the result is unknown and drops the row", async () => {
    const t = setup();
    const requestId = await open(t);
    await run(t, requestId);
    t.reports.length = 0;
    // The server stops before done: the next boot finds the row.
    const again = t.boot();
    again.requests.recover();
    expect(outcomes(t)).toEqual([["a1", "restarted", "u-owner"]]);
    expect(t.reports[0].requestId).toBe(requestId);
    expect(t.reports[0].notice).toContain(COMMAND);
    expect(again.runs.list()).toEqual([]);
  });

  it("a report that throws stops neither the boot nor the other rows", async () => {
    const t = setup();
    await run(t, await open(t));
    await run(t, await open(t, "a3"), { agent: "a3" });
    t.reports.length = 0;
    t.control.reportThrows = true;
    const again = t.boot();
    expect(() => again.requests.recover()).not.toThrow();
    expect(t.reports.map((x) => x.agentId).sort()).toEqual(["a1", "a3"]);
    expect(again.runs.list()).toEqual([]);
  });
});

describe("the run store", () => {
  it("keeps rows across instances in a file only the account reads", () => {
    const root = mkdtempSync(join(tmpdir(), "isomux-sudo-runs-"));
    roots.push(root);
    const path = join(root, "sudo-runs.json");
    const row = {
      requestId: "q1",
      agentId: "a1",
      command: COMMAND,
      startedAt: NOW,
      memberUserId: "u-owner",
    };
    createSudoRunStore(path).add(row);
    createSudoRunStore(path).add({ ...row, requestId: "q2" });
    expect(
      createSudoRunStore(path)
        .list()
        .map((r) => r.requestId),
    ).toEqual(["q1", "q2"]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    createSudoRunStore(path).remove("q1");
    expect(createSudoRunStore(path).list()).toEqual([
      { ...row, requestId: "q2" },
    ]);
  });
});

describe("the password goes to the runner only", () => {
  it("is in no answer, ask, ask event, report, run row or console line", async () => {
    const t = setup();
    const lines: unknown[][] = [];
    const saved = { ...console };
    for (const key of ["log", "error", "warn", "info", "debug"] as const)
      console[key] = (...args: unknown[]) => lines.push(args);
    const results: unknown[] = [];
    try {
      const a = await open(t);
      t.control.next.push(refused());
      results.push(await run(t, a));
      results.push(await run(t, a, { password: `${PASSWORD}\n` }));
      results.push(await run(t, a, { user: "u-owner2" }));
      results.push(await run(t, a));
      const rows = JSON.stringify(t.runs.list());
      t.done[0].resolve(RESULT);
      await flush();
      const b = await open(t);
      t.control.next.push(() => Promise.reject(new Error(`boom ${PASSWORD}`)));
      results.push(await run(t, b));
      results.push(t.requests.decline("u-owner", "a1", b));
      const everything = JSON.stringify({
        results,
        rows,
        events: t.events,
        reports: t.reports,
        asks: readFileSync(t.asksPath, "utf8"),
        lines,
      });
      expect(everything).not.toContain(PASSWORD);
    } finally {
      Object.assign(console, saved);
    }
    // It did reach the runner.
    expect(t.starts.map((s) => s.password)).toContain(PASSWORD);
  });
});
