// Tests skipped under INTEL_MAC are a known Intel macOS gap, not a quarantine:
// Nil ruled on 2026-10-12 (tasks 98b167aa, 7cf318ac) and again on 2026-11-08
// (task bf315229, all four skips) that the fix work on Intel is not wanted.
// The macos-15-intel job still boots the office in CI.
export const INTEL_MAC =
  process.platform === "darwin" && process.arch === "x64";
