import { beforeAll, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";
import { STATE_ROOT } from "../../config.ts";
import { getCodexPinnedVersion } from "./native-bin.ts";
import {
  CODEX_HOOK_TRUST_HASH_PROVEN_VERSION,
  CODEX_SAFETY_HOOK_PATH,
  ensureCodexSafetyHook,
  prepareCodexSafetyHookArtifact,
  _test,
} from "./safety-hook-install.ts";
import { SAFETY_WARNING } from "./safety-hook.ts";
import { _test as trustProbeTest } from "./safety-hook-trust-probe.ts";

const defaultHome = join(STATE_ROOT, "codex-home");

beforeAll(async () => {
  expect(getCodexPinnedVersion()).toBe(CODEX_HOOK_TRUST_HASH_PROVEN_VERSION);
  await prepareCodexSafetyHookArtifact();
});

function userEntry(command: string) {
  return { matcher: "user-tool", hooks: [{ type: "command", command }] };
}

function isomuxEntry(command: string) {
  return { matcher: ".*", hooks: [{ type: "command", command }] };
}

describe("Codex safety hook installation", () => {
  it("bounds a non-settling boot trust measurement", async () => {
    const never = new Promise<never>(() => {});
    const observed = await Promise.race([
      trustProbeTest.withTrustProbeDeadline(never, 5).then(
        () => "unexpected resolution",
        (err) => (err as Error).message,
      ),
      Bun.sleep(50).then(() => "outer test deadline expired"),
    ]);
    expect(observed).toBe("Codex hook trust probe exceeded 5ms");
  });

  it("pins the boot trust measurement to the measured Codex version", () => {
    expect(getCodexPinnedVersion()).toBe(CODEX_HOOK_TRUST_HASH_PROVEN_VERSION);
  });

  it("appends PreToolUse, preserves user trust, and is byte-idempotent for 5 spawns", async () => {
    mkdirSync(defaultHome, { recursive: true });
    const hooksPath = join(defaultHome, "hooks.json");
    const user = {
      matcher: "user-tool",
      hooks: [
        { type: "command", command: "/tmp/user-hook" },
        { type: "command", command: "/tmp/second-user-hook" },
      ],
    };
    const userHash = "sha256:user-trusted-hash";
    const secondUserHash = "sha256:second-user-trusted-hash";
    writeFileSync(
      hooksPath,
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [user],
            PostToolUse: [userEntry("/tmp/post-hook")],
          },
        },
        null,
        2,
      )}\n`,
    );
    const userTrust = [
      'model = "gpt-5.3-codex"',
      "[mcp_servers.example]",
      'command = "/tmp/mcp"',
      `[hooks.state.${JSON.stringify(`${hooksPath}:pre_tool_use:0:0`)}]`,
      "enabled = true",
      `trusted_hash = ${JSON.stringify(userHash)}`,
      `[hooks.state.${JSON.stringify(`${hooksPath}:pre_tool_use:0:1`)}]`,
      "enabled = true",
      `trusted_hash = ${JSON.stringify(secondUserHash)}`,
      "",
    ].join("\n");
    writeFileSync(join(defaultHome, "config.toml"), userTrust);

    const first = await ensureCodexSafetyHook(defaultHome);
    expect(first.warning).toBeNull();
    expect(first.hookIdentity).toEqual({
      sourcePath: hooksPath,
      displayOrder: 2,
    });
    const hooksAfterFirst = readFileSync(hooksPath, "utf8");
    const configAfterFirst = readFileSync(
      join(defaultHome, "config.toml"),
      "utf8",
    );
    const parsedHooks = JSON.parse(hooksAfterFirst);
    expect(parsedHooks.hooks.PreToolUse[0]).toEqual(user);
    expect(parsedHooks.hooks.PreToolUse[1].hooks[0]).toEqual({
      type: "command",
      command: CODEX_SAFETY_HOOK_PATH,
    });
    expect(parsedHooks.hooks.PermissionRequest).toBeUndefined();
    expect(parsedHooks.hooks.PostToolUse).toEqual([
      userEntry("/tmp/post-hook"),
    ]);
    const parsedConfig = Bun.TOML.parse(configAfterFirst) as any;
    const preservedUser =
      parsedConfig.hooks.state[`${hooksPath}:pre_tool_use:0:0`];
    expect(preservedUser).toEqual({ enabled: true, trusted_hash: userHash });
    const preservedSecondUser =
      parsedConfig.hooks.state[`${hooksPath}:pre_tool_use:0:1`];
    expect(preservedSecondUser).toEqual({
      enabled: true,
      trusted_hash: secondUserHash,
    });
    expect(configAfterFirst).toContain(
      'model = "gpt-5.3-codex"\n[mcp_servers.example]\ncommand = "/tmp/mcp"',
    );

    for (let run = 0; run < 5; run++) {
      const result = await ensureCodexSafetyHook(defaultHome);
      expect(result.warning).toBeNull();
      expect(readFileSync(hooksPath, "utf8")).toBe(hooksAfterFirst);
      expect(readFileSync(join(defaultHome, "config.toml"), "utf8")).toBe(
        configAfterFirst,
      );
    }
  });

  it("repairs a same-size, same-mtime content swap without rebuilding the golden artifact", async () => {
    expect((await ensureCodexSafetyHook(defaultHome)).warning).toBeNull();
    const fixedTime = new Date(Math.floor(Date.now() / 1000) * 1000);
    utimesSync(CODEX_SAFETY_HOOK_PATH, fixedTime, fixedTime);
    const installedBefore = statSync(CODEX_SAFETY_HOOK_PATH);
    const goldenBefore = statSync(_test.goldenPath);
    const bytes = readFileSync(CODEX_SAFETY_HOOK_PATH);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    writeFileSync(CODEX_SAFETY_HOOK_PATH, bytes);
    utimesSync(
      CODEX_SAFETY_HOOK_PATH,
      installedBefore.atime,
      installedBefore.mtime,
    );
    const swapped = statSync(CODEX_SAFETY_HOOK_PATH);
    expect(swapped.size).toBe(installedBefore.size);
    expect(swapped.mtimeMs).toBe(installedBefore.mtimeMs);

    const result = await ensureCodexSafetyHook(defaultHome);
    expect(result.warning).toBeNull();
    expect(readFileSync(CODEX_SAFETY_HOOK_PATH)).toEqual(
      readFileSync(_test.goldenPath),
    );
    const goldenAfter = statSync(_test.goldenPath);
    expect(goldenAfter.ino).toBe(goldenBefore.ino);
    expect(goldenAfter.mtimeMs).toBe(goldenBefore.mtimeMs);
  });

  it("repairs a stale boot artifact by rebuilding, not by copying it to the installed path", async () => {
    expect((await ensureCodexSafetyHook(defaultHome)).warning).toBeNull();
    const installedBefore = readFileSync(CODEX_SAFETY_HOOK_PATH);
    writeFileSync(
      _test.goldenPath,
      "#!/bin/sh\nprintf '%s\\n' stale-source-stamp\n",
    );
    chmodSync(_test.goldenPath, 0o700);
    const staleSize = statSync(_test.goldenPath).size;
    _test.resetPreparation();
    await prepareCodexSafetyHookArtifact();
    expect(statSync(_test.goldenPath).size).not.toBe(staleSize);
    expect(readFileSync(CODEX_SAFETY_HOOK_PATH)).toEqual(installedBefore);
  });

  it("installs and trusts the same hook in an override CODEX_HOME", async () => {
    const override = join(STATE_ROOT, "users/test-user/codex-home");
    const result = await ensureCodexSafetyHook(override);
    expect(result.warning).toBeNull();
    expect(result.hookIdentity?.sourcePath).toBe(join(override, "hooks.json"));
    const hooks = JSON.parse(
      readFileSync(join(override, "hooks.json"), "utf8"),
    );
    expect(hooks.hooks.PreToolUse).toHaveLength(1);
  });

  it("keeps a trusted user hook enabled when it is before an existing Isomux group", async () => {
    const home = join(STATE_ROOT, "users/prepended-user/codex-home");
    mkdirSync(home, { recursive: true });
    const hooksPath = join(home, "hooks.json");
    const user = userEntry("/tmp/prepended-user-hook");
    const owned = {
      matcher: ".*",
      hooks: [{ type: "command", command: CODEX_SAFETY_HOOK_PATH }],
    };
    writeFileSync(
      hooksPath,
      `${JSON.stringify({ hooks: { PreToolUse: [user, owned] } }, null, 2)}\n`,
    );
    const userHash = "sha256:prepended-user-trusted-hash";
    const ownedHash = "sha256:old-isomux-trust-hash";
    const userKey = `${hooksPath}:pre_tool_use:0:0`;
    const ownedKey = `${hooksPath}:pre_tool_use:1:0`;
    const userBlock = [
      `[hooks.state.${JSON.stringify(userKey)}]`,
      "enabled = true",
      `trusted_hash = ${JSON.stringify(userHash)}`,
    ].join("\n");
    // The Isomux sentinel is deliberately detached. Ownership must come from
    // the live key -> current matcher -> command relationship, not the comment.
    writeFileSync(
      join(home, "config.toml"),
      [
        _test.trustSentinel,
        userBlock,
        `[hooks.state.${JSON.stringify(ownedKey)}]`,
        "enabled = true",
        `trusted_hash = ${JSON.stringify(ownedHash)}`,
        "",
      ].join("\n"),
    );

    const result = await ensureCodexSafetyHook(home);
    expect(result).toEqual({
      warning: null,
      hookIdentity: { sourcePath: hooksPath, displayOrder: 1 },
    });
    const configText = readFileSync(join(home, "config.toml"), "utf8");
    const config = Bun.TOML.parse(configText) as {
      hooks: {
        state: Record<string, { enabled: boolean; trusted_hash: string }>;
      };
    };
    expect(config.hooks.state[userKey]).toEqual({
      enabled: true,
      trusted_hash: userHash,
    });
    expect(config.hooks.state[ownedKey].enabled).toBe(true);
    expect(config.hooks.state[ownedKey].trusted_hash).toMatch(/^sha256:/);
    expect(config.hooks.state[ownedKey].trusted_hash).not.toBe(ownedHash);
    expect(
      configText.match(
        new RegExp(ownedKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
      ),
    ).toHaveLength(1);
  });

  it("converges live-shaped foreign Isomux matchers and trust without changing user hooks", async () => {
    const home = join(STATE_ROOT, "users/live-shaped/codex-home");
    mkdirSync(home, { recursive: true });
    const hooksPath = join(home, "hooks.json");
    const user = userEntry("/tmp/user-hook-before-isomux");
    const foreignEntries = Array.from({ length: 11 }, (_, index) =>
      isomuxEntry(
        index === 0
          ? CODEX_SAFETY_HOOK_PATH
          : `/tmp/stale-state-${index}/bin/isomux-codex-safety-hook`,
      ),
    );
    writeFileSync(
      hooksPath,
      `${JSON.stringify(
        { hooks: { PreToolUse: [user, ...foreignEntries] } },
        null,
        2,
      )}\n`,
    );
    const userKey = `${hooksPath}:pre_tool_use:0:0`;
    const userBlock = [
      `[hooks.state.${JSON.stringify(userKey)}]`,
      "enabled = true",
      'trusted_hash = "sha256:user-live-shaped"',
    ].join("\n");
    const ownedBlocks = foreignEntries.map((_, offset) => {
      const index = offset + 1;
      const lines = [
        `[hooks.state.${JSON.stringify(`${hooksPath}:pre_tool_use:${index}:0`)}]`,
        "enabled = true",
        `trusted_hash = "sha256:stale-${index}"`,
      ];
      return offset < 6 ? [_test.trustSentinel, ...lines].join("\n") : lines.join("\n");
    });
    writeFileSync(
      join(home, "config.toml"),
      [userBlock, ...ownedBlocks, ""].join("\n"),
    );

    expect((await ensureCodexSafetyHook(home)).warning).toBeNull();

    const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
    expect(hooks.hooks.PreToolUse).toEqual([
      user,
      isomuxEntry(CODEX_SAFETY_HOOK_PATH),
    ]);
    const configText = readFileSync(join(home, "config.toml"), "utf8");
    const config = Bun.TOML.parse(configText) as {
      hooks: {
        state: Record<string, { enabled: boolean; trusted_hash: string }>;
      };
    };
    expect(config.hooks.state[userKey]).toEqual({
      enabled: true,
      trusted_hash: "sha256:user-live-shaped",
    });
    expect(Object.keys(config.hooks.state)).toEqual([
      userKey,
      `${hooksPath}:pre_tool_use:1:0`,
    ]);
    expect(configText.match(/# isomux-managed-codex-safety-hook/g)).toHaveLength(
      1,
    );
  });

  it("renames every trust key when duplicate Isomux groups shift a user matcher", async () => {
    const home = join(STATE_ROOT, "users/trailing-user/codex-home");
    mkdirSync(home, { recursive: true });
    const hooksPath = join(home, "hooks.json");
    const user = {
      matcher: "user-tool",
      hooks: [
        { type: "command", command: "/tmp/user-hook-after-isomux" },
        { type: "command", command: "/tmp/second-user-hook-after-isomux" },
      ],
    };
    const beforeUser = isomuxEntry(
      "/tmp/old-state/bin/isomux-codex-safety-hook",
    );
    const duplicateBeforeUser = isomuxEntry(
      "/tmp/second-state/bin/isomux-codex-safety-hook",
    );
    const removable = isomuxEntry(
      "/tmp/third-state/bin/isomux-codex-safety-hook",
    );
    writeFileSync(
      hooksPath,
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [beforeUser, duplicateBeforeUser, user, removable],
          },
        },
        null,
        2,
      )}\n`,
    );
    const oldUserKey = `${hooksPath}:pre_tool_use:2:0`;
    const oldSecondUserKey = `${hooksPath}:pre_tool_use:2:1`;
    const userBody = [
      "enabled = true",
      'trusted_hash = "sha256:old-user"',
      "# keep-user-body-byte-identical",
    ].join("\n");
    const blocks = [0, 1, 3].map((index) =>
      [
        `[hooks.state.${JSON.stringify(`${hooksPath}:pre_tool_use:${index}:0`)}]`,
        "enabled = true",
        `trusted_hash = "sha256:old-${index}"`,
      ].join("\n"),
    );
    const staleRemovedSubIndex = `${hooksPath}:pre_tool_use:1:1`;
    blocks.splice(
      2,
      0,
      [
        `[hooks.state.${JSON.stringify(staleRemovedSubIndex)}]`,
        "enabled = true",
        'trusted_hash = "sha256:stale-removed-sub-index"',
      ].join("\n"),
    );
    blocks.splice(
      2,
      0,
      `[hooks.state.${JSON.stringify(oldUserKey)}]\n${userBody}`,
      [
        `[hooks.state.${JSON.stringify(oldSecondUserKey)}]`,
        "enabled = true",
        'trusted_hash = "sha256:old-second-user"',
      ].join("\n"),
    );
    writeFileSync(join(home, "config.toml"), `${blocks.join("\n")}\n`);

    expect((await ensureCodexSafetyHook(home)).warning).toBeNull();

    const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
    expect(hooks.hooks.PreToolUse).toEqual([
      isomuxEntry(CODEX_SAFETY_HOOK_PATH),
      user,
    ]);
    const configText = readFileSync(join(home, "config.toml"), "utf8");
    const config = Bun.TOML.parse(configText) as {
      hooks: {
        state: Record<string, { enabled: boolean; trusted_hash: string }>;
      };
    };
    const newUserKey = `${hooksPath}:pre_tool_use:1:0`;
    const newSecondUserKey = `${hooksPath}:pre_tool_use:1:1`;
    expect(config.hooks.state[newUserKey]).toEqual({
      enabled: true,
      trusted_hash: "sha256:old-user",
    });
    expect(config.hooks.state[newSecondUserKey]).toEqual({
      enabled: true,
      trusted_hash: "sha256:old-second-user",
    });
    expect(config.hooks.state[oldUserKey]).toBeUndefined();
    expect(config.hooks.state[oldSecondUserKey]).toBeUndefined();
    expect(config.hooks.state[`${hooksPath}:pre_tool_use:3:0`]).toBeUndefined();
    expect(Object.keys(config.hooks.state).sort()).toEqual(
      [
        `${hooksPath}:pre_tool_use:0:0`,
        newUserKey,
        newSecondUserKey,
      ].sort(),
    );
    expect(configText).toContain(
      `[hooks.state.${JSON.stringify(newUserKey)}]\n${userBody}`,
    );
  });

  it("fails open with the exact warning when hooks.json cannot be merged", async () => {
    const badHome = join(STATE_ROOT, "bad-codex-home");
    mkdirSync(badHome, { recursive: true });
    writeFileSync(join(badHome, "hooks.json"), "not json");
    const result = await ensureCodexSafetyHook(badHome);
    expect(result).toEqual({ warning: SAFETY_WARNING, hookIdentity: null });
  });

  it("keeps the test/probe preflight escape hatch out of production callers", () => {
    const root = resolve(import.meta.dir, "../..");
    const productionFiles = readdirSync(root, { recursive: true })
      .map(String)
      .filter(
        (path) =>
          path.endsWith(".ts") &&
          !path.endsWith(".test.ts") &&
          !path.endsWith("-probe.ts"),
      );
    for (const relative of productionFiles) {
      const source = readFileSync(resolve(root, relative), "utf8");
      expect(source).not.toContain("skipSafetyPreflightForTestProbe: true");
    }
    expect(root.endsWith("server")).toBe(true);
  });
});
