// Pruning of the office's unbounded on-disk history (task 2366ccb0).
//
// NOTHING IN HERE RUNS ON A TIMER. There is no scheduler, no startup hook, no
// default policy that deletes anything. A plan is computed on request and only
// ever applied when a caller explicitly asks for it. That is deliberate: an
// office's transcripts are the user's memory of their own work, and the cost of
// deleting too much is unrecoverable while the cost of deleting too little is a
// larger disk.
//
// Two phases, always:
//   planPrune(...)   read-only; returns exactly what WOULD be deleted and why
//                    everything else was spared.
//   applyPrune(plan) deletes the planned files, re-deriving every safety
//                    property from the live filesystem first.
//
// The route never round-trips a plan through the client: POST /api/storage/prune
// takes a POLICY, plans server-side, and applies that same fresh plan. applyPrune
// still re-plans and intersects, so the module is safe standalone — a stale or
// hand-edited plan can only ever delete LESS than a fresh one would, never more,
// and a plan naming a path outside the fence aborts the run entirely.
//
// What is protected, and why (the non-obvious part):
//   - the ACTIVE session of any agent — it is being appended to right now;
//   - the K newest sessions of every agent, regardless of age;
//   - any session that another session was FORKED FROM. persistence.ts's
//     loadLogWithAncestors assembles a fork's transcript by walking the
//     forkedFrom chain and reading each ancestor's .jsonl, so an ancestor file
//     stays load-bearing forever. Deleting one silently truncates the
//     descendant's history instead of erroring — the worst failure shape there
//     is. We protect every session named as a forkedFrom by ANY entry in the
//     map. That is a strict SUPERSET of "the transitive ancestor closure of
//     every retained session" (each link in a chain is itself somebody's
//     parent), it needs no fixpoint, and it cannot loop on a cyclic map.
//   - an attachment still REFERENCED by a surviving transcript. Attachments sit
//     in one shared per-agent files/ dir, not under a session, so age alone
//     would happily delete a file that a conversation you can still open
//     renders. An attachment becomes prunable only once nothing points at it —
//     which is what pruning transcripts first produces.
//   - sessions.json is NEVER touched. server/usage-report.ts reads token and
//     cost history from it and never opens the .jsonl, so pruning transcripts
//     leaves /isomux-usage fully intact.
//
// Symlink handling, and the trust statement that goes with it. Listings filter
// on Dirent isFile/isDirectory (lstat-based, so a symlink is neither), the
// attachment pass lstat-checks files/ before reading it, agent dirs must match
// the `agent-` layout, and before each unlink apply re-checks that the parent
// resolves under the real logs root AND that no parent component is a symlink.
// Candidate paths are RELATIVE to the logs dir, so the fence is structural
// rather than a string comparison on an absolute path.
//
// What that does NOT do: eliminate the race. A same-user process could swap a
// parent directory for a symlink between the final lstat and the unlink.
// Closing it needs unlinkat() against an opened directory fd, which Bun does
// not expose. So the honest statement is: this code makes every DETERMINISTIC
// symlink escape impossible and narrows the racing one to a sub-millisecond
// window, on an operation only the office owner can trigger. It does not treat
// same-user processes as untrusted, and it should not be described as if it
// did. (Flagged for Nil rather than settled here — if same-user isolation ever
// becomes a goal, this is one of the places that needs a real answer.)
//
// Seam discipline: every input is injected (logs dir, clock, active-session
// set, the sessions-map reader), so the whole safety matrix unit-tests against
// a temp fixture tree with zero reference to the real ~/.isomux.

import { join, resolve, sep, dirname } from "path";
import {
  readdirSync,
  readFileSync,
  lstatSync,
  realpathSync,
  unlinkSync,
} from "fs";
import type {
  PruneTarget,
  PrunePolicy,
  PruneCandidateWire,
  PruneSkipReason,
  PruneSkipWire,
  PrunePlanWire,
  PruneResultWire,
} from "../shared/contract-shapes.ts";

// The wire contract IS the domain type — a plan travels out to the caller and
// back in on apply, so a projection layer would just be a place to drift.
//
// Field semantics worth restating here, next to the code that enforces them:
//   PrunePolicy.olderThanDays  files younger than this are never candidates;
//                              the route rejects 0 (no "delete everything").
//   PrunePolicy.keepPerAgent   transcripts only; ignored for attachments.
//   PruneCandidate.mtimeMs     captured at plan time. applyPrune refuses a file
//                              whose mtime moved since, so a plan that raced a
//                              live agent's write cannot delete fresh content.
//   PrunePlan.skipped          a spared file counts under the FIRST reason that
//                              spared it, so the counts partition the spared
//                              set rather than overlapping.
export type PruneCandidate = PruneCandidateWire;
export type PruneSkip = PruneSkipWire;
export type PrunePlan = PrunePlanWire;
export type { PruneTarget, PrunePolicy, PruneSkipReason };

export interface PruneDeps {
  // <stateRoot>/logs. The fence root: nothing outside it is ever deletable.
  logsDir: string;
  now: number;
  // Session ids currently live across the office. Session ids are UUIDs, so a
  // flat set needs no per-agent keying.
  activeSessionIds: ReadonlySet<string>;
  // server/persistence.ts loadSessionsMap, narrowed to what pruning needs.
  loadSessionsMap(agentId: string): Record<string, { forkedFrom?: string }>;
  // Attachment filenames owed to messages still sitting in this agent's queue,
  // or NULL when the queue state could not be determined.
  //
  // A queued message's attachments do NOT appear in any transcript until the
  // queue flushes, so the reachability scan is blind to them: an attachment on
  // a message that has been waiting for a stuck or busy agent longer than the
  // age cutoff would otherwise read as an orphan and get deleted BEFORE it is
  // ever delivered. The wiring unions the live in-memory queue with the durable
  // message-queues.json, because the HTTP listener binds before restoreAgents
  // repopulates the in-memory side.
  //
  // NULL IS NOT AN EMPTY SET. An unreadable or malformed queue file means we do
  // not know what is owed, and "we do not know" must never be collapsed into
  // "nothing is owed" on a path that deletes files — the same fail-closed rule
  // the unreadable-transcript branch follows.
  queuedAttachments(agentId: string): ReadonlySet<string> | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Resolve a candidate's RELATIVE path against the logs root, or null if it
// escapes. Lexical containment alone would not be enough if we followed
// symlinks — we never do (see the header), and apply re-lstats before unlink.
export function resolveCandidatePath(
  logsDir: string,
  relative: string,
): string | null {
  if (
    relative === "" ||
    relative.startsWith("/") ||
    relative.startsWith("\\")
  ) {
    return null;
  }
  const root = resolve(logsDir);
  const target = resolve(root, relative);
  return target.startsWith(root + sep) ? target : null;
}

// The containment check the lexical one cannot do: resolve the candidate's
// PARENT through every symlink and require the result to stay under the real
// logs root. Called immediately before unlink.
export function parentInsideLogsRoot(
  realLogsRoot: string,
  absCandidate: string,
): boolean {
  try {
    const realParent = realpathSync(dirname(absCandidate));
    return (
      realParent === realLogsRoot || realParent.startsWith(realLogsRoot + sep)
    );
  } catch {
    return false;
  }
}

// Prove no PARENT component is a symlink, by lstat-ing each accumulated prefix.
//
// realpath-containment alone is not quite enough: a symlink pointing from one
// agent's files/ to ANOTHER agent's files/ resolves to a path still under the
// logs root, so containment passes while the file we delete belongs to an agent
// whose transcripts were never consulted for reachability. Requiring every
// parent to be a real directory rules that out too.
//
// RESIDUAL, deliberately not papered over: this narrows the race, it does not
// close it. Between the last lstat here and the unlink, a same-user process
// could still swap a parent. Closing that needs unlinkat() against an opened
// directory fd, which Bun does not expose. See the module header for the trust
// statement that goes with it.
export function noSymlinkParents(logsRoot: string, relPath: string): boolean {
  const parts = relPath.split(/[/\\]/).filter((p) => p !== "");
  if (parts.length === 0) return false;
  let prefix = logsRoot;
  // Every component except the leaf must be a REAL directory.
  for (const part of parts.slice(0, -1)) {
    prefix = join(prefix, part);
    try {
      if (!lstatSync(prefix).isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// Accumulates BOTH the aggregate counts that ride on the wire and the
// per-path attribution the apply pass uses to explain a refusal.
interface SkipLedger {
  totals: Map<PruneSkipReason, PruneSkip>;
  byPath: Map<string, PruneSkipReason>;
}

function newLedger(): SkipLedger {
  return { totals: new Map(), byPath: new Map() };
}

function addSkip(
  ledger: SkipLedger,
  relPath: string,
  reason: PruneSkipReason,
  bytes: number,
) {
  const entry = ledger.totals.get(reason) ?? { reason, count: 0, bytes: 0 };
  entry.count++;
  entry.bytes += bytes;
  ledger.totals.set(reason, entry);
  ledger.byPath.set(relPath, reason);
}

// Agent log dirs, by the layout persistence.ts writes: `agent-<id>` directories
// directly under logs/. Dirent.isDirectory() is lstat-based, so a SYMLINK named
// like an agent dir is not a directory here and never gets traversed. The
// `agent-` prefix keeps anything else that lands in logs/ out of the delete
// path entirely (same rule as persistence.listAllAgentIdsOnDisk).
function listAgentDirs(logsDir: string): string[] {
  try {
    return readdirSync(logsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("agent-"))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// True only for a REAL directory. readdirSync follows a symlinked directory, so
// every directory this module is about to list must be lstat-checked first:
// `logs/agent-x/files` replaced with a symlink would otherwise have us list —
// and then unlink — files outside the logs tree entirely.
function isRealDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function planTranscripts(
  deps: PruneDeps,
  policy: PrunePolicy,
  ledger: SkipLedger,
): PrunePlan {
  const candidates: PruneCandidate[] = [];
  const cutoff = deps.now - policy.olderThanDays * DAY_MS;

  for (const agentId of listAgentDirs(deps.logsDir)) {
    const agentDir = join(deps.logsDir, agentId);
    let names: string[];
    try {
      names = readdirSync(agentDir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
        .map((d) => d.name);
    } catch {
      continue;
    }

    const files: { sessionId: string; size: number; mtime: number }[] = [];
    for (const name of names) {
      try {
        const stat = lstatSync(join(agentDir, name));
        files.push({
          sessionId: name.slice(0, -".jsonl".length),
          size: stat.size,
          mtime: stat.mtimeMs,
        });
      } catch {
        // Vanished under us; nothing to prune.
      }
    }
    if (files.length === 0) continue;

    // Newest first: the first keepPerAgent are spared on recency alone.
    files.sort((a, b) => b.mtime - a.mtime);
    const forkAncestors = new Set<string>();
    for (const meta of Object.values(deps.loadSessionsMap(agentId))) {
      if (meta?.forkedFrom) forkAncestors.add(meta.forkedFrom);
    }

    files.forEach((file, index) => {
      const rel = join(agentId, `${file.sessionId}.jsonl`);
      // Order matters: skip reasons partition the spared set, first match wins.
      if (deps.activeSessionIds.has(file.sessionId)) {
        addSkip(ledger, rel, "active-session", file.size);
        return;
      }
      if (index < policy.keepPerAgent) {
        addSkip(ledger, rel, "keep-newest", file.size);
        return;
      }
      if (forkAncestors.has(file.sessionId)) {
        addSkip(ledger, rel, "fork-ancestor", file.size);
        return;
      }
      if (file.mtime > cutoff) {
        addSkip(ledger, rel, "too-recent", file.size);
        return;
      }
      candidates.push({
        path: rel,
        bytes: file.size,
        agentId,
        sessionId: file.sessionId,
        ageDays: Math.floor((deps.now - file.mtime) / DAY_MS),
        mtimeMs: file.mtime,
      });
    });
  }

  return finishPlan("transcripts", policy, candidates, ledger);
}

// Every attachment filename any SURVIVING transcript of this agent points at.
//
// A regex over the raw JSONL rather than JSON.parse per line: attachments are
// always serialized as `"filename":"<on-disk name>"` (shared/types.ts
// Attachment), the scan is ~1s over 350 MB where parsing would be minutes, and
// over-matching is the safe direction — a stray "filename" key elsewhere in the
// log only ever protects an extra file. Deliberately reads whatever .jsonl is
// on disk right now, so pruning transcripts first is what turns their
// attachments into orphans.
// Whitespace-tolerant: persistence writes compact JSON today, but a future
// writer that pretty-prints must not silently turn every attachment into an
// orphan. Cheap insurance on a regex whose failure mode is deletion.
const FILENAME_REF = /"filename"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

function referencedAttachments(agentDir: string): Set<string> {
  const referenced = new Set<string>();
  let entries;
  try {
    entries = readdirSync(agentDir, { withFileTypes: true });
  } catch {
    return referenced;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    let raw: string;
    try {
      raw = readFileSync(join(agentDir, entry.name), "utf8");
    } catch {
      // Unreadable transcript: assume it references everything by protecting
      // nothing extra here would be backwards, so bail out of this agent
      // entirely rather than under-protect.
      throw new Error(`unreadable transcript in ${agentDir}`);
    }
    for (const match of raw.matchAll(FILENAME_REF)) {
      referenced.add(match[1]);
      // JSON escapes are rare in hash filenames but cost nothing to cover.
      try {
        referenced.add(JSON.parse(`"${match[1]}"`) as string);
      } catch {
        // Not a decodable escape sequence; the raw form is already added.
      }
    }
  }
  return referenced;
}

// Only `files/`, deliberately: `images/` is the pre-`files/` layout that
// getFilePath still falls back to, and it is a rounding error on any real box.
//
// An orphaned attachment degrades gracefully even if something we did not model
// still points at it: getFilePath returns null for a missing file, so a chip
// 404s rather than erroring.
function planAttachments(
  deps: PruneDeps,
  policy: PrunePolicy,
  ledger: SkipLedger,
): PrunePlan {
  const candidates: PruneCandidate[] = [];
  const cutoff = deps.now - policy.olderThanDays * DAY_MS;

  for (const agentId of listAgentDirs(deps.logsDir)) {
    const agentDir = join(deps.logsDir, agentId);
    const filesDir = join(agentDir, "files");
    // A symlinked files/ would make readdirSync list somebody else's directory.
    if (!isRealDir(filesDir)) continue;
    let entries;
    try {
      entries = readdirSync(filesDir, { withFileTypes: true });
    } catch {
      continue; // No attachments for this agent.
    }
    // Only pay for the transcript scan when this agent actually has files.
    // `unknownReason` non-null means we could not establish reachability and
    // every file here is spared — the two ways that happens are reported
    // separately so a dry run says WHICH unknown stopped it.
    let referenced: Set<string> | null = null;
    let unknownReason: PruneSkipReason | null = null;
    const queued = deps.queuedAttachments(agentId);
    if (queued === null) {
      // The durable queue is unreadable: what is still owed is UNKNOWN, and
      // unknown must not be collapsed into "nothing is owed" on a delete path.
      unknownReason = "queue-state-unknown";
    } else {
      try {
        referenced = referencedAttachments(agentDir);
        // Union in what the queue still owes: delivered history is not the only
        // live reference, undelivered messages are too.
        for (const name of queued) referenced.add(name);
      } catch {
        // Unreadable transcript — same fail-closed rule. Silence here would be
        // indistinguishable from "nothing to prune", so every file is a skip.
        unknownReason = "referenced";
      }
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue; // Never recurse; never unlink a directory.
      const rel = join(agentId, "files", entry.name);
      let stat;
      try {
        stat = lstatSync(join(filesDir, entry.name));
      } catch {
        continue;
      }
      // Order matters: skip reasons partition the spared set, first match wins.
      if (unknownReason !== null) {
        addSkip(ledger, rel, unknownReason, stat.size);
        continue;
      }
      if (referenced !== null && referenced.has(entry.name)) {
        addSkip(ledger, rel, "referenced", stat.size);
        continue;
      }
      if (stat.mtimeMs > cutoff) {
        addSkip(ledger, rel, "too-recent", stat.size);
        continue;
      }
      candidates.push({
        path: rel,
        bytes: stat.size,
        agentId,
        ageDays: Math.floor((deps.now - stat.mtimeMs) / DAY_MS),
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  return finishPlan("attachments", policy, candidates, ledger);
}

const SKIP_ORDER: PruneSkipReason[] = [
  "queue-state-unknown",
  "active-session",
  "keep-newest",
  "fork-ancestor",
  "referenced",
  "too-recent",
];

// Reported in a plan when reachability could not be established at all. The
// route refuses an attachment APPLY carrying this — a zero-candidate plan
// already deletes nothing, but an operator deserves to be told the prune was
// blocked rather than shown a silent "nothing to do".
export const QUEUE_STATE_UNKNOWN: PruneSkipReason = "queue-state-unknown";

function finishPlan(
  target: PruneTarget,
  policy: PrunePolicy,
  candidates: PruneCandidate[],
  ledger: SkipLedger,
): PrunePlan {
  candidates.sort((a, b) => b.bytes - a.bytes);
  return {
    target,
    policy,
    candidates,
    bytes: candidates.reduce((sum, c) => sum + c.bytes, 0),
    skipped: SKIP_ORDER.map((reason) => ledger.totals.get(reason)).filter(
      (s): s is PruneSkip => s !== undefined,
    ),
  };
}

// Plan plus the per-path spare attribution. Internal: the attribution is how
// applyPrune explains a refusal, and it would be an unbounded response field if
// it rode on the wire.
function planPruneDetailed(
  target: PruneTarget,
  policy: PrunePolicy,
  deps: PruneDeps,
): { plan: PrunePlan; sparedBy: Map<string, PruneSkipReason> } {
  const ledger = newLedger();
  const plan =
    target === "transcripts"
      ? planTranscripts(deps, policy, ledger)
      : planAttachments(deps, policy, ledger);
  return { plan, sparedBy: ledger.byPath };
}

// Compute what a prune WOULD remove. Read-only.
export function planPrune(
  target: PruneTarget,
  policy: PrunePolicy,
  deps: PruneDeps,
): PrunePlan {
  return planPruneDetailed(target, policy, deps).plan;
}

// Files the apply pass declined to delete after re-checking ride in `refused`.
export type PruneResult = PruneResultWire;

// Apply a plan. Re-derives every safety property from the live filesystem:
// a plan is data, and data can be stale, hand-edited, or hostile.
export function applyPrune(plan: PrunePlan, deps: PruneDeps): PruneResult {
  const refused: { path: string; reason: string }[] = [];
  let deleted = 0;
  let bytes = 0;

  // FENCE FIRST, before a single unlink. One candidate that escapes the logs
  // root condemns the whole plan: a plan that names an out-of-fence path is not
  // a plan with one bad row, it is a plan that came from somewhere it should
  // not have, and deleting the well-formed remainder would be acting on it.
  const resolved = new Map<string, string>();
  for (const candidate of plan.candidates) {
    const abs = resolveCandidatePath(deps.logsDir, candidate.path);
    if (abs === null) {
      return {
        deleted: 0,
        bytes: 0,
        refused: [{ path: candidate.path, reason: "outside-logs-dir" }],
        aborted: `candidate escapes the logs root: ${candidate.path}`,
      };
    }
    resolved.set(candidate.path, abs);
  }

  // The logs root itself, symlinks resolved. If we cannot resolve it there is
  // nothing to prune and nothing safe to compare against, so abort.
  let realLogsRoot: string;
  try {
    realLogsRoot = realpathSync(deps.logsDir);
  } catch {
    return {
      deleted: 0,
      bytes: 0,
      refused: [],
      aborted: `logs root is not resolvable: ${deps.logsDir}`,
    };
  }

  // Recompute the plan and delete only files BOTH passes agree on. This is what
  // makes a stale plan harmless: the active-session, fork-ancestor and
  // reachability checks all re-run here against live state.
  const { plan: fresh, sparedBy } = planPruneDetailed(
    plan.target,
    plan.policy,
    deps,
  );
  const approved = new Map(fresh.candidates.map((c) => [c.path, c]));

  for (const candidate of plan.candidates) {
    const abs = resolved.get(candidate.path)!;
    const live = approved.get(candidate.path);
    if (!live) {
      // Say WHY the fresh pass excluded it, rather than collapsing every cause
      // into one opaque reason — this is the audit trail for a delete.
      const reason = sparedBy.get(candidate.path);
      refused.push({
        path: candidate.path,
        reason: reason ? `became-${reason}` : "missing",
      });
      continue;
    }
    if (live.mtimeMs !== candidate.mtimeMs) {
      refused.push({ path: candidate.path, reason: "modified-since-plan" });
      continue;
    }
    // Last checks before the irreversible step.
    //
    // The lexical fence above only rules out ".." — it cannot see a SYMLINKED
    // PARENT. If `logs/agent-x/files` were replaced with a link to somewhere
    // else, `logs/agent-x/files/name` still passes a string containment test
    // while naming a file outside the tree. So resolve the parent for real and
    // require it to stay under the real logs root.
    if (
      !parentInsideLogsRoot(realLogsRoot, abs) ||
      !noSymlinkParents(realLogsRoot, candidate.path)
    ) {
      refused.push({ path: candidate.path, reason: "parent-escapes-logs-dir" });
      continue;
    }
    // The leaf itself must be a regular file. (unlink on a symlinked LEAF would
    // only remove the link — but that reasoning does NOT extend to symlinked
    // parents, which is what the two checks above are for.) A symlink appearing
    // where the planner saw a regular file means the tree changed under us, so
    // stop touching that path rather than reason about it.
    let stat;
    try {
      stat = lstatSync(abs);
    } catch {
      refused.push({ path: candidate.path, reason: "vanished" });
      continue;
    }
    if (!stat.isFile()) {
      refused.push({ path: candidate.path, reason: "not-a-regular-file" });
      continue;
    }
    try {
      unlinkSync(abs);
      deleted++;
      bytes += live.bytes;
    } catch (err) {
      refused.push({
        path: candidate.path,
        reason: err instanceof Error ? err.message : "unlink-failed",
      });
    }
  }

  return { deleted, bytes, refused };
}
