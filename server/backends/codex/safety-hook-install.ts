/** Install and verify the mandatory Codex PreToolUse safety hook. */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { errMessage } from "../../../shared/errors.ts";
import { STATE_ROOT } from "../../config.ts";
import {
  buildCodexSafetyHook,
  hashCodexSafetyHookSources,
} from "./safety-hook-build.ts";
import { SAFETY_WARNING } from "./safety-hook.ts";
import { getCodexPinnedVersion } from "./native-bin.ts";

export const CODEX_SAFETY_HOOK_PATH = join(
  STATE_ROOT,
  "bin/isomux-codex-safety-hook",
);
const GOLDEN_HOOK_PATH = join(
  STATE_ROOT,
  "bin/.isomux-codex-safety-hook.golden",
);
const TRUST_SENTINEL = "# isomux-managed-codex-safety-hook";
export const CODEX_HOOK_TRUST_HASH_PROVEN_VERSION = "0.144.6";

export interface CodexSafetyHookIdentity {
  sourcePath: string;
  displayOrder: number;
}

export interface CodexSafetyPreflightResult {
  warning: string | null;
  hookIdentity: CodexSafetyHookIdentity | null;
}

interface PreparedArtifact {
  path: string;
  sha256: string;
  sourceSha256: string;
  trustedHash: string;
}

interface HookCommand {
  type?: unknown;
  command?: unknown;
  timeout?: unknown;
  [key: string]: unknown;
}

interface HookMatcher {
  matcher?: unknown;
  hooks?: unknown;
  [key: string]: unknown;
}

interface HooksFile {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

let preparation: Promise<PreparedArtifact> | null = null;
let trustMeasurement: Promise<string> | null = null;

async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) hasher.update(chunk);
  return hasher.digest("hex");
}

async function executableStamp(path: string): Promise<string> {
  const child = Bun.spawn([path, "--source-hash"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `artifact stamp exited ${exitCode}: ${stderr.trim() || "no stderr"}`,
    );
  }
  return stdout.trim();
}

async function prepareArtifact(): Promise<PreparedArtifact> {
  if (getCodexPinnedVersion() !== CODEX_HOOK_TRUST_HASH_PROVEN_VERSION) {
    throw new Error(
      `Codex hook trust measurement is pinned to ${CODEX_HOOK_TRUST_HASH_PROVEN_VERSION}, found ${getCodexPinnedVersion()}`,
    );
  }
  mkdirSync(dirname(GOLDEN_HOOK_PATH), { recursive: true, mode: 0o700 });
  const source = await hashCodexSafetyHookSources();
  let rebuild = !existsSync(GOLDEN_HOOK_PATH);
  if (!rebuild) {
    try {
      const stamp = await executableStamp(GOLDEN_HOOK_PATH);
      rebuild = stamp !== source.sha256;
      if (rebuild) {
        console.error(
          `[codex safety] stale artifact: embedded ${stamp || "<empty>"}, source ${source.sha256}; rebuilding`,
        );
      }
    } catch (err) {
      rebuild = true;
      console.error(
        `[codex safety] artifact unavailable during stamp check: ${errMessage(err)}; rebuilding`,
      );
    }
  }
  if (rebuild) {
    const temporary = `${GOLDEN_HOOK_PATH}.new-${process.pid}-${Date.now()}`;
    try {
      await buildCodexSafetyHook(temporary);
      renameSync(temporary, GOLDEN_HOOK_PATH);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  const stamp = await executableStamp(GOLDEN_HOOK_PATH);
  if (stamp !== source.sha256) {
    throw new Error(
      `rebuilt artifact stamp mismatch: expected ${source.sha256}, received ${stamp || "<empty>"}`,
    );
  }
  return {
    path: GOLDEN_HOOK_PATH,
    sha256: await sha256File(GOLDEN_HOOK_PATH),
    sourceSha256: source.sha256,
    trustedHash: await measuredTrustedHash(),
  };
}

function measuredTrustedHash(): Promise<string> {
  trustMeasurement ??= discoverTrustedHash().catch((err) => {
    trustMeasurement = null;
    throw err;
  });
  return trustMeasurement;
}

async function discoverTrustedHash(): Promise<string> {
  const { discoverCodexHookTrustedHash } =
    await import("./safety-hook-trust-probe.ts");
  return discoverCodexHookTrustedHash(CODEX_SAFETY_HOOK_PATH);
}

export function prepareCodexSafetyHookArtifact(): Promise<void> {
  preparation ??= prepareArtifact();
  return preparation.then(
    () => undefined,
    (err) => {
      preparation = null;
      throw err;
    },
  );
}

async function preparedArtifact(): Promise<PreparedArtifact> {
  preparation ??= prepareArtifact();
  try {
    return await preparation;
  } catch (err) {
    preparation = null;
    throw err;
  }
}

function ownedMatcher(): HookMatcher {
  return {
    matcher: ".*",
    hooks: [{ type: "command", command: CODEX_SAFETY_HOOK_PATH }],
  };
}

function isOwnedMatcher(value: unknown): value is HookMatcher {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const matcher = value as HookMatcher;
  if (!Array.isArray(matcher.hooks)) return false;
  return matcher.hooks.some(
    (hook) =>
      !!hook &&
      typeof hook === "object" &&
      !Array.isArray(hook) &&
      (hook as HookCommand).command === CODEX_SAFETY_HOOK_PATH,
  );
}

function atomicWriteText(path: string, text: string, mode = 0o600): void {
  const temporary = `${path}.new-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, text, { mode });
  renameSync(temporary, path);
}

function mergeHooksFile(codexHome: string): {
  hooksPath: string;
  matcherIndex: number;
} {
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const hooksPath = join(codexHome, "hooks.json");
  const original = existsSync(hooksPath) ? readFileSync(hooksPath, "utf8") : "";
  const parsed = original ? (JSON.parse(original) as HooksFile) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("hooks.json root is not an object");
  }
  if (
    parsed.hooks !== undefined &&
    (!parsed.hooks ||
      typeof parsed.hooks !== "object" ||
      Array.isArray(parsed.hooks))
  ) {
    throw new Error("hooks.json hooks value is not an object");
  }
  const hooks = parsed.hooks ? { ...parsed.hooks } : {};
  const current = hooks.PreToolUse;
  if (current !== undefined && !Array.isArray(current)) {
    throw new Error("hooks.json PreToolUse value is not an array");
  }
  const matchers = Array.isArray(current) ? [...current] : [];
  const ownedIndices = matchers
    .map((matcher, index) => (isOwnedMatcher(matcher) ? index : -1))
    .filter((index) => index >= 0);
  let matcherIndex: number;
  if (ownedIndices.length === 0) {
    matcherIndex = matchers.length;
    matchers.push(ownedMatcher());
  } else {
    matcherIndex = ownedIndices[0];
    const existing = matchers[matcherIndex] as HookMatcher;
    if (!Array.isArray(existing.hooks) || existing.hooks.length !== 1) {
      throw new Error("Isomux hook group contains additional user hooks");
    }
    if (ownedIndices.length > 1) {
      const lastOwned = ownedIndices[ownedIndices.length - 1];
      if (
        matchers
          .slice(matcherIndex + 1, lastOwned)
          .some((m) => !isOwnedMatcher(m))
      ) {
        throw new Error(
          "duplicate Isomux hook groups surround user hook groups",
        );
      }
      for (let index = ownedIndices.length - 1; index >= 1; index--) {
        matchers.splice(ownedIndices[index], 1);
      }
    }
    matchers[matcherIndex] = ownedMatcher();
  }
  hooks.PreToolUse = matchers;
  parsed.hooks = hooks;
  const next = `${JSON.stringify(parsed, null, 2)}\n`;
  if (next !== original) atomicWriteText(hooksPath, next);
  return {
    hooksPath,
    matcherIndex,
  };
}

function removeOwnedTrustBlocks(text: string, currentKey: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; ) {
    const ownedHeader = `[hooks.state.${JSON.stringify(currentKey)}]`;
    if (lines[index] === ownedHeader) {
      if (kept[kept.length - 1] === TRUST_SENTINEL) kept.pop();
      index++;
      // Isomux always appends its trust block last. This bracket scan is safe
      // only under that invariant; it must not parse arbitrary user TOML.
      while (index < lines.length && !/^\s*\[/.test(lines[index])) index++;
      continue;
    }
    kept.push(lines[index++]);
  }
  return kept.join("\n").replace(/\n+$/, "");
}

function trustKey(hooksPath: string, matcherIndex: number): string {
  return `${hooksPath}:pre_tool_use:${matcherIndex}:0`;
}

function handlerDisplayOrder(
  matchers: unknown[],
  matcherIndex: number,
): number {
  let displayOrder = 0;
  for (let index = 0; index < matcherIndex; index++) {
    const hooks = (matchers[index] as HookMatcher | undefined)?.hooks;
    if (!Array.isArray(hooks)) {
      throw new Error(`PreToolUse matcher ${index} has no hooks array`);
    }
    displayOrder += hooks.length;
  }
  return displayOrder;
}

function mergeTrustConfig(
  codexHome: string,
  hooksPath: string,
  matcherIndex: number,
  trustedHash: string,
): void {
  const configPath = join(codexHome, "config.toml");
  const original = existsSync(configPath)
    ? readFileSync(configPath, "utf8")
    : "";
  const key = trustKey(hooksPath, matcherIndex);
  // Ownership is decided from current live hook state: this key resolves to
  // the matcher whose command is our installed path. The sentinel is only a
  // secondary marker. A detached sentinel or stale positional key that now
  // resolves to a user matcher is never removed.
  const base = removeOwnedTrustBlocks(original, key);
  const block = [
    TRUST_SENTINEL,
    `[hooks.state.${JSON.stringify(key)}]`,
    "enabled = true",
    `trusted_hash = ${JSON.stringify(trustedHash)}`,
  ].join("\n");
  const next = `${base ? `${base}\n\n` : ""}${block}\n`;
  Bun.TOML.parse(next);
  if (next !== original) atomicWriteText(configPath, next);
}

function verifyConfiguration(
  codexHome: string,
  hooksPath: string,
  matcherIndex: number,
  trustedHash: string,
): CodexSafetyHookIdentity {
  const hooksFile = JSON.parse(readFileSync(hooksPath, "utf8")) as HooksFile;
  const matchers = hooksFile.hooks?.PreToolUse;
  if (!Array.isArray(matchers) || !isOwnedMatcher(matchers[matcherIndex])) {
    throw new Error("post-write hooks.json verification failed");
  }
  const matcher = matchers[matcherIndex];
  if (matcher.matcher !== ".*" || !Array.isArray(matcher.hooks)) {
    throw new Error("post-write Isomux matcher verification failed");
  }
  const command = matcher.hooks[0] as HookCommand;
  if (
    matcher.hooks.length !== 1 ||
    command.type !== "command" ||
    command.command !== CODEX_SAFETY_HOOK_PATH ||
    "timeout" in command ||
    !trustedHash.startsWith("sha256:")
  ) {
    throw new Error("post-write Isomux command verification failed");
  }
  const config = Bun.TOML.parse(
    readFileSync(join(codexHome, "config.toml"), "utf8"),
  ) as Record<string, unknown>;
  const state = (config.hooks as Record<string, unknown> | undefined)?.state as
    | Record<string, { enabled?: unknown; trusted_hash?: unknown }>
    | undefined;
  const trust = state?.[trustKey(hooksPath, matcherIndex)];
  if (trust?.enabled !== true || trust.trusted_hash !== trustedHash) {
    throw new Error("post-write trust verification failed");
  }
  return {
    sourcePath: hooksPath,
    displayOrder: handlerDisplayOrder(matchers, matcherIndex),
  };
}

async function repairInstalledArtifact(
  artifact: PreparedArtifact,
): Promise<void> {
  const goldenHash = await sha256File(artifact.path);
  if (goldenHash !== artifact.sha256) {
    throw new Error("golden artifact content no longer matches its boot hash");
  }
  mkdirSync(dirname(CODEX_SAFETY_HOOK_PATH), {
    recursive: true,
    mode: 0o700,
  });
  const temporary = `${CODEX_SAFETY_HOOK_PATH}.new-${process.pid}-${Date.now()}`;
  try {
    await Bun.write(temporary, Bun.file(artifact.path));
    chmodSync(temporary, 0o700);
    renameSync(temporary, CODEX_SAFETY_HOOK_PATH);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function ensureCodexSafetyHook(
  codexHome: string,
): Promise<CodexSafetyPreflightResult> {
  try {
    let artifact: PreparedArtifact;
    try {
      artifact = await preparedArtifact();
    } catch (err) {
      console.error(
        `[codex safety] artifact unavailable: ${errMessage(err)}; ${SAFETY_WARNING}`,
      );
      return { warning: SAFETY_WARNING, hookIdentity: null };
    }

    let installedHash: string | null = null;
    try {
      installedHash = await sha256File(CODEX_SAFETY_HOOK_PATH);
    } catch {}
    if (installedHash !== artifact.sha256) {
      console.error(
        `[codex safety] content mismatch: expected ${artifact.sha256}, received ${installedHash ?? "<missing>"}; repairing`,
      );
      try {
        await repairInstalledArtifact(artifact);
      } catch (err) {
        console.error(
          `[codex safety] repair write failed: ${errMessage(err)}; ${SAFETY_WARNING}`,
        );
        return { warning: SAFETY_WARNING, hookIdentity: null };
      }
    }
    try {
      const repairedHash = await sha256File(CODEX_SAFETY_HOOK_PATH);
      if (repairedHash !== artifact.sha256) {
        throw new Error(
          `expected ${artifact.sha256}, received ${repairedHash}`,
        );
      }
      chmodSync(CODEX_SAFETY_HOOK_PATH, 0o700);
    } catch (err) {
      console.error(
        `[codex safety] installed artifact verification failed: ${errMessage(err)}; ${SAFETY_WARNING}`,
      );
      return { warning: SAFETY_WARNING, hookIdentity: null };
    }

    let merged: ReturnType<typeof mergeHooksFile>;
    try {
      merged = mergeHooksFile(codexHome);
    } catch (err) {
      console.error(
        `[codex safety] hooks.json merge failed: ${errMessage(err)}; ${SAFETY_WARNING}`,
      );
      return { warning: SAFETY_WARNING, hookIdentity: null };
    }
    try {
      mergeTrustConfig(
        codexHome,
        merged.hooksPath,
        merged.matcherIndex,
        artifact.trustedHash,
      );
    } catch (err) {
      console.error(
        `[codex safety] config.toml write failed: ${errMessage(err)}; ${SAFETY_WARNING}`,
      );
      return { warning: SAFETY_WARNING, hookIdentity: null };
    }
    try {
      return {
        warning: null,
        hookIdentity: verifyConfiguration(
          codexHome,
          merged.hooksPath,
          merged.matcherIndex,
          artifact.trustedHash,
        ),
      };
    } catch (err) {
      console.error(
        `[codex safety] hook configuration verification failed: ${errMessage(err)}; ${SAFETY_WARNING}`,
      );
      return { warning: SAFETY_WARNING, hookIdentity: null };
    }
  } catch (err) {
    console.error(
      `[codex safety] unexpected preflight failure: ${errMessage(err)}; ${SAFETY_WARNING}`,
    );
    return { warning: SAFETY_WARNING, hookIdentity: null };
  }
}

export const _test = {
  resetPreparation(): void {
    preparation = null;
  },
  goldenPath: GOLDEN_HOOK_PATH,
  trustSentinel: TRUST_SENTINEL,
  discoverTrustedHash,
};
