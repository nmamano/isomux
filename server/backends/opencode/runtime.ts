import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const OPENCODE_CLI_VERSION = "1.18.23";

export function resolveOpenCodeBinary(): string {
  if (process.platform !== "linux") {
    throw new Error(
      `OpenCode ${OPENCODE_CLI_VERSION} is not packaged for ${process.platform}.`,
    );
  }
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
