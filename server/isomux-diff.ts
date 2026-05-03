import type { DiffFileSummary, DiffPayload } from "../shared/types.ts";
import { execSync } from "child_process";
import { closeSync, openSync, readSync, statSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { homedir } from "os";

export type ComputeDiffResult =
  | { kind: "ok"; cwd: string; summary: string; payload: DiffPayload }
  | { kind: "clean"; cwd: string }
  | { kind: "not_repo"; cwd: string }
  | { kind: "git_error"; cwd: string; message: string };

export type ResolveDirResult =
  | { kind: "ok"; cwd: string }
  | { kind: "bad_dir"; attempted: string };

// Resolve an optional user-supplied directory against the agent's cwd.
// `~` expands to the user's home; relative paths resolve against `agentCwd`;
// absolute paths win. Validates that the result exists and is a directory.
export function resolveDiffCwd(rawDir: string | undefined, agentCwd: string): ResolveDirResult {
  const trimmed = rawDir?.trim();
  if (!trimmed) return { kind: "ok", cwd: agentCwd };
  const expanded = trimmed.startsWith("~")
    ? join(homedir(), trimmed.slice(1).replace(/^[/\\]/, ""))
    : trimmed;
  const abs = isAbsolute(expanded) ? expanded : resolve(agentCwd, expanded);
  try {
    if (!statSync(abs).isDirectory()) return { kind: "bad_dir", attempted: abs };
  } catch {
    return { kind: "bad_dir", attempted: abs };
  }
  return { kind: "ok", cwd: abs };
}

// Run `git diff` (HEAD vs working tree, plus untracked) at `cwd` and return a
// rich payload. Shells out to git but doesn't touch agent state, log cache,
// or broadcasts — callers format the result themselves. Both /isomux-diff
// and the HTTP endpoint share this so the on-screen rendering stays identical.
export function computeIsomuxDiff(cwd: string): ComputeDiffResult {
  const runGit = (args: string, maxBuffer = 10 * 1024 * 1024) =>
    execSync(`git -c core.quotePath=false ${args}`, { cwd, timeout: 10000, maxBuffer, stdio: ["ignore", "pipe", "pipe"] }).toString();
  const runGitOrNull = (args: string, maxBuffer?: number): string | null => {
    try { return runGit(args, maxBuffer); } catch { return null; }
  };

  try {
    runGit("rev-parse --is-inside-work-tree", 1024);
  } catch {
    return { kind: "not_repo", cwd };
  }

  const branchRaw = runGitOrNull("rev-parse --abbrev-ref HEAD", 1024)?.trim() ?? null;
  const branch = branchRaw && branchRaw !== "HEAD" ? branchRaw : null;
  const head = runGitOrNull("rev-parse --short HEAD", 1024)?.trim() || null;

  const gather = (refArgs: string) => ({
    diff: runGit(`diff ${refArgs}`.trim(), 50 * 1024 * 1024),
    numstat: runGit(`diff ${refArgs} --numstat`.trim()).trim(),
    nameStatus: runGit(`diff ${refArgs} --name-status`.trim()).trim(),
  });
  let diff = "";
  let numstat = "";
  let nameStatus = "";
  let untracked: string[] = [];
  try {
    if (head !== null) {
      ({ diff, numstat, nameStatus } = gather("HEAD"));
    } else {
      const cached = gather("--cached");
      const wd = gather("");
      diff = [cached.diff, wd.diff].filter((s) => s.trim()).join("\n");
      numstat = [cached.numstat, wd.numstat].filter(Boolean).join("\n");
      nameStatus = [cached.nameStatus, wd.nameStatus].filter(Boolean).join("\n");
    }
    const untrackedOut = runGit("ls-files --others --exclude-standard").trim();
    if (untrackedOut) untracked = untrackedOut.split("\n");
  } catch (err) {
    return { kind: "git_error", cwd, message: err instanceof Error ? err.message : String(err) };
  }

  const fileMap = new Map<string, DiffFileSummary>();

  if (nameStatus) {
    for (const line of nameStatus.split("\n")) {
      const cols = line.split("\t");
      const code = cols[0] ?? "";
      let status: DiffFileSummary["status"];
      let oldPath: string | undefined;
      let newPath: string;
      if (code.startsWith("R")) {
        status = "renamed";
        oldPath = cols[1] ?? "";
        newPath = cols[2] ?? "";
      } else if (code.startsWith("C")) {
        status = "copied";
        oldPath = cols[1] ?? "";
        newPath = cols[2] ?? "";
      } else if (code === "A") {
        status = "added";
        newPath = cols[1] ?? "";
      } else if (code === "D") {
        status = "deleted";
        newPath = cols[1] ?? "";
      } else {
        status = "modified";
        newPath = cols[1] ?? "";
      }
      if (!newPath) continue;
      fileMap.set(newPath, {
        path: newPath,
        oldPath,
        status,
        additions: 0,
        deletions: 0,
        lineCount: 0,
        inlineEligible: false,
      });
    }
  }

  // numstat formats renames as `old => new` or `prefix{old => new}suffix`;
  // pull the post-image path so we merge counts into the name-status row.
  const extractPostImagePath = (raw: string): string => {
    const brace = raw.match(/^(.*)\{([^{}]*?) => ([^{}]*?)\}(.*)$/);
    if (brace) return `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/{2,}/g, "/");
    const arrow = raw.indexOf(" => ");
    if (arrow !== -1) return raw.slice(arrow + 4);
    return raw;
  };
  if (numstat) {
    for (const line of numstat.split("\n")) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const addRaw = parts[0]!;
      const delRaw = parts[1]!;
      const path = extractPostImagePath(parts.slice(2).join("\t"));
      const isBinary = addRaw === "-" && delRaw === "-";
      const additions = isBinary ? 0 : parseInt(addRaw, 10) || 0;
      const deletions = isBinary ? 0 : parseInt(delRaw, 10) || 0;
      const existing = fileMap.get(path);
      if (existing) {
        existing.additions = additions;
        existing.deletions = deletions;
        existing.lineCount = additions + deletions;
        if (isBinary) existing.status = "binary";
      } else {
        fileMap.set(path, {
          path,
          status: isBinary ? "binary" : "modified",
          additions,
          deletions,
          lineCount: additions + deletions,
          inlineEligible: false,
        });
      }
    }
  }

  // Probe an untracked file: read first 8 KB to check for null bytes, stat for
  // size, then read the rest only if it fits in a synthesized patch.
  const UNTRACKED_MAX_BYTES = 1_000_000;
  const probeUntracked = (abs: string): { kind: "binary" | "tooLarge" | "ok" | "error"; content?: string } => {
    let fd: number | null = null;
    try {
      fd = openSync(abs, "r");
      const probe = Buffer.alloc(8192);
      const read = readSync(fd, probe, 0, 8192, 0);
      for (let i = 0; i < read; i++) if (probe[i] === 0) return { kind: "binary" };
      const st = statSync(abs);
      if (st.size > UNTRACKED_MAX_BYTES) return { kind: "tooLarge" };
      if (st.size <= read) return { kind: "ok", content: probe.subarray(0, st.size).toString("utf8") };
      const buf = Buffer.alloc(st.size);
      probe.copy(buf, 0, 0, read);
      let off = read;
      while (off < st.size) {
        const r = readSync(fd, buf, off, st.size - off, off);
        if (r === 0) break;
        off += r;
      }
      return { kind: "ok", content: buf.subarray(0, off).toString("utf8") };
    } catch {
      return { kind: "error" };
    } finally {
      if (fd !== null) try { closeSync(fd); } catch {}
    }
  };

  const untrackedPatches: string[] = [];
  for (const path of untracked) {
    const probe = probeUntracked(join(cwd, path));
    if (probe.kind === "error") continue;
    if (probe.kind === "binary") {
      fileMap.set(path, { path, status: "binary", additions: 0, deletions: 0, lineCount: 0, inlineEligible: false });
      continue;
    }
    if (probe.kind === "tooLarge") {
      // Re-use "untracked" to flag "we saw it but didn't synthesize" — the
      // overlay surfaces a friendly explanation.
      fileMap.set(path, { path, status: "untracked", additions: 0, deletions: 0, lineCount: 0, inlineEligible: false });
      continue;
    }
    const content = probe.content!;
    const lines = content === "" ? [] : content.split("\n");
    const trailingNewline = content.endsWith("\n");
    const realLines = trailingNewline ? lines.slice(0, -1) : lines;
    const additions = realLines.length;
    const header = [
      `diff --git a/${path} b/${path}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${path}`,
      `@@ -0,0 +1,${additions} @@`,
    ];
    const body = realLines.map((l) => `+${l}`);
    if (!trailingNewline && realLines.length > 0) body.push("\\ No newline at end of file");
    untrackedPatches.push([...header, ...body].join("\n"));
    fileMap.set(path, { path, status: "added", additions, deletions: 0, lineCount: additions, inlineEligible: false });
  }

  let patchText: string | null = diff;
  if (untrackedPatches.length > 0) {
    const trail = patchText && !patchText.endsWith("\n") ? "\n" : "";
    patchText = (patchText ?? "") + trail + untrackedPatches.join("\n") + "\n";
  }
  if (patchText !== null && patchText.trim() === "") patchText = null;

  for (const summary of fileMap.values()) {
    const hasTextualPatch = patchText !== null && summary.status !== "binary" && summary.status !== "untracked";
    summary.inlineEligible = hasTextualPatch && summary.lineCount <= 500;
  }

  // 2 MB safety rail: drop patchText, keep summaries.
  const MAX_PATCH_BYTES = 2 * 1024 * 1024;
  let truncated = false;
  if (patchText !== null && Buffer.byteLength(patchText, "utf8") > MAX_PATCH_BYTES) {
    patchText = null;
    truncated = true;
    for (const summary of fileMap.values()) summary.inlineEligible = false;
  }

  const files = Array.from(fileMap.values()).sort((a, b) => a.path.localeCompare(b.path));
  const stats = files.reduce(
    (acc, f) => ({
      additions: acc.additions + f.additions,
      deletions: acc.deletions + f.deletions,
      filesChanged: acc.filesChanged + 1,
    }),
    { additions: 0, deletions: 0, filesChanged: 0 },
  );

  if (files.length === 0) return { kind: "clean", cwd };

  const summary = `+${stats.additions} -${stats.deletions} across ${stats.filesChanged} file${stats.filesChanged === 1 ? "" : "s"}`;
  const payload: DiffPayload = { cwd, branch, head, stats, files, patchText, truncated };
  return { kind: "ok", cwd, summary, payload };
}
