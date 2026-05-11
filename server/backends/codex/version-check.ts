// Codex CLI version check.
//
// The generated TS schemas under server/backends/codex/_generated/ are tied to
// a specific Codex CLI version. If the installed binary drifts, the wire
// shapes can diverge: new fields go unread, removed fields throw, renamed
// notifications miss the dispatch table. We pin the version here and log a
// prominent warning at boot if the installed binary doesn't match.
//
// We don't exit the process on mismatch — Codex backend is optional and
// existing Claude agents must keep running. The Codex agent spawn path
// will refuse to start agents when this check fails (wired in step 8).
//
// Pinning policy: bump CODEX_CLI_PINNED_VERSION whenever the schemas are
// regenerated against a new codex binary. Regen is `bun run
// gen:codex-schemas` after `sudo npm install -g @openai/codex@<version>`.

import { spawn } from "child_process";

export const CODEX_CLI_PINNED_VERSION = "0.130.0";

export type CodexVersionStatus =
  | { kind: "ok"; version: string }
  | { kind: "mismatch"; installed: string; expected: string }
  | { kind: "not_installed"; message: string }
  | { kind: "unknown"; message: string };

let cached: CodexVersionStatus | null = null;

export function getCodexVersionStatus(): CodexVersionStatus | null {
  return cached;
}

// Run `codex --version` and classify the result. Resolves with the status —
// never rejects. Memoizes the first call so repeat boots (or anyone who
// imports this) don't keep spawning the binary.
export async function checkCodexVersion(): Promise<CodexVersionStatus> {
  if (cached) return cached;
  const result = await new Promise<CodexVersionStatus>((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("codex", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        resolve({
          kind: "not_installed",
          message:
            "codex CLI not found on PATH. Codex agents will be disabled. " +
            "Install with `sudo npm install -g @openai/codex@" + CODEX_CLI_PINNED_VERSION + "` if you want to use them.",
        });
      } else {
        resolve({ kind: "unknown", message: `codex --version errored: ${err.message}` });
      }
    });
    child.on("close", (code: number | null) => {
      if (code !== 0) {
        const stderrText = stderr.trim().slice(0, 200);
        resolve({ kind: "unknown", message: `codex --version exited with code ${code}${stderrText ? `: ${stderrText}` : ""}` });
        return;
      }
      const trimmed = stdout.trim();
      // Expected format: `codex-cli 0.130.0` (per spec). Match the version
      // suffix permissively so cosmetic changes to the prefix don't break us.
      const match = trimmed.match(/\b(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/);
      const installed = match ? match[1] : trimmed;
      if (installed === CODEX_CLI_PINNED_VERSION) {
        resolve({ kind: "ok", version: installed });
      } else {
        resolve({ kind: "mismatch", installed, expected: CODEX_CLI_PINNED_VERSION });
      }
    });
  });
  cached = result;
  return result;
}

// Log the version-check outcome at boot. Loud warning on mismatch with the
// regen instructions; quiet noop on ok; informational note on not-installed.
export async function logCodexVersionAtBoot(): Promise<void> {
  const status = await checkCodexVersion();
  switch (status.kind) {
    case "ok":
      console.log(`[codex] CLI ${status.version} matches pinned version — schemas are valid.`);
      break;
    case "not_installed":
      console.log(`[codex] ${status.message}`);
      break;
    case "mismatch":
      console.error(
        `[codex] WARNING: installed CLI version ${status.installed} does not match pinned ${status.expected}. ` +
        `Generated schemas under server/backends/codex/_generated/ are tied to ${status.expected} and may not match the running CLI. ` +
        `To resolve: \`sudo npm install -g @openai/codex@${status.expected}\` (downgrade), or regenerate against the installed version with \`bun run gen:codex-schemas\` and update CODEX_CLI_PINNED_VERSION in server/backends/codex/version-check.ts.`
      );
      break;
    case "unknown":
      console.error(`[codex] WARNING: could not determine CLI version — ${status.message}`);
      break;
  }
}
