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
    const config = Bun.TOML.parse(configText) as any;
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
