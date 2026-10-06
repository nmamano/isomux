import { accessSync, constants as fsConstants } from "fs";
import { spawnSync } from "child_process";

// Resolve an absolute path to a REAL Node.js binary for spawning the PTY
// sidecar. Bun.spawn(["node", …]) is unsafe here: if a launch env lacks `node`
// on PATH (cron, systemd-user, non-login SSH on macOS), Bun falls back to
// running ITSELF in node-compat mode under the name "node". The sidecar then
// loads node-pty's native binding under Bun's runtime, which doesn't drive
// the PTY correctly - terminal panel comes up blank/dead. Probe order:
//   1. ISOMUX_NODE_PATH override
//   2. Known absolute installs (Homebrew arm64, Homebrew/Linux x64,
//      distro Linux, MacPorts)
//   3. Bare "node" via PATH (still validated - Bun's node-compat answers
//      `process.versions.bun`, which we reject)
// Validation is `accessSync(X_OK)` + a one-shot `--exit-on-Bun` probe.
// Cached after the first probe; restart the server to re-resolve.
const NODE_CANDIDATES = [
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/usr/bin/node",
  "/opt/local/bin/node",
];

let cachedNodePath: string | null | undefined;

function probeRealNode(candidate: string): boolean {
  // X_OK check is path-form-aware: absolute paths get a direct executable
  // check; bare "node" would throw ENOENT here, so we skip and let spawnSync
  // do its own PATH lookup. Either way the version probe below is the final
  // arbiter - accessSync just rejects obviously-broken absolute paths fast.
  if (candidate.startsWith("/")) {
    try {
      accessSync(candidate, fsConstants.X_OK);
    } catch {
      return false;
    }
  }
  // Reject Bun's node-compat: under Bun, process.versions.bun is set.
  const result = spawnSync(
    candidate,
    [
      "-e",
      "process.exit(process.versions && process.versions.node && !process.versions.bun ? 0 : 1)",
    ],
    { timeout: 5000, stdio: "ignore" },
  );
  return result.status === 0;
}

export function resolveRealNode(): string | null {
  if (cachedNodePath !== undefined) return cachedNodePath;
  const override = process.env.ISOMUX_NODE_PATH;
  if (override) {
    if (probeRealNode(override)) {
      cachedNodePath = override;
      return cachedNodePath;
    }
    console.warn(
      `[terminal] ISOMUX_NODE_PATH=${override} did not validate as real Node; falling back to default probe`,
    );
  }
  for (const candidate of NODE_CANDIDATES) {
    if (probeRealNode(candidate)) {
      cachedNodePath = candidate;
      return cachedNodePath;
    }
  }
  if (probeRealNode("node")) {
    cachedNodePath = "node";
    return cachedNodePath;
  }
  cachedNodePath = null;
  return null;
}
