// Test-only fixtures for the live Codex PreToolUse probe. These helpers do
// not install hooks for Isomux agents. They only write isolated CODEX_HOME
// replicas selected by the caller.
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { basename, join } from "path";
import { createHash } from "crypto";

export type HookBehavior =
  | "allow"
  | "deny"
  | "malformed"
  | "exit"
  | "missing"
  | "hang"
  | "self-timeout";

export interface HookFixture {
  home: string;
  hookPath: string;
  hooksPath: string;
  invocationsPath: string;
}

export function writeHookFixture(
  home: string,
  behavior: HookBehavior,
  timeoutSec?: number,
): HookFixture {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const hookPath = join(home, "probe-hook.sh");
  const hooksPath = join(home, "hooks.json");
  const invocationsPath = join(home, "hook-invocations.jsonl");

  if (behavior !== "missing") {
    const action =
      behavior === "deny"
        ? `printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"isomux live probe denied"}}'`
        : behavior === "malformed"
          ? `printf '%s\\n' 'not-json'`
          : behavior === "exit"
            ? `printf '%s\\n' 'probe launch failure' >&2; exit 17`
            : behavior === "hang"
              ? `sleep 30`
              : behavior === "self-timeout"
                ? `timeout 0.05s sleep 30 >/dev/null 2>&1 || true; printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"isomux hook deadline exceeded"}}'`
                : `printf '%s\\n' '{}'`;
    writeFileSync(
      hookPath,
      [
        "#!/bin/sh",
        "payload=$(dd bs=1048576 count=1 2>/dev/null)",
        `printf '%s\\n' "$payload" >> '${invocationsPath}'`,
        action,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(hookPath, 0o755);
  }

  const command: Record<string, unknown> = {
    type: "command",
    command: hookPath,
  };
  if (timeoutSec !== undefined) command.timeout = timeoutSec;
  writeFileSync(
    hooksPath,
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [{ matcher: ".*", hooks: [command] }],
        },
      },
      null,
      2,
    ),
  );
  return { home, hookPath, hooksPath, invocationsPath };
}

export function trustHook(fixture: HookFixture, currentHash: string): void {
  const key = `${fixture.hooksPath}:pre_tool_use:0:0`;
  writeFileSync(
    join(fixture.home, "config.toml"),
    [
      `[hooks.state.${JSON.stringify(key)}]`,
      "enabled = true",
      `trusted_hash = ${JSON.stringify(currentHash)}`,
      "",
    ].join("\n"),
  );
}

export function copyScratchAuth(
  sourceHome: string,
  targetHome: string,
): string {
  const source = join(sourceHome, "auth.json");
  const target = join(targetHome, "auth.json");
  copyFileSync(source, target, 0);
  chmodSync(target, 0o600);
  return basename(source);
}

export function readHookPayloads(path: string): unknown[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export function hookEntryHash(entry: unknown): string {
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}
