// What the deployment artifact is, and how it differs from the repository.
//
// THREE transformations, and no others. Each one is here because a measurement
// forced it, and each one is proved by comparing manifests rather than by
// trusting the code that made it:
//
//   1. `vercel.json` is REMOVED. The landing project owns this repository's
//      root config, and a CLI upload's root governs the build - measured
//      2026-08-11, when Vercel ran the landing page's demo-and-docs build for
//      the control plane and never mentioned `control-plane/web` at all.
//   2. `package.json` is REPLACED by
//      `control-plane/deploy/vercel-root/package.json`.
//      Vercel installs in the Root Directory, so dependencies land in
//      `control-plane/web/node_modules` - and `pg` is imported by
//      `control-plane/store.ts`, which sits ABOVE that directory. A bare
//      specifier resolves by walking UP from the importing file, so the
//      artifact needs an ancestor install. Measured 2026-08-11: `pg` was the
//      one unresolved module.
//   3. `bun.lock` is REPLACED by `control-plane/deploy/vercel-root/bun.lock`,
//      because a lockfile describing the office manifest cannot be
//      frozen-installed against a two-declaration manifest.
//
// THE ANCESTOR PAIR IS ITS OWN CONTRACT, and deliberately not D2's. The
// provisioner's `deploy/package.json` is a RUNTIME manifest - exactly `pg`,
// installed into an image that holds provider credentials - and a build-only
// declaration does not belong in it. This artifact needs one more thing that
// the provisioner never does: `@types/pg`, because `next build` type-checks
// `control-plane/store.ts` and TypeScript resolves types upward from the
// IMPORTING file, where `control-plane/web`'s own types cannot be seen
// (measured 2026-08-11, TS7016). So the two pairs are separate contracts, and
// the drift tests pin both: this one carries the types, the provisioner's
// stays runtime-only, and every spec in either must match the repository and
// the web package exactly.
//
// THE REPOSITORY IS NEVER TOUCHED. Every original is digested before the
// artifact is built and compared afterwards; the digests are held in memory and
// never printed.

import * as fs from "node:fs";
import * as path from "node:path";

/** Removed from the artifact. Repository-relative. */
export const EXCLUDED_FROM_ARTIFACT = "vercel.json";

/** Replaced in the artifact, each by a committed file this repository already
 * reviews. Repository-relative on both sides. */
export const REPLACED_IN_ARTIFACT = [
  {
    artifact: "package.json",
    source: "control-plane/deploy/vercel-root/package.json",
  },
  { artifact: "bun.lock", source: "control-plane/deploy/vercel-root/bun.lock" },
] as const;

/** Every repository file this process reads and must leave alone. */
export const REPOSITORY_ORIGINALS = [
  EXCLUDED_FROM_ARTIFACT,
  ...REPLACED_IN_ARTIFACT.map((r) => r.artifact),
  ...REPLACED_IN_ARTIFACT.map((r) => r.source),
] as const;

/**
 * The install the deployment runs, as FIXED SOURCE.
 *
 * Two frozen installs, root first: the root one puts `pg` where an import from
 * `control-plane/` can walk up to it, and the second one installs the web
 * package's own dependencies where Next expects them. Neither may drift to an
 * unfrozen install, and neither installs the office manifest - the artifact's
 * root manifest is the one-dependency pair above.
 *
 * The `test -f` is a FAIL-CLOSED anchor rather than decoration. The command
 * starts in the project's Root Directory, so `cd ../..` is the artifact root
 * only if that assumption holds; if it ever does not, the test fails and the
 * build stops instead of quietly installing something else somewhere else.
 */
export const INSTALL_COMMAND =
  "cd ../.. && test -f control-plane/web/package.json && " +
  "bun install --frozen-lockfile && cd control-plane/web && " +
  "bun install --frozen-lockfile";

export interface TransformVerdict {
  removed: string[];
  replaced: string[];
  added: string[];
  /** Every replacement is byte-for-byte its committed source. */
  copiesMatchSource: boolean;
  filesBefore: number;
  filesAfter: number;
}

export function listFiles(dir: string): string[] {
  const found: string[] = [];
  const stack = [""];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    for (const entry of fs.readdirSync(path.join(dir, rel), {
      withFileTypes: true,
    })) {
      const child = rel.length > 0 ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        stack.push(child);
        continue;
      }
      found.push(child);
    }
  }
  return found.sort();
}

export function digestOf(file: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(fs.readFileSync(file));
  return hasher.digest("hex");
}

/** Is there an entry with this name anywhere, file or DIRECTORY? An empty
 * `.vercel` has no files in it, which a manifest-only check would miss. */
export function hasEntryNamed(dir: string, name: string): boolean {
  const stack = [dir];
  while (stack.length > 0) {
    const here = stack.pop()!;
    for (const entry of fs.readdirSync(here, { withFileTypes: true })) {
      if (entry.name === name) return true;
      if (entry.isDirectory()) stack.push(path.join(here, entry.name));
    }
  }
  return false;
}

/**
 * May this exact path be written to or unlinked?
 *
 * A regular file, not a symlink - following a link out of the artifact would
 * reach a real file somewhere else - and provably inside the artifact root.
 */
export function safeToTouch(target: string, artifactRoot: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  const root = fs.realpathSync(artifactRoot);
  return path.resolve(target).startsWith(`${root}${path.sep}`);
}

/**
 * Apply the three transformations, and report what actually changed.
 *
 * REPLACEMENTS ARE REPORTED SEPARATELY from additions and removals, because a
 * replacement that silently became an add-plus-remove would mean the artifact
 * gained a path nobody ruled. The manifest is taken before and after, so the
 * report is a comparison rather than a description of intent.
 */
export function transformArtifact(
  artifactRoot: string,
  workspace: string,
): TransformVerdict {
  const before = listFiles(artifactRoot);

  const excluded = path.join(artifactRoot, EXCLUDED_FROM_ARTIFACT);
  if (!safeToTouch(excluded, artifactRoot)) {
    throw new Error("the file to exclude is not a plain file inside the copy");
  }
  fs.unlinkSync(excluded);

  let copiesMatchSource = true;
  for (const { artifact, source } of REPLACED_IN_ARTIFACT) {
    const target = path.join(artifactRoot, artifact);
    if (!safeToTouch(target, artifactRoot)) {
      throw new Error("a file to replace is not a plain file inside the copy");
    }
    fs.copyFileSync(path.join(workspace, source), target);
    if (digestOf(target) !== digestOf(path.join(workspace, source))) {
      copiesMatchSource = false;
    }
  }

  const after = listFiles(artifactRoot);
  const had = new Set(before);
  const has = new Set(after);
  const replacedNames = new Set<string>(
    REPLACED_IN_ARTIFACT.map((r) => r.artifact),
  );
  return {
    removed: before.filter((f) => !has.has(f)),
    replaced: [...replacedNames].filter((f) => had.has(f) && has.has(f)).sort(),
    added: after.filter((f) => !had.has(f)),
    copiesMatchSource,
    filesBefore: before.length,
    filesAfter: after.length,
  };
}

/** Exactly the ruled transformations, and nothing else. */
export function transformIsExact(verdict: TransformVerdict): boolean {
  return (
    verdict.removed.length === 1 &&
    verdict.removed[0] === EXCLUDED_FROM_ARTIFACT &&
    verdict.added.length === 0 &&
    verdict.replaced.length === REPLACED_IN_ARTIFACT.length &&
    verdict.copiesMatchSource &&
    verdict.filesAfter === verdict.filesBefore - 1
  );
}

/** Digests of every repository file this process reads, held for comparison. */
export function repositoryDigests(workspace: string): Map<string, string> {
  const digests = new Map<string, string>();
  for (const rel of REPOSITORY_ORIGINALS) {
    digests.set(rel, digestOf(path.join(workspace, rel)));
  }
  return digests;
}

export function repositoryUnchanged(
  workspace: string,
  digests: Map<string, string>,
): boolean {
  for (const [rel, digest] of digests) {
    try {
      if (digestOf(path.join(workspace, rel)) !== digest) return false;
    } catch {
      return false;
    }
  }
  return true;
}
