// An isolated member's session files through their runner
// (internal-docs/member-os-user-design.md 2.3; slice 1c-ii-b of task
// b94dfd25): the cwd change of a Claude agent (moveClaudeSessionFileOnHost
// and the claude-cwd-move entry) and the OpenCode recovery between the
// member's two profiles (findOpenCodeSessionProfileOnHost). The properties:
// a member's session files move in their runner, under their own root, and
// the sync path still refuses their env; the office's move stays in
// process; a member's OpenCode session is looked up only in their other
// profile, through their host; an office key never reaches a member host.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  claudeProjectDir,
  moveClaudeSessionFile,
  moveClaudeSessionFileOnHost,
} from "../cwd-utils.ts";
import { moveClaudeCwd } from "../member-move-receive.ts";
import { findOpenCodeSessionProfileOnHost } from "../backends/opencode/session-transfer.ts";
import { openCodeProfileKey } from "../backends/opencode/access.ts";
import { openCodeProfilePaths } from "../backends/opencode/profile-paths.ts";
import { profileKeyForOwner } from "../opencode-profile-keys.ts";
import { buildEnvForUserId, buildOfficeEnv } from "../env-loader.ts";
import { createMember, deleteUserById } from "../users.ts";
import { isolateMember, type IsolatedMember } from "./member-host-fixture.ts";

const SESSION = "5e551011-cccc-4ddd-8eee-0123456789ab";
const OLD_CWD = "/tmp/member-session-host-old";
const NEW_CWD = "/tmp/member-session-host-new";

let iso: IsolatedMember;
let alice: string;
let entries: { name: string; input: Record<string, unknown> }[];
let answer: (name: string, input: Record<string, unknown>) => unknown;
const created: string[] = [];
const scratch: string[] = [];

beforeEach(async () => {
  const made = createMember(`HostAlice${created.length}`, { role: "member" });
  if (!made.ok) throw new Error(made.error);
  alice = made.user.id;
  created.push(alice);
  iso = await isolateMember(alice);
  entries = [];
  answer = () => null;
  // The member's runner: each entry recorded, answered by `answer`.
  (iso.member.host as { runEntry: unknown }).runEntry = async (
    name: string,
    input: Record<string, unknown>,
  ) => {
    entries.push({ name, input });
    return answer(name, input);
  };
});

afterEach(() => {
  iso.dispose();
  for (const p of scratch.splice(0))
    rmSync(p, { recursive: true, force: true });
  for (const id of created.splice(0)) deleteUserById(id);
});

describe("a Claude agent's cwd change", () => {
  it("moves a member's session files in their runner, under their root", async () => {
    const env = buildEnvForUserId(alice)!;
    const root = join(iso.home, ".claude");
    const oldFile = join(claudeProjectDir(OLD_CWD, env), `${SESSION}.jsonl`);
    expect(oldFile.startsWith(`${root}/`)).toBe(true);
    mkdirSync(join(claudeProjectDir(OLD_CWD, env), SESSION), {
      recursive: true,
    });
    writeFileSync(oldFile, "TRANSCRIPT");
    answer = (name, input) =>
      name === "claude-cwd-move" ? moveClaudeCwd(input as never) : null;
    expect(
      await moveClaudeSessionFileOnHost(SESSION, OLD_CWD, NEW_CWD, env),
    ).toEqual({ ok: true, moved: true });
    expect(entries.map((e) => [e.name, e.input.configDir])).toEqual([
      ["claude-cwd-move", root],
    ]);
    expect(
      readFileSync(
        join(claudeProjectDir(NEW_CWD, env), `${SESSION}.jsonl`),
        "utf8",
      ),
    ).toBe("TRANSCRIPT");
    expect(existsSync(join(claudeProjectDir(NEW_CWD, env), SESSION))).toBe(
      true,
    );
    expect(existsSync(oldFile)).toBe(false);
    // The sync path still refuses a member's env.
    expect(() =>
      moveClaudeSessionFile(SESSION, NEW_CWD, OLD_CWD, env),
    ).toThrow();
  });

  it("passes a runner failure on as a failed move", async () => {
    answer = () => {
      throw new Error("the runner is gone");
    };
    const result = await moveClaudeSessionFileOnHost(
      SESSION,
      OLD_CWD,
      NEW_CWD,
      buildEnvForUserId(alice)!,
    );
    expect([result.ok, result.moved]).toEqual([false, false]);
  });

  it("moves an office agent's files in process, never through a member's runner", async () => {
    const env = buildOfficeEnv();
    const oldFile = join(claudeProjectDir(OLD_CWD, env), `${SESSION}.jsonl`);
    mkdirSync(join(oldFile, ".."), { recursive: true });
    writeFileSync(oldFile, "OFFICE");
    scratch.push(
      oldFile,
      join(claudeProjectDir(NEW_CWD, env), `${SESSION}.jsonl`),
    );
    expect(
      await moveClaudeSessionFileOnHost(SESSION, OLD_CWD, NEW_CWD, env),
    ).toEqual({ ok: true, moved: true });
    expect(entries).toEqual([]);
    expect(
      readFileSync(
        join(claudeProjectDir(NEW_CWD, env), `${SESSION}.jsonl`),
        "utf8",
      ),
    ).toBe("OFFICE");
  });

  it("refuses a session id that is not one, in the entry", () => {
    expect(() =>
      moveClaudeCwd({
        sessionId: "../x",
        oldCwd: OLD_CWD,
        newCwd: NEW_CWD,
        configDir: join(iso.home, ".claude"),
      }),
    ).toThrow();
  });
});

describe("the OpenCode recovery of a member's session", () => {
  it("looks only in the member's other profile, through their runner", async () => {
    const memberKey = profileKeyForOwner(alice);
    const chatKey = openCodeProfileKey(memberKey, "chat");
    const chatDir = openCodeProfilePaths(chatKey).profileDir;
    const plainDir = openCodeProfilePaths(memberKey).profileDir;
    expect(chatDir.startsWith(`${join(iso.home, ".isomux-agent")}/`)).toBe(
      true,
    );
    answer = (name, input) =>
      name === "opencode-inspect" &&
      String(input.databasePath).startsWith(`${chatDir}/`)
        ? "durable"
        : "missing";
    expect(await findOpenCodeSessionProfileOnHost("ses_1", memberKey)).toBe(
      chatDir,
    );
    expect(entries.map((e) => e.name)).toEqual(["opencode-inspect"]);
    expect(
      String(entries[0].input.databasePath).startsWith(`${chatDir}/`),
    ).toBe(true);
    // From the other side, the plain profile is the one looked at.
    entries = [];
    expect(await findOpenCodeSessionProfileOnHost("ses_1", chatKey)).toBe(null);
    expect(
      entries.map((e) =>
        String(e.input.databasePath).startsWith(`${plainDir}/`),
      ),
    ).toEqual([true]);
  });

  it("never reaches a member's runner for an office key", async () => {
    await findOpenCodeSessionProfileOnHost("ses_1", "office-environment-key");
    expect(entries).toEqual([]);
  });
});
