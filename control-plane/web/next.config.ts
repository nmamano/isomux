import * as path from "node:path";
import type { NextConfig } from "next";

/**
 * The repository root, and it has to be this rather than the package directory.
 *
 * This app is a package inside the repository, and the code it exists to serve -
 * the signup and projection services - lives one level up in `control-plane/`.
 * Turbopack refuses to resolve anything above its root, so pointing the root at
 * this directory made every service import a "module not found". The repository
 * root is also the honest answer to the question Next asks when it finds two
 * lockfiles: this IS the workspace.
 */
const repoRoot = path.join(import.meta.dirname, "..", "..");

const config: NextConfig = {
  // `next dev` otherwise writes AGENTS.md and CLAUDE.md into this directory and
  // re-creates them when they are removed. Agent instructions that appear from
  // a dependency are not something this repository carries silently, and
  // CLAUDE.md is not ours to write.
  agentRules: false,
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
};

export default config;
