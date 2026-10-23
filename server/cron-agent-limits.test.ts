// scheduleExceedsAgent (server/cron-agent-limits.ts): the limits on a schedule
// an ordinary agent made (task c4233bfd). The route and run-start wiring is in
// server/test-support/routes-cronjobs-rest.test.ts ("schedules an ordinary
// agent makes"); this file owns the whole mode table and the folder rules.

import { describe, it, expect, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import {
  scheduleExceedsAgent,
  type ScheduleLimitAgent,
  type ScheduleLimitJob,
} from "./cron-agent-limits.ts";

const root = mkdtempSync(join(tmpdir(), "cron-agent-limits-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const home = join(root, "home");
const sub = join(home, "sub");
// Shares the "home" prefix but is not inside it.
const sibling = join(root, "home2");
const outside = join(root, "outside");
for (const dir of [home, sub, sibling, outside]) mkdirSync(dir);
// Links inside the agent's folder: one points out, one points back in.
const linkOut = join(home, "link-out");
const linkIn = join(home, "link-in");
symlinkSync(outside, linkOut);
symlinkSync(sub, linkIn);
// A link to the agent's folder itself, from outside it.
const homeAlias = join(root, "home-alias");
symlinkSync(home, homeAlias);

// How much a run reaches without asking: 3 full, 2 workspace-write, 1
// read-only, 0 cannot run unattended (it would ask, or a classifier gates it).
type Rank = 0 | 1 | 2 | 3;

const AGENTS: Array<[string, Omit<ScheduleLimitAgent, "cwd">, Rank]> = [
  [
    "claude bypass",
    { agentType: "claude", permissionMode: "bypassPermissions" },
    3,
  ],
  ["claude auto", { agentType: "claude", permissionMode: "auto" }, 0],
  ["claude default", { agentType: "claude", permissionMode: "default" }, 0],
  [
    "claude acceptEdits",
    { agentType: "claude", permissionMode: "acceptEdits" },
    0,
  ],
  [
    "opencode bypass",
    { agentType: "opencode", permissionMode: "bypassPermissions" },
    3,
  ],
  ["opencode default", { agentType: "opencode", permissionMode: "default" }, 0],
  [
    "codex never full",
    {
      agentType: "codex",
      permissionMode: "never",
      codexSandbox: "danger-full-access",
    },
    3,
  ],
  [
    "codex never workspace-write",
    {
      agentType: "codex",
      permissionMode: "never",
      codexSandbox: "workspace-write",
    },
    2,
  ],
  // No sandbox: the Codex adapter's workspace-write default.
  [
    "codex never default sandbox",
    { agentType: "codex", permissionMode: "never" },
    2,
  ],
  [
    "codex never read-only",
    { agentType: "codex", permissionMode: "never", codexSandbox: "read-only" },
    1,
  ],
  [
    "codex on-request full",
    {
      agentType: "codex",
      permissionMode: "on-request",
      codexSandbox: "danger-full-access",
    },
    0,
  ],
  [
    "codex on-failure full",
    {
      agentType: "codex",
      permissionMode: "on-failure",
      codexSandbox: "danger-full-access",
    },
    0,
  ],
  [
    "codex untrusted full",
    {
      agentType: "codex",
      permissionMode: "untrusted",
      codexSandbox: "danger-full-access",
    },
    0,
  ],
];

// A Claude or OpenCode schedule always runs with full access
// (validateCronjobPermissionMode); a Codex one runs in its sandbox.
const JOBS: Array<[string, Omit<ScheduleLimitJob, "cwd">, Rank]> = [
  ["claude job", { agentType: "claude" }, 3],
  ["opencode job", { agentType: "opencode" }, 3],
  [
    "codex full job",
    { agentType: "codex", codexSandbox: "danger-full-access" },
    3,
  ],
  [
    "codex workspace-write job",
    { agentType: "codex", codexSandbox: "workspace-write" },
    2,
  ],
  ["codex default-sandbox job", { agentType: "codex" }, 2],
  ["codex read-only job", { agentType: "codex", codexSandbox: "read-only" }, 1],
];

const refused = (reason: string | null) =>
  typeof reason === "string" && reason.length > 0;

describe("scheduleExceedsAgent: permission mode", () => {
  // Every agent against every job, in the agent's own folder: refused exactly
  // when the job reaches more than the agent. One table, so a row that a
  // wrong rank flips shows by name.
  it("refuses a job that reaches more than the agent, and only that", () => {
    const got: string[] = [];
    const want: string[] = [];
    for (const [agentName, agent, agentRank] of AGENTS) {
      for (const [jobName, job, jobRank] of JOBS) {
        const reason = scheduleExceedsAgent(
          { ...job, cwd: home },
          { ...agent, cwd: home },
        );
        const label = `${agentName} -> ${jobName}`;
        got.push(`${label}: ${refused(reason) ? "refused" : "allowed"}`);
        want.push(`${label}: ${jobRank > agentRank ? "refused" : "allowed"}`);
      }
    }
    expect(got).toEqual(want);
  });
});

describe("scheduleExceedsAgent: folder", () => {
  const agent: ScheduleLimitAgent = {
    agentType: "claude",
    permissionMode: "bypassPermissions",
    cwd: home,
  };
  const job = (cwd: string): ScheduleLimitJob => ({ agentType: "claude", cwd });

  it("allows the agent's folder and a folder inside it, also through a link that stays inside", () => {
    expect(scheduleExceedsAgent(job(home), agent)).toBeNull();
    expect(scheduleExceedsAgent(job(sub), agent)).toBeNull();
    expect(scheduleExceedsAgent(job(`${home}/`), agent)).toBeNull();
    expect(scheduleExceedsAgent(job(linkIn), agent)).toBeNull();
  });

  it("refuses a parent, a sibling that shares the folder's name as a prefix, an unrelated folder and a link inside the folder that points out", () => {
    for (const cwd of [root, sibling, outside, linkOut]) {
      const reason = scheduleExceedsAgent(job(cwd), agent);
      expect([cwd, refused(reason)]).toEqual([cwd, true]);
    }
  });

  it("resolves the agent's folder too: an agent whose folder is a link reaches the real folder", () => {
    const aliased = { ...agent, cwd: homeAlias };
    expect(scheduleExceedsAgent(job(sub), aliased)).toBeNull();
    expect(refused(scheduleExceedsAgent(job(outside), aliased))).toBe(true);
  });

  it("expands ~ on both sides, as every cwd in the office may be written with it", () => {
    expect(
      scheduleExceedsAgent(job(homedir()), { ...agent, cwd: "~" }),
    ).toBeNull();
    expect(
      scheduleExceedsAgent(job("~"), { ...agent, cwd: homedir() }),
    ).toBeNull();
  });

  it("refuses, and does not throw, when a folder does not exist", () => {
    const gone = join(root, "gone");
    expect(refused(scheduleExceedsAgent(job(gone), agent))).toBe(true);
    expect(
      refused(scheduleExceedsAgent(job(sub), { ...agent, cwd: gone })),
    ).toBe(true);
  });

  it("checks the folder for a job the agent's mode allows: a Codex read-only job outside the folder of a full-access agent", () => {
    expect(
      refused(
        scheduleExceedsAgent(
          { agentType: "codex", codexSandbox: "read-only", cwd: outside },
          agent,
        ),
      ),
    ).toBe(true);
  });
});
