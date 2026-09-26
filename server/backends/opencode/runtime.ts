import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const OPENCODE_CLI_VERSION = "1.18.23";

// The supervisor's flock launch, /proc process identity and the office
// proxy's SO_PEERCRED check are Linux-only, so OpenCode is too, even where
// opencode-ai ships a binary (it ships darwin builds).
export function openCodeUnsupportedReason(
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform === "linux") return null;
  const host = platform === "darwin" ? "macOS" : platform;
  return `OpenCode agents need a Linux host. This office runs on ${host}.`;
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

function hasAvx2(): boolean {
  try {
    return /(^|\s)avx2(\s|$)/i.test(readFileSync("/proc/cpuinfo", "utf8"));
  } catch {
    return false;
  }
}
