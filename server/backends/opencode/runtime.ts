import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const OPENCODE_CLI_VERSION = "1.18.23";

// The supervisor's record lock, process identity and the office proxy's peer
// credential check exist for Linux and macOS only, so OpenCode does too, even
// where opencode-ai ships a binary (it ships Windows builds).
export function openCodeUnsupportedReason(
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform === "linux" || platform === "darwin") return null;
  return `OpenCode agents need a Linux or macOS host. This office runs on ${platform}.`;
}

// Its message is a fixed Isomux string with no provider data, so the chat can
// show it where other transport errors are reduced to name and status.
export class OpenCodeUnsupportedHostError extends Error {
  override name = "OpenCodeUnsupportedHostError";
}

export function resolveOpenCodeBinary(
  platform: NodeJS.Platform = process.platform,
): string {
  const unsupported = openCodeUnsupportedReason(platform);
  if (unsupported) throw new OpenCodeUnsupportedHostError(unsupported);
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (platform === "darwin") return resolveDarwinBinary(arch);
  const base = `opencode-linux-${arch}`;
  const baseline = arch === "x64" && !hasAvx2();
  const musl = existsSync("/etc/alpine-release");
  const variants = musl
    ? baseline
      ? [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base]
      : [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`]
    : baseline
      ? [`${base}-baseline`, base]
      : [base, `${base}-baseline`];
  return firstInstalledBinary(variants);
}

function resolveDarwinBinary(arch: "arm64" | "x64"): string {
  const base = `opencode-darwin-${arch}`;
  if (arch === "arm64") return firstInstalledBinary([base]);
  return firstInstalledBinary(
    hasDarwinAvx2() ? [base, `${base}-baseline`] : [`${base}-baseline`, base],
  );
}

function firstInstalledBinary(variants: string[]): string {
  for (const packageName of variants) {
    const path = join(
      import.meta.dir,
      "../../../node_modules",
      packageName,
      "bin",
      "opencode",
    );
    if (existsSync(path)) return path;
  }
  throw new Error(
    `Pinned OpenCode ${OPENCODE_CLI_VERSION} binary is missing for ${process.platform}/${process.arch}.`,
  );
}

// The same probe opencode-ai's own postinstall uses on Intel Macs.
function hasDarwinAvx2(): boolean {
  const result = spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], {
    encoding: "utf8",
    timeout: 5000,
  });
  return result.status === 0 && result.stdout.trim() === "1";
}

function hasAvx2(): boolean {
  try {
    return /(^|\s)avx2(\s|$)/i.test(readFileSync("/proc/cpuinfo", "utf8"));
  } catch {
    return false;
  }
}
