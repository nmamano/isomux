// An isolated member's agent space (internal-docs/member-os-user-design.md,
// section 1.3; slice 1c-i of task b94dfd25). Their provider homes, Codex
// home, OpenCode profiles and empty folders are in <member home>/.isomux-agent;
// the office's stay where they were. A read of a member path goes through
// the member's host, never the office's file system: a sync read refuses a
// member env, and the async twins ask the member host. The member host's fs
// here is a recorder that answers `exists` from a set, so a twin that read
// the office's disk instead would answer from the disk and show red.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { localAgentFs, type AgentFs } from "../agent-host.ts";
import { STATE_ROOT } from "../config.ts";
import { AGENT_ROOT } from "../split/roots.ts";
import { buildEnvForUserId } from "../env-loader.ts";
import {
  connectMemberHost,
  forgetMemberHost,
  hostFor,
  memberHostRefusal,
} from "../member-hosts.ts";
import {
  activatePersonalProvider,
  deactivatePersonalProvider,
  ensurePersonalProviderHome,
  ensurePersonalProviderHomeOnHost,
  officePersonalProviderHome,
  personalProviderHome,
} from "../provider-homes.ts";
import {
  claudeProjectDir,
  claudeSessionFileExists,
  claudeSessionFileExistsOnHost,
  claudeStoredSessionState,
  codexRolloutFileExists,
  findCodexRolloutPath,
  inspectCodexStoredSession,
  moveClaudeSessionFile,
} from "../cwd-utils.ts";
import {
  isCodexAuthenticated,
  isCodexAuthenticatedOnHost,
} from "../backends/codex/native-bin.ts";
import {
  claudeSignInState,
  isClaudeCodeAuthenticated,
  isClaudeCodeAuthenticatedOnHost,
  isClaudeCodeInstalled,
} from "../backends/claude-install-check.ts";
import {
  claudeConfigRoot,
  resolveClaudeSessionRoot,
  resolveClaudeSessionRootOnHost,
} from "../claude-session-root.ts";
import { buildOfficeEnv } from "../env-loader.ts";
import {
  CODEX_EMPTY_CWD_ROOT,
  OPENCODE_EMPTY_CWD_ROOT,
} from "../backends/empty-folder.ts";
import { codexEmptyCwd } from "../backends/codex/access.ts";
import { openCodeEmptyCwd } from "../backends/opencode/access.ts";
import {
  openCodeProfileHost,
  openCodeProfilePaths,
} from "../backends/opencode/profile-paths.ts";
import { reloadOpenCodeServer } from "../backends/opencode/supervisor.ts";
import { profileKeyForOwner } from "../opencode-profile-keys.ts";
import { claudeConfigDirOf, codexUserHomeOf } from "../provider-skill-links.ts";
import { createSessionAccounts } from "../session-accounts.ts";
import { codexRolloutLines } from "../backends/codex/instructions-update.ts";
import { createAgentManager } from "../agent-manager.ts";
import { OfficeState } from "../../shared/office-state.ts";
import type { PersistedAgent } from "../persistence.ts";
import { FakeBackend } from "./fake-backend.ts";
import {
  getSessionClaudeConfigDir,
  setSessionClaudeConfigDir,
} from "../persistence.ts";
import type { ManagedAgent } from "../internal-types.ts";
import { createMember, deleteUserById } from "../users.ts";
import { removeManagedUserEnv, writeManagedUserEnv } from "../user-env.ts";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./managed-office-env.ts";
import { isolateMember, type IsolatedMember } from "./member-host-fixture.ts";

const SESSION = "0d1e2f30-4a5b-4c6d-8e9f-a0b1c2d3e4f5";
const CWD = "/tmp/member-agent-space-cwd";

let iso: IsolatedMember;
let alice: string;
let bob: string;
let space: string;
const created: string[] = [];
let fsCalls: { op: string; path: string; mode?: number }[];
// The paths the member host's exists() answers true for.
let present: Set<string>;
// Files only the member host can read: the office's fs has no such path.
let served: Map<string, string>;
let failMkdir = false;

function member(name: string): string {
  const made = createMember(name, { role: "member" });
  if (!made.ok) throw new Error(made.error);
  created.push(made.user.id);
  return made.user.id;
}

// The member host's fs: recorded; exists() answers from `present`; the rest
// goes to the local fs, as the fixture's does.
function recordingFs(): AgentFs {
  return {
    realpath: (path) => localAgentFs.realpath(path),
    readText: (path) => {
      fsCalls.push({ op: "readText", path });
      const text = served.get(path);
      return text === undefined
        ? localAgentFs.readText(path)
        : Promise.resolve(text);
    },
    writeText: (path, text, options) => {
      fsCalls.push({ op: "writeText", path, mode: options.mode });
      return localAgentFs.writeText(path, text, options);
    },
    mkdir: async (path, mode) => {
      fsCalls.push({ op: "mkdir", path, mode });
      if (failMkdir) throw new Error("EACCES: recording host");
      return localAgentFs.mkdir(path, mode);
    },
    rm: (path) => {
      fsCalls.push({ op: "rm", path });
      return localAgentFs.rm(path);
    },
    exists: async (path) => {
      fsCalls.push({ op: "exists", path });
      return present.has(path);
    },
    chmod: (path, mode) => {
      fsCalls.push({ op: "chmod", path, mode });
      return localAgentFs.chmod(path, mode);
    },
    stat: (path) => {
      fsCalls.push({ op: "stat", path });
      return localAgentFs.stat(path);
    },
    readBytes: (path, max) => {
      fsCalls.push({ op: "readBytes", path });
      return localAgentFs.readBytes(path, max);
    },
    enter: (path) => {
      fsCalls.push({ op: "enter", path });
      return localAgentFs.enter(path);
    },
  };
}

beforeEach(async () => {
  fsCalls = [];
  present = new Set();
  served = new Map();
  failMkdir = false;
  alice = member(`SpaceAlice${created.length}`);
  bob = member(`SpaceBob${created.length}`);
  iso = await isolateMember(alice);
  (iso.member.host as { fs: AgentFs }).fs = recordingFs();
  space = join(iso.home, ".isomux-agent");
});

afterEach(() => {
  iso.dispose();
  clearTestManagedOfficeEnv();
  for (const id of created.splice(0)) {
    removeManagedUserEnv(id);
    deactivatePersonalProvider(id, "claude");
    deactivatePersonalProvider(id, "codex");
    deleteUserById(id);
  }
});

const aliceEnv = () => buildEnvForUserId(alice)!;

describe("where an isolated member's agent space is", () => {
  it("is made by the member's host at the connect, 0700, and a failure refuses the connect", async () => {
    forgetMemberHost(alice);
    fsCalls = [];
    expect(await connectMemberHost(alice)).toBe(true);
    expect(fsCalls).toContainEqual({ op: "mkdir", path: space, mode: 0o700 });
    expect(hostFor(alice).agentRoot()).toBe(space);

    forgetMemberHost(alice);
    failMkdir = true;
    expect(await connectMemberHost(alice)).toBe(false);
    expect(memberHostRefusal(alice)).toContain(space);
    expect(hostFor(alice).member).toBe(alice);
    expect(hostFor(alice).agentRoot()).not.toBe(space);
  });

  it("puts the member's provider homes, OpenCode profiles and empty folders in it; the office's stay", () => {
    expect(personalProviderHome(alice, "claude")).toBe(
      join(space, "provider-homes", alice, "claude"),
    );
    expect(personalProviderHome(alice, "codex")).toBe(
      join(space, "provider-homes", alice, "codex"),
    );
    // What the purge removes: always the office's copy.
    expect(officePersonalProviderHome(alice, "claude")).toBe(
      join(STATE_ROOT, "provider-homes", alice, "claude"),
    );
    expect(personalProviderHome(bob, "codex")).toBe(
      join(STATE_ROOT, "provider-homes", bob, "codex"),
    );

    const key = profileKeyForOwner(alice);
    for (const k of [key, `${key}\0below-standard`]) {
      const { profileDir } = openCodeProfilePaths(k);
      expect([
        k,
        profileDir.startsWith(join(space, "opencode", "profiles") + "/"),
      ]).toEqual([k, true]);
      expect(openCodeProfileHost(profileDir).member).toBe(alice);
    }
    const bobProfile = openCodeProfilePaths(profileKeyForOwner(bob)).profileDir;
    expect(
      bobProfile.startsWith(join(AGENT_ROOT, "opencode", "profiles") + "/"),
    ).toBe(true);
    expect(openCodeProfileHost(bobProfile).member).toBeUndefined();

    expect(CODEX_EMPTY_CWD_ROOT).toBe(join(AGENT_ROOT, "codex", "no-folder"));
    expect(OPENCODE_EMPTY_CWD_ROOT).toBe(
      join(AGENT_ROOT, "opencode", "no-folder"),
    );
  });

  it("makes the member's provider home through their host only", async () => {
    expect(() => ensurePersonalProviderHome(alice, "codex")).toThrow();
    expect(await ensurePersonalProviderHomeOnHost(alice, "codex")).toBe(
      join(space, "provider-homes", alice, "codex"),
    );
    expect(fsCalls).toContainEqual({
      op: "mkdir",
      path: join(space, "provider-homes", alice, "codex"),
      mode: 0o700,
    });
  });

  it("makes the member's empty folders in their runner, not in the server", async () => {
    for (const make of [
      () => codexEmptyCwd("agent-x", aliceEnv()),
      () => openCodeEmptyCwd("agent-x", aliceEnv()),
    ]) {
      const before = iso.member.calls.length;
      await expect(make()).rejects.toThrow();
      expect(
        iso.member.calls.slice(before).map((c) => [c.op, ...c.argv]),
      ).toEqual([["runEntry", "empty-folder"]]);
    }
  });

  it("writes an OpenCode reload marker through the profile owner's host", async () => {
    const key = profileKeyForOwner(alice);
    const { profileDir } = openCodeProfilePaths(key);
    present.add(profileDir);
    mkdirSync(profileDir, { recursive: true });
    await reloadOpenCodeServer(key);
    expect(fsCalls).toContainEqual({
      op: "writeText",
      path: join(profileDir, "server.replace"),
      mode: 0o600,
    });
  });
});

describe("the member's Codex home", () => {
  const codexHome = () => join(space, "codex-home");

  it("is in their agent space by default and under an office variable", () => {
    expect(aliceEnv().CODEX_HOME).toBe(codexHome());
    setTestManagedOfficeEnv({ CODEX_HOME: "/office/codex-home" });
    expect(aliceEnv().CODEX_HOME).toBe(codexHome());
    // The office's own agents keep the office variable.
    expect(buildEnvForUserId(bob)?.CODEX_HOME).toBe("/office/codex-home");
  });

  it("follows the member's own variable or personal sign-in", () => {
    writeManagedUserEnv(alice, { CODEX_HOME: "/mine/codex" });
    expect(aliceEnv().CODEX_HOME).toBe("/mine/codex");
    removeManagedUserEnv(alice);
    activatePersonalProvider(alice, "codex");
    expect(aliceEnv().CODEX_HOME).toBe(
      join(space, "provider-homes", alice, "codex"),
    );
  });

  it("is not set for an office member who sets nothing", () => {
    expect(buildEnvForUserId(bob)?.CODEX_HOME).toBeUndefined();
  });
});

describe("reads of the member's files", () => {
  it("never go to the office's file system from a sync check", () => {
    const env = aliceEnv();
    const sync: [string, () => unknown][] = [
      [
        "claudeSessionFileExists",
        () => claudeSessionFileExists(CWD, SESSION, env),
      ],
      [
        "claudeStoredSessionState",
        () => claudeStoredSessionState(CWD, SESSION, env),
      ],
      ["findCodexRolloutPath", () => findCodexRolloutPath(SESSION, env)],
      ["codexRolloutFileExists", () => codexRolloutFileExists(SESSION, env)],
      [
        "inspectCodexStoredSession",
        () => inspectCodexStoredSession(SESSION, env),
      ],
      [
        "moveClaudeSessionFile",
        () => moveClaudeSessionFile(SESSION, CWD, `${CWD}-2`, env),
      ],
      ["isCodexAuthenticated", () => isCodexAuthenticated(env)],
      ["isClaudeCodeInstalled", () => isClaudeCodeInstalled(env)],
      ["isClaudeCodeAuthenticated", () => isClaudeCodeAuthenticated(env)],
    ];
    for (const [name, call] of sync)
      expect([
        name,
        (() => {
          try {
            call();
            return "answered";
          } catch {
            return "refused";
          }
        })(),
      ]).toEqual([name, "refused"]);
  });

  it("go to the member's host from the async twins", async () => {
    const env = aliceEnv();
    const transcript = join(claudeProjectDir(CWD, env), `${SESSION}.jsonl`);
    expect(transcript.startsWith(join(iso.home, ".claude") + "/")).toBe(true);
    expect(await claudeSessionFileExistsOnHost(CWD, SESSION, env)).toBe(false);
    present.add(transcript);
    expect(await claudeSessionFileExistsOnHost(CWD, SESSION, env)).toBe(true);

    const auth = join(space, "codex-home", "auth.json");
    expect(await isCodexAuthenticatedOnHost(env)).toBe(false);
    present.add(auth);
    expect(await isCodexAuthenticatedOnHost(env)).toBe(true);
    expect(
      await isCodexAuthenticatedOnHost({ ...env, OPENAI_API_KEY: "k" }),
    ).toBe(true);

    const credentials = join(iso.home, ".claude", ".credentials.json");
    expect(await isClaudeCodeAuthenticatedOnHost(env)).toBe(false);
    expect(await claudeSignInState(env)).toBe("signed_out");
    present.add(credentials);
    expect(await isClaudeCodeAuthenticatedOnHost(env)).toBe(true);
    expect(await claudeSignInState(env)).toBe("signed_in");

    expect(fsCalls.filter((c) => c.op === "exists").map((c) => c.path)).toEqual(
      expect.arrayContaining([transcript, auth, credentials]),
    );
  });

  it("read a Codex rollout through the member's host; the office reads its own", async () => {
    const collect = async (lines: AsyncIterable<string>) => {
      const out: string[] = [];
      for await (const line of lines) out.push(line);
      return out;
    };
    const rollout = join(space, "codex-home", "sessions", "rollout-x.jsonl");
    served.set(rollout, '{"a":1}\n{"b":2}\n');
    expect(await collect(codexRolloutLines(rollout, aliceEnv()))).toEqual([
      '{"a":1}',
      '{"b":2}',
      "",
    ]);
    expect(
      fsCalls.filter((c) => c.op === "readText").map((c) => c.path),
    ).toEqual([rollout]);

    const officeFile = join(
      STATE_ROOT,
      `rollout-office-${crypto.randomUUID()}.jsonl`,
    );
    writeFileSync(officeFile, '{"c":3}\n');
    try {
      expect(
        await collect(codexRolloutLines(officeFile, buildOfficeEnv())),
      ).toEqual(['{"c":3}']);
      expect(fsCalls.filter((c) => c.op === "readText")).toHaveLength(1);
    } finally {
      rmSync(officeFile, { force: true });
    }
  });

  it("name the member's home for the skill links, not the server's", () => {
    const env = aliceEnv();
    expect(claudeConfigDirOf(env)).toBe(join(iso.home, ".claude"));
    const { CODEX_HOME: _drop, ...noCodexHome } = env;
    expect(codexUserHomeOf(noCodexHome)).toBe(join(iso.home, ".codex"));
  });
});

describe("the Claude root of an isolated member's session", () => {
  const personal = () => join(space, "provider-homes", alice, "claude");
  const officeRoot = () => claudeConfigRoot(buildOfficeEnv());

  it("sync: never searched; a pin counts only when it is one of the member's roots", () => {
    const env = aliceEnv();
    // The transcript in the office's root, where it would be found by a
    // search that reached the office's disk.
    const officeFile = join(
      claudeProjectDir(CWD, { CLAUDE_CONFIG_DIR: officeRoot() }),
      `${SESSION}.jsonl`,
    );
    mkdirSync(join(officeFile, ".."), { recursive: true });
    writeFileSync(officeFile, "{}\n");
    try {
      expect(
        resolveClaudeSessionRoot(SESSION, CWD, env, undefined, alice),
      ).toBe(claudeConfigRoot(env));
      expect(
        resolveClaudeSessionRoot(SESSION, CWD, env, personal(), alice),
      ).toBe(personal());
      expect(
        resolveClaudeSessionRoot(SESSION, CWD, env, officeRoot(), alice),
      ).toBe(claudeConfigRoot(env));
      expect(
        resolveClaudeSessionRoot(SESSION, CWD, env, "/somewhere/else", alice),
      ).toBe(claudeConfigRoot(env));
    } finally {
      rmSync(officeFile, { force: true });
    }
  });

  it("async: searched through the member's host, and a pin outside their roots is ignored", async () => {
    const env = aliceEnv();
    const inPersonal = join(
      claudeProjectDir(CWD, { CLAUDE_CONFIG_DIR: personal() }),
      `${SESSION}.jsonl`,
    );
    await expect(
      resolveClaudeSessionRootOnHost(SESSION, CWD, env, undefined, alice),
    ).rejects.toThrow();
    present.add(inPersonal);
    expect(
      await resolveClaudeSessionRootOnHost(SESSION, CWD, env, undefined, alice),
    ).toBe(personal());
    expect(
      await resolveClaudeSessionRootOnHost(
        SESSION,
        CWD,
        env,
        officeRoot(),
        alice,
      ),
    ).toBe(personal());
    expect(
      await resolveClaudeSessionRootOnHost(
        SESSION,
        CWD,
        env,
        claudeConfigRoot(env),
        alice,
      ),
    ).toBe(claudeConfigRoot(env));
  });

  // The turn start (alignAccount) searches and pins; the sync env builder
  // before it must not pin a root it did not find, or the search never runs.
  it("is pinned where the transcript is, even when the session env was built first", async () => {
    const accounts = createSessionAccounts(
      new Proxy(
        {
          agents: new Map(),
          providerFallback: { isEnabled: () => false, entry: () => null },
        },
        {
          get: (target, name) =>
            (target as Record<string | symbol, unknown>)[name] ??
            (() => undefined),
        },
      ) as unknown as Parameters<typeof createSessionAccounts>[0],
    );
    const agentId = `space-agent-${crypto.randomUUID()}`;
    const managed = {
      info: { id: agentId, agentType: "claude", userId: alice, cwd: CWD },
      sessionManager: { sessionId: SESSION, session: null },
      officeFallback: false,
    } as unknown as ManagedAgent;
    present.add(
      join(
        claudeProjectDir(CWD, { CLAUDE_CONFIG_DIR: personal() }),
        `${SESSION}.jsonl`,
      ),
    );

    accounts.buildSessionEnv(managed);
    await accounts.alignAccount(agentId, managed);
    expect(getSessionClaudeConfigDir(agentId, SESSION)).toBe(
      resolve(personal()),
    );
    expect(accounts.buildSessionEnv(managed)?.CLAUDE_CONFIG_DIR).toBe(
      resolve(personal()),
    );

    // A pin from before the isolation (the office's root) is searched again.
    setSessionClaudeConfigDir(agentId, SESSION, officeRoot());
    await accounts.alignAccount(agentId, managed);
    expect(getSessionClaudeConfigDir(agentId, SESSION)).toBe(
      resolve(personal()),
    );
  });

  // The boot restore resolves the root without the search: it must not pin it.
  it("is not pinned by the restore at boot", async () => {
    const persisted = {
      id: `space-restore-${crypto.randomUUID()}`,
      name: "Restored",
      desk: 0,
      cwd: CWD,
      outfit: {
        hat: "none",
        color: "#000000",
        hair: "#000000",
        hairStyle: "short",
        skin: "#ffffff",
        beard: "none",
        accessory: null,
      },
      permissionMode: "default",
      modelFamily: "sonnet",
      effort: "high",
      agentType: "claude",
      lastSessionId: SESSION,
      topic: null,
      customInstructions: null,
      userId: alice,
      username: null,
    } as unknown as PersistedAgent;
    const mgr = createAgentManager({
      resolveBackend: () => new FakeBackend({ storedSessionState: "durable" }),
      officeState: new OfficeState({
        rooms: [{ id: "room-space", name: "room-space", prompt: null }],
      }),
      initialRooms: [
        {
          id: "room-space",
          name: "room-space",
          prompt: null,
          agents: [persisted],
        },
      ],
    });
    await mgr.restoreAgents();
    // The restore took the stored session, so it resolved its root.
    expect(mgr.getCurrentSessionId(persisted.id)).toBe(SESSION);
    expect(getSessionClaudeConfigDir(persisted.id, SESSION)).not.toBe(
      resolve(claudeConfigRoot(aliceEnv())),
    );
  });
});
