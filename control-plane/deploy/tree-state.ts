// Which of this tree's changes would MISS the artifact, and how that question
// is asked without getting the answer wrong during a review.
//
// The deploy artifact is `git archive HEAD`, so anything uncommitted is not in
// it, and a phase that ships while a runtime file has uncommitted changes would
// deploy something nobody is looking at. The guard for that is a real one and
// stays.
//
// What was wrong was the TEST, not the property. The guard read
// `git status --porcelain` and treated any line not starting with `??` as a
// modified tracked file - but the review convention freezes a tree with
// `git add --intent-to-add .`, which turns every untracked file into an ` A`
// index entry. Measured 2026-08-11: 27 paths counted as dirty runtime paths,
// every one of them intent-to-add deploy tooling, and zero genuinely modified
// tracked files. The operator's workaround was to `git reset`, run the phase,
// and re-add - a dance around a classifier that was asking the wrong question.
//
// THE RIGHT QUESTION IS WHETHER HEAD CARRIES THE PATH. `git archive HEAD` can
// only ship what HEAD contains, so a path HEAD does not carry cannot make the
// artifact stale however the index happens to be staged. That is a fact about
// the commit rather than about a two-character status prefix, and it holds for
// every staging state: ` A`, `??`, `AM`, or anything a future git decides to
// print.

/** A porcelain v1 line, split into its prefix and the path it names. */
export interface PorcelainEntry {
  prefix: string;
  path: string;
  /** A rename's ORIGIN, when the line named one. It matters as much as the
   * destination: HEAD still carries the old path, so `git archive HEAD` still
   * ships it. */
  from?: string;
}

/**
 * Parse `git status --porcelain` output.
 *
 * A rename prints `R  old -> new`, and BOTH halves are kept. Keeping only the
 * destination looked right and was not: the destination is a path HEAD does not
 * carry, so it classified as untracked and the deploy was allowed - while
 * `git archive HEAD` went on shipping the ORIGIN, which is the stale file the
 * guard exists to catch. Reviewer finding, 2026-08-11.
 *
 * Quoted paths (git quotes anything with unusual bytes) are left exactly as
 * printed - this classifier decides on membership in a set built from the same
 * command family, so an escaped path either matches or is treated as untracked,
 * and treating an unreadable path as untracked is the direction that ships less.
 */
export function parsePorcelain(output: string): PorcelainEntry[] {
  const out: PorcelainEntry[] = [];
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) continue;
    if (line.length < 4) continue;
    const prefix = line.slice(0, 2);
    const rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    if (arrow >= 0) {
      out.push({
        prefix,
        path: rest.slice(arrow + 4),
        from: rest.slice(0, arrow),
      });
    } else {
      out.push({ prefix, path: rest });
    }
  }
  return out;
}

export interface TreeVerdict {
  /** Tracked, changed, and not documentation: the artifact would be stale. */
  runtimeDirty: string[];
  /** Tracked and changed, but documentation only. */
  docOnly: string[];
  /** Not carried by HEAD at all, so it cannot be in the archive. */
  notInHead: string[];
}

/**
 * Classify a working tree against the commit that will be archived.
 *
 * `headPaths` is what HEAD carries under the same pathspecs the status was
 * taken with. Membership decides: a path HEAD carries and the tree has changed
 * is a real finding, and a path HEAD does not carry is not one, whatever its
 * status prefix says.
 */
export function classifyAgainstHead(
  entries: readonly PorcelainEntry[],
  headPaths: ReadonlySet<string>,
): TreeVerdict {
  const verdict: TreeVerdict = { runtimeDirty: [], docOnly: [], notInHead: [] };
  for (const { path, from } of entries) {
    // A RENAME IS JUDGED BY ITS ORIGIN when HEAD carries it: the archive ships
    // whatever HEAD holds, so moving a tracked runtime file away is exactly the
    // staleness this guard is for, however untracked the destination looks.
    const tracked = [from, path].filter(
      (p): p is string => p !== undefined && headPaths.has(p),
    );
    if (tracked.length === 0) {
      verdict.notInHead.push(path);
      continue;
    }
    for (const p of tracked) {
      if (p.endsWith(".md")) verdict.docOnly.push(p);
      else verdict.runtimeDirty.push(p);
    }
  }
  return verdict;
}

/** The paths a `git ls-tree -r --name-only HEAD -- ...` run named. */
export function headPathsFrom(output: string): Set<string> {
  return new Set(
    output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}
