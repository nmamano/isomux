// The gate's headroom check for the agent reference pages. CI warns when a
// page is over AGENT_REFERENCE_WARN_AT of the cap, and nobody reads the
// warning; this fails the gate of the diff that makes such a page grow, so
// the worker who adds the bytes cuts or splits the page (task f3858003).
//
//   bun scripts/reference-headroom.ts <base>
//
// compares each server/agent-reference/*.md page the diff from <base> to
// HEAD changes, as an agent receives it. It prints one line per page that is
// over the share and grew, and exits 1 on any; otherwise it prints one line
// that says the check ran, and exits 0. It imports only the size module:
// server/agent-reference.ts reads every page file when it loads.
import { spawnSync } from "node:child_process";
import {
  AGENT_REFERENCE_PAGE_CAP,
  AGENT_REFERENCE_WARN_AT,
  compactReferenceTables,
} from "../server/agent-reference-size.ts";

/** One changed page: its text at the base and at HEAD (undefined: absent). */
export type ReferencePageChange = {
  path: string;
  before: string | undefined;
  after: string | undefined;
};

/** A page over the share of the cap that grew: its served bytes. */
export type ReferenceHeadroomViolation = {
  path: string;
  before: number;
  after: number;
};

/**
 * The pages whose served size at HEAD is over AGENT_REFERENCE_WARN_AT of
 * AGENT_REFERENCE_PAGE_CAP and larger than at the base. A new page counts
 * from 0 bytes; a deleted page never fails.
 */
export function referenceHeadroom(
  pages: ReferencePageChange[],
): ReferenceHeadroomViolation[] {
  const limit = AGENT_REFERENCE_PAGE_CAP * AGENT_REFERENCE_WARN_AT;
  const served = (text: string | undefined) =>
    text === undefined ? 0 : Buffer.byteLength(compactReferenceTables(text));
  const violations: ReferenceHeadroomViolation[] = [];
  for (const { path, before, after } of pages) {
    if (after === undefined) continue;
    const sizes = { path, before: served(before), after: served(after) };
    if (sizes.after > limit && sizes.after > sizes.before)
      violations.push(sizes);
  }
  return violations;
}

const PAGE_DIR = "server/agent-reference/";

function git(...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: r.stdout ?? "" };
}

/** A page's text at a commit, or undefined when the commit does not hold it. */
function pageAt(rev: string, path: string): string | undefined {
  const r = git("show", `${rev}:${path}`);
  return r.ok ? r.out : undefined;
}

function main(args: string[]): number {
  if (args.length !== 1) {
    console.log("usage: bun scripts/reference-headroom.ts <base>");
    return 2;
  }
  const base = git("rev-parse", "--verify", "--quiet", `${args[0]}^{commit}`);
  if (!base.ok) {
    console.log(`✗ reference-headroom: ${args[0]} is not a commit`);
    return 2;
  }
  const diff = git(
    "diff",
    "--name-only",
    "--no-renames",
    base.out.trim(),
    "HEAD",
    "--",
    PAGE_DIR,
  );
  if (!diff.ok) {
    console.log(`✗ reference-headroom: git diff from ${args[0]} failed`);
    return 2;
  }
  const paths = diff.out
    .split("\n")
    .filter(
      (path) =>
        path.startsWith(PAGE_DIR) &&
        path.endsWith(".md") &&
        !path.slice(PAGE_DIR.length).includes("/"),
    );
  if (paths.length === 0) {
    console.log("→ agent reference pages: none changed");
    return 0;
  }
  const violations = referenceHeadroom(
    paths.map((path) => ({
      path,
      before: pageAt(base.out.trim(), path),
      after: pageAt("HEAD", path),
    })),
  );
  const share = AGENT_REFERENCE_WARN_AT * 100;
  if (violations.length === 0) {
    console.log(
      `→ agent reference pages: ${paths.length} changed, none over ${share}% of the ${AGENT_REFERENCE_PAGE_CAP} B cap grew`,
    );
    return 0;
  }
  for (const { path, before, after } of violations) {
    const topic = path.slice(PAGE_DIR.length, -".md".length);
    const pct = ((after / AGENT_REFERENCE_PAGE_CAP) * 100).toFixed(1);
    console.log(
      `✗ agent reference page ${topic}: ${before} -> ${after} of ${AGENT_REFERENCE_PAGE_CAP} B (${pct}%), over ${share}% of the cap, and it grew. Cut it, then split it into a sub-page.`,
    );
  }
  return 1;
}

if (import.meta.main) {
  let code: number;
  try {
    code = main(process.argv.slice(2));
  } catch (error) {
    console.log(`✗ reference-headroom failed: ${String(error)}`);
    code = 2;
  }
  process.exit(code);
}
