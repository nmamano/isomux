// The safety checks of an isolated member's agents (internal-docs/
// member-os-user-design.md, slice 2d-i). Two properties:
// - A member's Codex starts only with the Isomux hook configured: the hook
//   from their runtime in the share, set up in their CODEX_HOME by their own
//   runner. Every failure on the way refuses the start (the office warns
//   and starts instead), and a refused start spawns nothing.
// - A member's Claude tools resolve `~` to the member's home, not the
//   server's.
// The preflight's reach (artifact, share, hook bytes, runtime reinstall,
// runner entries) is replaced through setMemberHookDeps; the member and
// their host are the recording fixture. No hook artifact is built here.
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { resetStateRoot } from "./temp-state.ts";
import type {
  HookCallback,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { STATE_ROOT } from "../config.ts";
import { buildEnvForUserId } from "../env-loader.ts";
import { createMember } from "../users.ts";
import { officeAgentHost, type AgentHost } from "../agent-host.ts";
import {
  ensureCodexSafetyHook,
  MEMBER_HOOK_REFUSAL,
  setMemberHookDeps,
  type MemberHookDeps,
} from "../backends/codex/safety-hook-install.ts";
import { JsonRpcLiteClient } from "../backends/codex/client.ts";
import { createSafetyHooksForEnv } from "../safety-hooks.ts";
import { isolateMember, type IsolatedMember } from "./member-host-fixture.ts";

const SHARE = "/var/lib/isomux-share/isomux-test-alice";
// Written out, not taken from member-runtime.ts: the path a member's Codex
// config names is part of what is tested.
const HOOK_PATH = `${SHARE}/runtime/current/bin/isomux-codex-safety-hook`;
const ARTIFACT = "a".repeat(64);
const TRUST = "sha256:trusted";
const IDENTITY = { sourcePath: "/x/hooks.json", displayOrder: 3 };
const CODEX_HOME = "/home/alice/.isomux-agent/codex-home";

const memberHost = { member: "alice-id", kind: "runner" } as AgentHost;

interface Recorded {
  calls: string[];
  entries: { name: string; input: unknown; host: AgentHost }[];
  reinstalls: number;
}

// Deps where every step succeeds; `over` breaks one. Every call is recorded
// in order.
function deps(over: Partial<MemberHookDeps> = {}): Recorded {
  const rec: Recorded = { calls: [], entries: [], reinstalls: 0 };
  const base: MemberHookDeps = {
    artifact: async () => {
      rec.calls.push("artifact");
      return { sha256: ARTIFACT };
    },
    shareOf: (userId) => {
      rec.calls.push(`shareOf ${userId}`);
      return SHARE;
    },
    installedHash: async (path) => {
      rec.calls.push(`installedHash ${path}`);
      return ARTIFACT;
    },
    reinstall: async (userId) => {
      rec.calls.push(`reinstall ${userId}`);
      rec.reinstalls++;
    },
    runEntry: async (name, input, host) => {
      rec.calls.push(name);
      rec.entries.push({ name, input, host });
      return name === "codex-trust-hash" ? TRUST : { hookIdentity: IDENTITY };
    },
  };
  // A replacement still records its call.
  const wrapped: Partial<MemberHookDeps> = {};
  for (const [key, fn] of Object.entries(over) as [
    keyof MemberHookDeps,
    (...args: unknown[]) => unknown,
  ][])
    (wrapped as Record<string, unknown>)[key] = (...args: unknown[]) => {
      if (key === "runEntry") {
        rec.calls.push(String(args[0]));
        rec.entries.push({
          name: String(args[0]),
          input: args[1],
          host: args[2] as AgentHost,
        });
      } else rec.calls.push(`${key} (replaced)`);
      return fn(...args);
    };
  setMemberHookDeps({ ...base, ...wrapped });
  return rec;
}

// The runner's own reply when configureCodexHooks fails in their space: a
// warning and no identity (safety-hook-install.ts configureCodexHooks).
const RUNNER_FAILURE = {
  warning: "the safety check is off",
  hookIdentity: null,
};

afterEach(() => setMemberHookDeps(null));

function expectRefused(
  result: Awaited<ReturnType<typeof ensureCodexSafetyHook>>,
) {
  expect(result.refusal).toBe(MEMBER_HOOK_REFUSAL);
  expect(result.hookIdentity).toBeNull();
  expect(result.warning).toBeNull();
}

describe("a member's Codex preflight", () => {
  it("configures the hook from their runtime, through their runner, with the trust hash their runner measured", async () => {
    const rec = deps();
    const result = await ensureCodexSafetyHook(CODEX_HOME, memberHost);
    expect(result.refusal).toBeUndefined();
    expect(result.warning).toBeNull();
    expect(result.hookIdentity).toEqual(IDENTITY);
    expect(rec.calls).toContain(`installedHash ${HOOK_PATH}`);
    expect(rec.reinstalls).toBe(0);
    expect(
      rec.entries.map((e) => [e.name, e.input, e.host === memberHost]),
    ).toEqual([
      ["codex-trust-hash", { commandPath: HOOK_PATH }, true],
      [
        "codex-hook-config",
        { codexHome: CODEX_HOME, hookPath: HOOK_PATH, trustedHash: TRUST },
        true,
      ],
    ]);
  });

  // Each step that can fail, and what it does. The hook file is checked
  // twice around one reinstall, so "missing" and "other bytes" fail both.
  const failures: [string, Partial<MemberHookDeps>][] = [
    [
      "the artifact does not build",
      {
        artifact: async () => {
          throw new Error("build failed");
        },
      },
    ],
    ["the member has no share", { shareOf: () => null }],
    [
      "the hook file is missing, also after the reinstall",
      {
        installedHash: async () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
      },
    ],
    [
      "the hook file has other bytes, also after the reinstall",
      { installedHash: async () => "b".repeat(64) },
    ],
    [
      "the reinstall fails",
      {
        installedHash: async () => "b".repeat(64),
        reinstall: async () => {
          throw new Error("share not writable");
        },
      },
    ],
    [
      "the trust measurement fails",
      {
        runEntry: async (name) => {
          if (name === "codex-trust-hash") throw new Error("runner gone");
          return { hookIdentity: IDENTITY };
        },
      },
    ],
    [
      "the trust measurement returns no sha256 hash",
      {
        runEntry: async (name) =>
          name === "codex-trust-hash" ? "md5:x" : { hookIdentity: IDENTITY },
      },
    ],
    [
      "the configuration entry throws (runner gone or not ready)",
      {
        runEntry: async (name) => {
          if (name === "codex-hook-config") throw new Error("runner gone");
          return TRUST;
        },
      },
    ],
    [
      "the runner's configuration failed in their space",
      {
        runEntry: async (name) =>
          name === "codex-hook-config" ? RUNNER_FAILURE : TRUST,
      },
    ],
    [
      "the runner's identity is incomplete",
      {
        runEntry: async (name) =>
          name === "codex-hook-config"
            ? { hookIdentity: { sourcePath: "/x", displayOrder: 1.5 } }
            : TRUST,
      },
    ],
    [
      "an unexpected step throws",
      {
        shareOf: () => {
          throw new Error("record unreadable");
        },
      },
    ],
  ];
  for (const [why, over] of failures)
    it(`refuses the start when ${why}`, async () => {
      const rec = deps(over);
      expectRefused(await ensureCodexSafetyHook(CODEX_HOME, memberHost));
      // Nothing is configured after a failure that comes before it.
      const configured = rec.calls.includes("codex-hook-config");
      expect([why, configured]).toEqual([
        why,
        why.includes("configuration") || why.includes("identity"),
      ]);
    });

  it("reinstalls the runtime once for a missing or stale hook, and starts when that fixes it", async () => {
    let checks = 0;
    const rec = deps({
      installedHash: async () => (++checks === 1 ? "b".repeat(64) : ARTIFACT),
    });
    const result = await ensureCodexSafetyHook(CODEX_HOME, memberHost);
    expect(result.refusal).toBeUndefined();
    expect(result.hookIdentity).toEqual(IDENTITY);
    expect(rec.reinstalls).toBe(1);
    expect(checks).toBe(2);
    expect(rec.calls).toContain("reinstall alice-id");
  });

  it("measures the trust hash once per hook path, and again after a failed measurement", async () => {
    let measured = 0;
    let fail = true;
    deps({
      runEntry: async (name) => {
        if (name !== "codex-trust-hash") return { hookIdentity: IDENTITY };
        measured++;
        if (fail) throw new Error("runner gone");
        return TRUST;
      },
    });
    expectRefused(await ensureCodexSafetyHook(CODEX_HOME, memberHost));
    fail = false;
    for (let i = 0; i < 2; i++)
      expect(
        (await ensureCodexSafetyHook(CODEX_HOME, memberHost)).hookIdentity,
      ).toEqual(IDENTITY);
    expect(measured).toBe(2);
  });

  it("is not the office's path: an office host never reaches the member preflight", async () => {
    const rec = deps({
      artifact: async () => {
        throw new Error("build failed");
      },
    });
    const office = officeAgentHost();
    expect(office.member).toBeUndefined();
    const result = await ensureCodexSafetyHook(
      join(STATE_ROOT, "codex-home"),
      office,
    );
    expect(rec.calls).toEqual([]);
    expect(result.refusal).not.toBe(MEMBER_HOOK_REFUSAL);
  });
});

describe("a member's Codex start", () => {
  let iso: IsolatedMember;
  let env: Record<string, string | undefined>;
  let cwd: string;
  beforeEach(async () => {
    const made = createMember(`CodexHook${Date.now()}`, { role: "member" });
    if (!made.ok) throw new Error(made.error);
    iso = await isolateMember(made.user.id);
    env = buildEnvForUserId(made.user.id) ?? {};
    cwd = mkdtempSync(join(tmpdir(), "member-codex-start-"));
  });
  afterEach(() => {
    iso.dispose();
    rmSync(cwd, { recursive: true, force: true });
  });

  const spawned = () =>
    [...iso.member.calls, ...iso.office.calls].filter(
      (c) => c.op === "spawnChild",
    );

  async function start(): Promise<string> {
    const client = new JsonRpcLiteClient({
      codexBin: "/bin/false",
      args: [],
      cwd,
      env,
    });
    try {
      return await client.start().then(
        () => "started",
        (err) => (err as Error).message,
      );
    } finally {
      await client.close();
    }
  }

  it("spawns on the member's host when the preflight passes", async () => {
    const rec = deps();
    expect(await start()).toBe("started");
    expect(spawned().map((c) => c.argv[0])).toEqual(["/bin/false"]);
    expect(iso.member.calls.filter((c) => c.op === "spawnChild")).toHaveLength(
      1,
    );
    // The preflight ran as the member's: their host, their CODEX_HOME.
    const config = rec.entries.find((e) => e.name === "codex-hook-config");
    expect(config?.host).toBe(iso.member.host);
    expect(env.CODEX_HOME).toBeDefined();
    expect((config?.input as { codexHome: string }).codexHome).toBe(
      String(env.CODEX_HOME),
    );
  });

  it("spawns nothing, on any host, when the preflight refuses", async () => {
    deps({
      artifact: async () => {
        throw new Error("build failed");
      },
    });
    // Twice: a refused start leaves nothing half started.
    expect(await start()).toBe(MEMBER_HOOK_REFUSAL);
    expect(await start()).toBe(MEMBER_HOOK_REFUSAL);
    expect(spawned()).toEqual([]);
  });
});

describe("a member's Claude tools", () => {
  let iso: IsolatedMember;
  let env: Record<string, string | undefined>;
  // The member's home is in the office state root here, so a write to `~`
  // is refused only when `~` is the member's home. The server's home is
  // outside it.
  const memberHome = join(STATE_ROOT, "member-home-2d-i");
  beforeEach(async () => {
    const made = createMember(`ClaudeHome${Date.now()}`, { role: "member" });
    if (!made.ok) throw new Error(made.error);
    iso = await isolateMember(made.user.id);
    (iso.member.host as { home: () => string }).home = () => memberHome;
    mkdirSync(memberHome, { recursive: true });
    env = buildEnvForUserId(made.user.id) ?? {};
  });
  afterEach(() => {
    iso.dispose();
    rmSync(memberHome, { recursive: true, force: true });
  });

  async function denied(
    hookEnv: Record<string, string | undefined>,
    command: string,
  ): Promise<boolean> {
    const matchers = createSafetyHooksForEnv(hookEnv).PreToolUse ?? [];
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
      cwd: "/tmp",
    } as unknown as Parameters<HookCallback>[0];
    for (const m of matchers.filter((x) => x.matcher === "Bash"))
      for (const hook of m.hooks) {
        const out: HookJSONOutput = await hook(input, undefined, {
          signal: new AbortController().signal,
        });
        const specific = (
          out as { hookSpecificOutput?: { permissionDecision?: string } }
        ).hookSpecificOutput;
        if (specific?.permissionDecision === "deny") return true;
      }
    return false;
  }

  it("resolve ~ to the member's home, and an office agent's to the server's", async () => {
    // The conditions the comparison needs: the server's home is outside
    // the state root, and a write under the state root is refused.
    expect(homedir().startsWith(STATE_ROOT)).toBe(false);
    expect(await denied({}, `cp a ${memberHome}/x`)).toBe(true);
    const command = "cp a ~/x";
    expect(await denied(env, command)).toBe(true);
    expect(await denied({}, command)).toBe(false);
  });
});

// Later files in the same bun process: none of this file's members or their
// files on disk (task 3a93528c).
afterAll(() => resetStateRoot(STATE_ROOT));
