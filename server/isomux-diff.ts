import type { DiffFileSummary, DiffPayload } from "../shared/types.ts";
import { execSync } from "child_process";
import { closeSync, openSync, readSync, statSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { homedir } from "os";

export type ComputeDiffResult =
  | { kind: "ok"; cwd: string; summary: string; payload: DiffPayload }
  | { kind: "clean"; cwd: string }
  | { kind: "not_repo"; cwd: string }
  | { kind: "git_error"; cwd: string; message: string }
  | { kind: "bad_commit"; cwd: string; attempted: string; message: string };

export type ResolveDirResult =
  | { kind: "ok"; cwd: string }
  | { kind: "bad_dir"; attempted: string };

// Parsed shape of an optional `commit` argument. `single` means show the
// changes introduced by one commit (rendered as <sha>^..<sha>, with --root
// fallback for the initial commit). `range` is passed straight to `git diff`
// — `..` (two-dot, cumulative A..B) and `...` (three-dot, merge-base..B) are
// both accepted because git itself supports them and they have distinct
// semantics for reviewers.
type CommitSpec =
  | { kind: "single"; ref: string }
  | { kind: "range"; raw: string };

// Resolve an optional user-supplied directory against the agent's cwd.
// `~` expands to the user's home; relative paths resolve against `agentCwd`;
// absolute paths win. Validates that the result exists and is a directory.
export function resolveDiffCwd(
  rawDir: string | undefined,
  agentCwd: string,
): ResolveDirResult {
  const trimmed = rawDir?.trim();
  if (!trimmed) return { kind: "ok", cwd: agentCwd };
  const expanded = trimmed.startsWith("~")
    ? join(homedir(), trimmed.slice(1).replace(/^[/\\]/, ""))
    : trimmed;
  const abs = isAbsolute(expanded) ? expanded : resolve(agentCwd, expanded);
  try {
    if (!statSync(abs).isDirectory())
      return { kind: "bad_dir", attempted: abs };
  } catch {
    return { kind: "bad_dir", attempted: abs };
  }
  return { kind: "ok", cwd: abs };
}

// Allowlist for ref characters: alnum + the punctuation that legitimately
// appears in branch names, tags, and commit SHAs. Forbids whitespace,
// shell metas (`;`, backticks, `$`, `|`, `&`, quotes, redirects), parens,
// braces — anything that would let an injected ref turn into an extra
// shell argument once it hits `git diff ${refArgs}` below. The two-dot /
// three-dot range operators are matched separately.
const REF_CHARS = /^[A-Za-z0-9._\-/~^@:]+$/;

// Parse a user-supplied commit/range string into an opaque CommitSpec.
// Pure syntactic — does NOT confirm the ref exists; that's done with
// `git rev-parse --verify` inside computeIsomuxDiff once we have a cwd.
export function parseCommitArg(
  raw: string,
): { ok: true; spec: CommitSpec } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "empty commit string" };
  // Find the first run of 2-or-3 dots; reject if there are multiple runs
  // (`a..b..c` is ambiguous) or a run of 4+ dots (`a....b` is invalid).
  let runStart = -1;
  let runLen = 0;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== ".") continue;
    let j = i;
    while (j < trimmed.length && trimmed[j] === ".") j++;
    const len = j - i;
    if (len >= 2) {
      if (len > 3) return { ok: false, reason: "too many dots in range" };
      if (runStart !== -1)
        return { ok: false, reason: "multiple range operators" };
      runStart = i;
      runLen = len;
    }
    i = j - 1;
  }
  if (runStart === -1) {
    if (!REF_CHARS.test(trimmed))
      return { ok: false, reason: "invalid characters in ref" };
    return { ok: true, spec: { kind: "single", ref: trimmed } };
  }
  const left = trimmed.slice(0, runStart);
  const right = trimmed.slice(runStart + runLen);
  if (!left || !right)
    return { ok: false, reason: "range operator requires both sides" };
  if (!REF_CHARS.test(left) || !REF_CHARS.test(right))
    return { ok: false, reason: "invalid characters in range" };
  return { ok: true, spec: { kind: "range", raw: trimmed } };
}

// Run `git diff` and return a rich payload. With no `commit` option,
// diffs working tree vs HEAD plus untracked synthesis. With `commit`, diffs
// a specific revision or range — untracked synthesis is skipped because it
// only makes sense for the working tree. Shells out to git but doesn't
// touch agent state, log cache, or broadcasts — callers format the result
// themselves. Both /isomux-diff and the HTTP endpoint share this so the
// on-screen rendering stays identical.
export function computeIsomuxDiff(
  cwd: string,
  opts?: { commit?: string },
): ComputeDiffResult {
  const runGit = (args: string, maxBuffer = 10 * 1024 * 1024) =>
    execSync(`git -c core.quotePath=false ${args}`, {
      cwd,
      timeout: 10000,
      maxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  const runGitOrNull = (args: string, maxBuffer?: number): string | null => {
    try {
      return runGit(args, maxBuffer);
    } catch {
      return null;
    }
  };

  try {
    runGit("rev-parse --is-inside-work-tree", 1024);
  } catch {
    return { kind: "not_repo", cwd };
  }

  // Resolve the commit argument up front so we can choose the right diff
  // strategy (working tree vs history) and reject bad refs before doing any
  // expensive work.
  let commitSpec: CommitSpec | null = null;
  let subject: string | null = null;
  let refArgs: string | null = null;
  if (opts?.commit && opts.commit.trim()) {
    const parsed = parseCommitArg(opts.commit);
    if (!parsed.ok) {
      return {
        kind: "bad_commit",
        cwd,
        attempted: opts.commit,
        message: parsed.reason,
      };
    }
    commitSpec = parsed.spec;
    // Each ref in the spec must resolve to a real commit. rev-parse exits
    // non-zero for unknown refs and for ambiguous ones with --verify; we
    // catch both via runGitOrNull. The `^{commit}` peels through tags.
    const verifyRef = (ref: string): boolean =>
      runGitOrNull(`rev-parse --verify --quiet ${ref}^{commit}`, 1024) !== null;
    if (commitSpec.kind === "single") {
      if (!verifyRef(commitSpec.ref)) {
        return {
          kind: "bad_commit",
          cwd,
          attempted: opts.commit,
          message: `unknown ref: ${commitSpec.ref}`,
        };
      }
      // Initial-commit fallback: `<sha>^` doesn't exist for the first commit,
      // so we use `--root` to diff against the empty tree.
      const hasParent = verifyRef(`${commitSpec.ref}^`);
      refArgs = hasParent
        ? `${commitSpec.ref}^ ${commitSpec.ref}`
        : `--root ${commitSpec.ref}`;
      subject =
        runGitOrNull(
          `show -s --format=%s ${commitSpec.ref}`,
          16 * 1024,
        )?.trim() || null;
    } else {
      // Range form: validate both sides individually, then pass the literal
      // string to git so `..` vs `...` semantics are preserved exactly.
      const dotsIdx = commitSpec.raw.indexOf("..");
      const dotsLen = commitSpec.raw.startsWith("...", dotsIdx) ? 3 : 2;
      const left = commitSpec.raw.slice(0, dotsIdx);
      const right = commitSpec.raw.slice(dotsIdx + dotsLen);
      if (!verifyRef(left)) {
        return {
          kind: "bad_commit",
          cwd,
          attempted: opts.commit,
          message: `unknown ref: ${left}`,
        };
      }
      if (!verifyRef(right)) {
        return {
          kind: "bad_commit",
          cwd,
          attempted: opts.commit,
          message: `unknown ref: ${right}`,
        };
      }
      refArgs = commitSpec.raw;
      subject = commitSpec.raw;
    }
  }

  const branchRaw =
    runGitOrNull("rev-parse --abbrev-ref HEAD", 1024)?.trim() ?? null;
  const branch =
    commitSpec === null && branchRaw && branchRaw !== "HEAD" ? branchRaw : null;
  // For a single commit, the displayed `head` is that commit's short SHA so
  // the UI heading reads `<subject> · <sha>`. For ranges, leave it null and
  // rely on `subject` for context.
  let head: string | null = null;
  if (commitSpec === null) {
    head = runGitOrNull("rev-parse --short HEAD", 1024)?.trim() || null;
  } else if (commitSpec.kind === "single") {
    head =
      runGitOrNull(`rev-parse --short ${commitSpec.ref}`, 1024)?.trim() || null;
  }

  const gather = (refs: string) => ({
    diff: runGit(`diff ${refs}`.trim(), 50 * 1024 * 1024),
    numstat: runGit(`diff ${refs} --numstat`.trim()).trim(),
    nameStatus: runGit(`diff ${refs} --name-status`.trim()).trim(),
  });
  let diff = "";
  let numstat = "";
  let nameStatus = "";
  let untracked: string[] = [];
  try {
    if (refArgs !== null) {
      ({ diff, numstat, nameStatus } = gather(refArgs));
    } else if (head !== null) {
      ({ diff, numstat, nameStatus } = gather("HEAD"));
    } else {
      const cached = gather("--cached");
      const wd = gather("");
      diff = [cached.diff, wd.diff].filter((s) => s.trim()).join("\n");
      numstat = [cached.numstat, wd.numstat].filter(Boolean).join("\n");
      nameStatus = [cached.nameStatus, wd.nameStatus]
        .filter(Boolean)
        .join("\n");
    }
    // Untracked-file synthesis only makes sense for the working tree.
    if (commitSpec === null) {
      const untrackedOut = runGit(
        "ls-files --others --exclude-standard",
      ).trim();
      if (untrackedOut) untracked = untrackedOut.split("\n");
    }
  } catch (err) {
    return {
      kind: "git_error",
      cwd,
      message: err instanceof Error ? err.message : String(err),
    };
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
    if (brace)
      return `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/{2,}/g, "/");
    const arrow = raw.indexOf(" => ");
    if (arrow !== -1) return raw.slice(arrow + 4);
    return raw;
  };
  if (numstat) {
    for (const line of numstat.split("\n")) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const addRaw = parts[0];
      const delRaw = parts[1];
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
  const probeUntracked = (
    abs: string,
  ): { kind: "binary" | "tooLarge" | "ok" | "error"; content?: string } => {
    let fd: number | null = null;
    try {
      fd = openSync(abs, "r");
      const probe = Buffer.alloc(8192);
      const read = readSync(fd, probe, 0, 8192, 0);
      for (let i = 0; i < read; i++)
        if (probe[i] === 0) return { kind: "binary" };
      const st = statSync(abs);
      if (st.size > UNTRACKED_MAX_BYTES) return { kind: "tooLarge" };
      if (st.size <= read)
        return {
          kind: "ok",
          content: probe.subarray(0, st.size).toString("utf8"),
        };
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
      if (fd !== null)
        try {
          closeSync(fd);
        } catch {}
    }
  };

  const untrackedPatches: string[] = [];
  for (const path of untracked) {
    const probe = probeUntracked(join(cwd, path));
    if (probe.kind === "error") continue;
    if (probe.kind === "binary") {
      fileMap.set(path, {
        path,
        status: "binary",
        additions: 0,
        deletions: 0,
        lineCount: 0,
        inlineEligible: false,
      });
      continue;
    }
    if (probe.kind === "tooLarge") {
      // Re-use "untracked" to flag "we saw it but didn't synthesize" — the
      // overlay surfaces a friendly explanation.
      fileMap.set(path, {
        path,
        status: "untracked",
        additions: 0,
        deletions: 0,
        lineCount: 0,
        inlineEligible: false,
      });
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
    if (!trailingNewline && realLines.length > 0)
      body.push("\\ No newline at end of file");
    untrackedPatches.push([...header, ...body].join("\n"));
    fileMap.set(path, {
      path,
      status: "added",
      additions,
      deletions: 0,
      lineCount: additions,
      inlineEligible: false,
    });
  }

  let patchText: string | null = diff;
  if (untrackedPatches.length > 0) {
    const trail = patchText && !patchText.endsWith("\n") ? "\n" : "";
    patchText = (patchText ?? "") + trail + untrackedPatches.join("\n") + "\n";
  }
  if (patchText !== null && patchText.trim() === "") patchText = null;

  for (const summary of fileMap.values()) {
    const hasTextualPatch =
      patchText !== null &&
      summary.status !== "binary" &&
      summary.status !== "untracked";
    summary.inlineEligible = hasTextualPatch && summary.lineCount <= 500;
  }

  // 2 MB safety rail: drop patchText, keep summaries.
  const MAX_PATCH_BYTES = 2 * 1024 * 1024;
  let truncated = false;
  if (
    patchText !== null &&
    Buffer.byteLength(patchText, "utf8") > MAX_PATCH_BYTES
  ) {
    patchText = null;
    truncated = true;
    for (const summary of fileMap.values()) summary.inlineEligible = false;
  }

  const files = Array.from(fileMap.values()).sort((a, b) =>
    a.path.localeCompare(b.path),
  );
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
  const payload: DiffPayload = {
    cwd,
    branch,
    head,
    subject,
    stats,
    files,
    patchText,
    truncated,
  };
  return { kind: "ok", cwd, summary, payload };
}
