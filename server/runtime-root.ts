// The folder whose node_modules holds the engine packages (Claude, Codex,
// OpenCode): the checkout, or, in a member runner's bundle
// (agent-runner/member-main.ts), the runtime folder that holds the bundle.
// The server defines ISOMUX_MEMBER_BUNDLE when it builds the bundle
// (member-runtime.ts); in the bundle, import.meta.dir is the bundle's folder.

import { resolve } from "path";

declare const ISOMUX_MEMBER_BUNDLE: boolean;

export const IN_MEMBER_BUNDLE =
  typeof ISOMUX_MEMBER_BUNDLE !== "undefined" && ISOMUX_MEMBER_BUNDLE === true;

export const RUNTIME_ROOT = IN_MEMBER_BUNDLE
  ? import.meta.dir
  : resolve(import.meta.dir, "..");
