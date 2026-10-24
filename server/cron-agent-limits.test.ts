// scheduleExceedsAgent (server/cron-agent-limits.ts): the limits on a schedule
// an ordinary agent made (task c4233bfd). agentMakesSchedules and the wording
// of the mode refusals follow the same table (task 11e311db). The route and run-start wiring is in
// server/test-support/routes-cronjobs-rest.test.ts ("schedules an ordinary
// agent makes"); this file owns the whole mode table and the folder rules.

import { describe, it, expect, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import {
  agentMakesSchedules,
  scheduleExceedsAgent,
  scheduleRunRefusal,
  type ScheduleLimitAgent,
  type ScheduleLimitJob,
} from "./cron-agent-limits.ts";
import { localizeLogParts } from "../shared/i18n/log-message.ts";
import { translatorFor } from "../shared/i18n/translate.ts";
import { SUPPORTED_LANGUAGES } from "../shared/languages.ts";

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
  // No sandbox: runs as CODEX_DEFAULT_SANDBOX, full access (task 375b000e).
  [
    "codex never default sandbox",
    { agentType: "codex", permissionMode: "never" },
    3,
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
  // No sandbox: the run gets full access, so it ranks as the full job.
  ["codex default-sandbox job", { agentType: "codex" }, 3],
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

describe("agentMakesSchedules", () => {
  // An ordinary agent makes a schedule when its mode reaches anything
  // unattended: some job then fits under it. A privileged agent's cron:manage
  // lifts the limits, so it makes schedules in every mode.
  it("is true for an ordinary agent exactly when its mode reaches anything, and for a privileged one in every mode", () => {
    const got: string[] = [];
    const want: string[] = [];
    for (const [agentName, agent, agentRank] of AGENTS) {
      for (const privileged of [false, true]) {
        const label = `${agentName}${privileged ? " privileged" : ""}`;
        got.push(`${label}: ${agentMakesSchedules({ ...agent, privileged })}`);
        want.push(`${label}: ${privileged || agentRank > 0}`);
      }
      // No flag reads as ordinary.
      got.push(`${agentName} unflagged: ${agentMakesSchedules({ ...agent })}`);
      want.push(`${agentName} unflagged: ${agentRank > 0}`);
    }
    expect(got).toEqual(want);
  });
});

describe("the mode refusal wording", () => {
  const lowest: ScheduleLimitAgent = {
    agentType: "claude",
    permissionMode: "auto",
    cwd: home,
  };
  const reason = (job: Omit<ScheduleLimitJob, "cwd">, agent = lowest) =>
    scheduleExceedsAgent({ ...job, cwd: home }, agent);

  // The rule differs by the job's engine (full permissions against no
  // approvals in a sandbox), so the agent reads one reason per rule.
  it("gives the agent one reason for a Claude or OpenCode job and another for a Codex job, apart from the folder reason", () => {
    const claude = reason({ agentType: "claude" });
    const opencode = reason({ agentType: "opencode" });
    const codex = reason({ agentType: "codex", codexSandbox: "read-only" });
    const codexFull = reason({
      agentType: "codex",
      codexSandbox: "danger-full-access",
    });
    const folder = scheduleExceedsAgent(
      { agentType: "claude", cwd: outside },
      { ...lowest, permissionMode: "bypassPermissions" },
    );
    for (const text of [claude, opencode, codex, codexFull, folder])
      expect(refused(text)).toBe(true);
    expect(opencode).toBe(claude);
    expect(codexFull).toBe(codex);
    expect(new Set([claude, codex, folder]).size).toBe(3);
    // The reason is about the job, not about who asks: a Codex agent in a
    // mode that asks reads the same reason for a Claude job.
    expect(
      reason(
        { agentType: "claude" },
        { agentType: "codex", permissionMode: "on-request", cwd: home },
      ),
    ).toBe(claude);
  });

  // The member reads the run refusal. What the maker needs depends on its
  // engine (Bypass, or Never ask for Codex) and, for a Codex maker, on the
  // job's engine (full access, or a sandbox as wide as the job's).
  it("gives the member one run refusal per remedy, worded in every language with the maker's name", () => {
    const name = "MakerSentinel";
    const words = (
      makerType: ScheduleLimitAgent["agentType"],
      job: Omit<ScheduleLimitJob, "cwd">,
      breach: "mode" | "folder" = "mode",
    ) => {
      const message = scheduleRunRefusal(
        breach,
        { name, agentType: makerType },
        { ...job, cwd: home },
      );
      const english = localizeLogParts(translatorFor("en"), [message]);
      for (const { code } of SUPPORTED_LANGUAGES) {
        const text = localizeLogParts(translatorFor(code), [message]);
        expect([code, text?.includes(name)]).toEqual([code, true]);
        if (code !== "en") expect([code, text]).not.toEqual([code, english]);
      }
      return english;
    };
    const claudeJob = { agentType: "claude" as const };
    const codexJob = {
      agentType: "codex" as const,
      codexSandbox: "workspace-write" as const,
    };
    // Needs Bypass: a Claude or OpenCode maker, whatever the job.
    const bypass = words("claude", claudeJob);
    expect(words("claude", codexJob)).toBe(bypass);
    expect(words("opencode", claudeJob)).toBe(bypass);
    expect(words("opencode", codexJob)).toBe(bypass);
    // A Codex maker: full access for a Claude or OpenCode job, a sandbox as
    // wide as the job's for a Codex job.
    const codexFull = words("codex", claudeJob);
    expect(words("codex", { agentType: "opencode" })).toBe(codexFull);
    const codexSandbox = words("codex", codexJob);
    expect(
      words("codex", {
        agentType: "codex",
        codexSandbox: "danger-full-access",
      }),
    ).toBe(codexSandbox);
    const folder = words("codex", codexJob, "folder");
    expect(words("claude", claudeJob, "folder")).toBe(folder);
    expect(new Set([bypass, codexFull, codexSandbox, folder]).size).toBe(4);
  });
});
