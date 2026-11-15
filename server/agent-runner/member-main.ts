// The one file of a member runner's runtime (internal-docs/member-os-user-design.md,
// section 1.1): the server bundles it with Bun.build and installs it in the
// member share. The first argument picks what this process is:
//
//   runner.js runner --socket <path> --server-uid <uid> [--socket-mode <octal>]
//   runner.js entry <name>     a fixed entry: one JSON value on stdin (a body
//                              may follow it), one out
//   runner.js pty              the terminal sidecar (server/pty-sidecar.ts)
//   runner.js opencode-helper  the OpenCode server helper
//                              (server/backends/opencode/start-server.ts)
//
// Each part is a dynamic import, so a process loads only its own part.

import { basename } from "path";

const ENTRIES: Record<string, () => Promise<unknown>> = {
  "attachment-copy": () => import("./entries/attachment-copy.ts"),
  diff: () => import("./entries/diff.ts"),
  "bun-path": () => import("./entries/bun-path.ts"),
  diagnose: () => import("./entries/diagnose.ts"),
  "codex-hook-config": () => import("./entries/codex-hook-config.ts"),
  "codex-trust-hash": () => import("./entries/codex-trust-hash.ts"),
  "empty-folder": () => import("./entries/empty-folder.ts"),
  "files-in": () => import("./entries/files-in.ts"),
  "files-place": () => import("./entries/files-place.ts"),
  "files-undo": () => import("./entries/files-undo.ts"),
  "files-done": () => import("./entries/files-done.ts"),
  "files-out": () => import("./entries/files-out.ts"),
  "files-remove": () => import("./entries/files-remove.ts"),
  "file-read": () => import("./entries/file-read.ts"),
  "claude-cwd-move": () => import("./entries/claude-cwd-move.ts"),
  "folder-files": () => import("./entries/folder-files.ts"),
  "opencode-inspect": () => import("./entries/opencode-inspect.ts"),
  "project-skills": () => import("./entries/project-skills.ts"),
  "project-skill": () => import("./entries/project-skill.ts"),
  "session-move": () => import("./entries/session-move.ts"),
  "skill-folder": () => import("./entries/skill-folder.ts"),
  "user-skills": () => import("./entries/user-skills.ts"),
  "user-skill": () => import("./entries/user-skill.ts"),
  "url-probe": () => import("./entries/url-probe.ts"),
};

export const MEMBER_ENTRY_NAMES = Object.keys(ENTRIES);

// The runtime folder is runtime/<hash>/ (member-runtime.ts); Bun resolves
// the runtime/current link, so this is the hash that this process runs.
function bundleHash(): string | null {
  const name = basename(import.meta.dir);
  return /^[0-9a-f]{64}$/.test(name) ? name : null;
}

const [verb, ...rest] = process.argv.slice(2);
if (verb === "runner") {
  const { runnerMain } = await import("./runner.ts");
  const hash = bundleHash();
  runnerMain(rest, hash ? { path: Bun.main, hash } : undefined);
} else if (
  verb === "entry" &&
  rest.length === 1 &&
  Object.hasOwn(ENTRIES, rest[0])
) {
  await ENTRIES[rest[0]]();
} else if (verb === "pty" && rest.length === 0) {
  await import("../pty-sidecar.ts");
} else if (verb === "opencode-helper" && rest.length === 0) {
  await import("../backends/opencode/start-server.ts");
} else {
  console.error(
    "usage: runner.js runner --socket <path> --server-uid <uid> | entry <name> | pty | opencode-helper",
  );
  process.exit(2);
}
