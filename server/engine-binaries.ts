// Where the bundled engine binaries are: the files a host runs for Claude,
// Codex and OpenCode, and the office's engine paths built from them. A leaf:
// it imports no host and no engine protocol code, so process placement
// (agent-host.ts, member-hosts.ts) and the engines can both use it.

import { existsSync, readFileSync } from "fs";
import { delimiter, dirname, join } from "path";
import { errMessage } from "../shared/errors.ts";
import type { AgentHost } from "./agent-host.ts";
import { resolveOpenCodeBinary } from "./backends/opencode/runtime.ts";
import { RUNTIME_ROOT } from "./runtime-root.ts";

// Path to the Claude CLI native binary that ships with the Agent SDK.
// The SDK's auto-resolver tries the musl variant first on Linux, which fails
// on glibc systems (ENOENT on /lib/ld-musl-*.so.1 when execve runs the binary).
// We resolve explicitly and pass it as pathToClaudeCodeExecutable so every
// libc gets the right binary.
function resolveClaudeNativeBinary(): string {
  const anthropicDir = join(RUNTIME_ROOT, "node_modules", "@anthropic-ai");
  const binName = process.platform === "win32" ? "claude.exe" : "claude";
  if (process.platform === "linux") {
    const muslArch = process.arch === "arm64" ? "aarch64" : "x86_64";
    const isMusl = existsSync(`/lib/ld-musl-${muslArch}.so.1`);
    const variants = isMusl
      ? [`linux-${process.arch}-musl`, `linux-${process.arch}`]
      : [`linux-${process.arch}`, `linux-${process.arch}-musl`];
    for (const v of variants) {
      const p = join(anthropicDir, `claude-agent-sdk-${v}`, binName);
      if (existsSync(p)) return p;
    }
  }
  return join(
    anthropicDir,
    `claude-agent-sdk-${process.platform}-${process.arch}`,
    binName,
  );
}

export const CLAUDE_NATIVE_BIN = resolveClaudeNativeBinary();

// PATH with the bundled binary's directory appended, so `claude` in the
// office's terminals and agent shells runs the agents' version. Last, so a
// claude earlier on PATH wins.
export function pathWithBundledClaude(path: string, bin: string): string {
  const dir = dirname(bin);
  if (path === "") return dir;
  return path.split(delimiter).includes(dir)
    ? path
    : `${path}${delimiter}${dir}`;
}

// The checkout, whose package.json pins the Codex version.
const ISOMUX_ROOT = join(import.meta.dir, "..");

let cachedLauncherPath: string | null = null;
let cachedPinnedVersion: string | null = null;

// The Codex CLI ships as @openai/codex (a JS launcher) plus per-platform
// optional-dependency packages that contain the native binary and a bundled
// ripgrep. We spawn the launcher with `process.execPath` (Bun) rather than
// relying on `node` being on PATH; the launcher's PATH-munging keeps codex's
// internal ripgrep call working without us having to replicate that here.
//
// Resolve the bundled @openai/codex launcher path. Lazy + cached: module-load
// resolution would crash server boot on a corrupt install, which is the wrong
// failure mode for an optional backend. On miss we throw a targeted error
// the spawn / login-card paths can translate into a user-actionable hint.
export function resolveCodexLauncherPath(): string {
  if (cachedLauncherPath) return cachedLauncherPath;
  let resolved: string;
  try {
    resolved = Bun.resolveSync("@openai/codex/bin/codex.js", RUNTIME_ROOT);
  } catch (err) {
    throw new Error(
      `Bundled @openai/codex launcher could not be resolved (${errMessage(err)}). ` +
        `Run \`bun install\` in the Isomux checkout.`,
      { cause: err },
    );
  }
  if (!existsSync(resolved)) {
    throw new Error(
      `Bundled @openai/codex launcher missing at ${resolved}. ` +
        `Run \`bun install\` in the Isomux checkout.`,
    );
  }
  cachedLauncherPath = resolved;
  // Happy-path resolve is silent - users don't need a per-boot
  // confirmation that the bundled launcher resolved. Set
  // ISOMUX_CODEX_LAUNCHER_LOG=1 to emit the one-shot breadcrumb when
  // debugging whether a stray global codex is shadowing the bundled one.
  if (process.env.ISOMUX_CODEX_LAUNCHER_LOG === "1") {
    try {
      console.log(
        `[codex] using bundled launcher: ${resolved} (pinned ${getCodexPinnedVersion()})`,
      );
    } catch {}
  }
  return resolved;
}

// Pinned codex CLI version, derived from package.json so version-bumps stay
// single-edit (the failure mode this whole task is about eliminating). Cached
// because the package.json doesn't change at runtime.
export function getCodexPinnedVersion(): string {
  if (cachedPinnedVersion) return cachedPinnedVersion;
  const pkgPath = join(ISOMUX_ROOT, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const spec = pkg.dependencies?.["@openai/codex"];
  if (!spec) {
    throw new Error(
      "Could not find @openai/codex in package.json dependencies",
    );
  }
  // Strip leading ^/~/= so callers get a bare semver. `bun add` writes
  // an exact pin by default (no ^), but tolerate both forms.
  cachedPinnedVersion = spec.replace(/^[\^~=]/, "");
  return cachedPinnedVersion;
}

export const PTY_SIDECAR_PATH = join(import.meta.dir, "pty-sidecar.ts");
export const OPENCODE_HELPER_PATH = join(
  import.meta.dir,
  "backends",
  "opencode",
  "start-server.ts",
);

// The office's engine paths, for the local host and the split runner, which
// both run from the code tree. The terminal sidecar runs under the host's
// own Bun (`this.bunPath()`).
export const officeEnginePaths: Pick<
  AgentHost,
  | "claudeBin"
  | "codexLauncher"
  | "openCodeBin"
  | "ptySidecarArgv"
  | "openCodeHelperArgv"
> = {
  claudeBin: () => CLAUDE_NATIVE_BIN,
  codexLauncher: () => resolveCodexLauncherPath(),
  openCodeBin: (platform) => resolveOpenCodeBinary(platform),
  ptySidecarArgv(this: AgentHost) {
    return [this.bunPath(), PTY_SIDECAR_PATH];
  },
  openCodeHelperArgv: () => [process.execPath, "run", OPENCODE_HELPER_PATH],
};
