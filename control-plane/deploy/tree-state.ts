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

/**
 * The whole source question, as one decision over two git readings.
 *
 * `fly deploy .` ships the WORKING DIRECTORY, so a dirty tree produces a live
 * artifact nobody can reconstruct from a commit. Two programs need that answer
 * now - the credential move and D4's activation - and the second one asking it
 * differently from the first is how two guards drift into disagreeing about
 * what "clean" means. So the decision lives here and both call it.
 *
 * THE RULES FILE IS A BUILD INPUT LIKE ANY OTHER, and it is judged first in
 * meaning: `/.dockerignore` sits outside the copied path, so the shipped-path
 * count can never see it, while its working-tree bytes decide what that count
 * is allowed to ignore. A modified one can put the web app, the tests or
 * node_modules into the image and still answer "reconstructible" about the
 * result (reviewer finding, 2026-08-11). A rename is judged by both halves for
 * the same reason it is elsewhere in this file.
 */
export interface SourceVerdict {
  /** Both git commands answered. False makes every other field meaningless. */
  readable: boolean;
  /** HEAD carries the rules file and the tree has not touched it. */
  rulesCommitted: boolean;
  /** How many paths that SHIP TO THE IMAGE are uncommitted. */
  shippedUncommitted: number;
  /** The one thing a caller should branch on. */
  reconstructible: boolean;
}

export function judgeSource(args: {
  readable: boolean;
  statusOut: string;
  treeOut: string;
  rulesPath: string;
  /** `shipsToImage` bound to the rules, so this stays free of the file system. */
  ships: (file: string) => boolean;
}): SourceVerdict {
  if (!args.readable) {
    return {
      readable: false,
      rulesCommitted: false,
      shippedUncommitted: -1,
      reconstructible: false,
    };
  }
  const entries = parsePorcelain(args.statusOut);
  const headPaths = headPathsFrom(args.treeOut);
  const rulesTouched = entries.some(
    (e) => e.path === args.rulesPath || e.from === args.rulesPath,
  );
  const rulesCommitted = headPaths.has(args.rulesPath) && !rulesTouched;
  const verdict = classifyAgainstHead(entries, headPaths);
  const shipped = [
    ...verdict.runtimeDirty,
    ...verdict.docOnly,
    ...verdict.notInHead,
  ].filter((file) => args.ships(file));
  return {
    readable: true,
    rulesCommitted,
    shippedUncommitted: shipped.length,
    reconstructible: rulesCommitted && shipped.length === 0,
  };
}
