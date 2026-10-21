// Lossless compression of old session transcripts in logs/, on request only.
//
// Like storage-prune.ts, two phases: planCompress is read-only and says what
// WOULD be compressed and why the rest was spared; applyCompress plans again
// and compresses only what both plans name, skipping a file whose mtime moved
// or whose session became active. Every reader of a transcript reads the .gz
// (server/transcript-files.ts), and the next append inflates it, so nothing
// here can lose history. That is why only the active session and the recent
// ones are spared: no keep-newest floor and no fork-ancestor rule.

import { join } from "path";
import { lstatSync, readdirSync, statSync, utimesSync } from "fs";
import type {
  CompressPlanWire,
  CompressResultWire,
  CompressSkipReason,
} from "../shared/contract-shapes.ts";
import { listAgentDirs, type PruneDeps } from "./storage-prune.ts";
import {
  commitCompressed,
  gzipTranscript,
  sessionIdOfTranscript,
} from "./transcript-files.ts";

export type CompressPlan = CompressPlanWire;
export type CompressResult = CompressResultWire;

export type CompressDeps = Pick<
  PruneDeps,
  "logsDir" | "now" | "activeSessionIds"
> & {
  // Whether a session is active NOW. The gzip of one file yields to the
  // event loop, so an agent can resume a session after the plan. Defaults to
  // activeSessionIds.
  isActiveNow?: (sessionId: string) => boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function planCompress(
  olderThanDays: number,
  deps: CompressDeps,
): CompressPlan {
  const cutoff = deps.now - olderThanDays * DAY_MS;
  const candidates: CompressPlan["candidates"] = [];
  const skipped = new Map<
    CompressSkipReason,
    { count: number; bytes: number }
  >();
  const skip = (reason: CompressSkipReason, bytes: number) => {
    const row = skipped.get(reason) ?? { count: 0, bytes: 0 };
    row.count++;
    row.bytes += bytes;
    skipped.set(reason, row);
  };

  for (const agentId of listAgentDirs(deps.logsDir)) {
    const agentDir = join(deps.logsDir, agentId);
    let entries;
    try {
      entries = readdirSync(agentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Only a plain .jsonl is work: a .gz is done, and a .gz beside its
      // .jsonl (a crash leftover) is replaced when the .jsonl is compressed.
      const named = entry.isFile() ? sessionIdOfTranscript(entry.name) : null;
      if (!named || named.compressed) continue;
      let stat;
      try {
        stat = lstatSync(join(agentDir, entry.name));
      } catch {
        continue;
      }
      if (deps.activeSessionIds.has(named.sessionId)) {
        skip("active-session", stat.size);
        continue;
      }
      if (stat.mtimeMs > cutoff) {
        skip("too-recent", stat.size);
        continue;
      }
      candidates.push({
        path: join(agentId, entry.name),
        bytes: stat.size,
        agentId,
        sessionId: named.sessionId,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  return {
    olderThanDays,
    candidates,
    bytes: candidates.reduce((sum, c) => sum + c.bytes, 0),
    skipped: [...skipped].map(([reason, row]) => ({ reason, ...row })),
  };
}

// Compresses what a fresh plan also names, unchanged since `plan`. A plan is
// data: a path the fresh plan does not name is refused, never compressed.
//
// The gzip runs off the event loop (about 40 MB/s, so a large office takes
// tens of seconds), and the server keeps serving meanwhile. The write of the
// .gz and the removal of the .jsonl then happen in one synchronous block,
// only when the file is unchanged since it was read and its session is still
// not active, so an entry appended meanwhile is never lost.
export async function applyCompress(
  plan: CompressPlan,
  deps: CompressDeps,
): Promise<CompressResult> {
  const isActiveNow =
    deps.isActiveNow ?? ((id: string) => deps.activeSessionIds.has(id));
  const fresh = new Map(
    planCompress(plan.olderThanDays, deps).candidates.map((c) => [c.path, c]),
  );
  const refused: CompressResult["refused"] = [];
  let compressed = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;

  const byAgent = new Map<string, CompressPlan["candidates"]>();
  for (const candidate of plan.candidates) {
    const live = fresh.get(candidate.path);
    if (!live) {
      refused.push({ path: candidate.path, reason: "not-in-fresh-plan" });
      continue;
    }
    if (live.mtimeMs !== candidate.mtimeMs || live.bytes !== candidate.bytes) {
      refused.push({ path: candidate.path, reason: "modified-since-plan" });
      continue;
    }
    byAgent.set(live.agentId, [...(byAgent.get(live.agentId) ?? []), live]);
  }

  for (const [agentId, files] of byAgent) {
    const agentDir = join(deps.logsDir, agentId);
    // The agent directory's mtime stands in for a killed agent's kill time
    // (agent-manager legacyKilledAtFromDisk): put it back afterwards.
    const dirStat = statSync(agentDir);
    for (const file of files) {
      try {
        const gzipped = await gzipTranscript(agentDir, file.sessionId);
        if (
          gzipped.source.size !== file.bytes ||
          gzipped.source.mtimeMs !== file.mtimeMs
        ) {
          refused.push({ path: file.path, reason: "modified-since-plan" });
          continue;
        }
        // From here to the unlink nothing yields, so no append interleaves.
        if (isActiveNow(file.sessionId)) {
          refused.push({ path: file.path, reason: "became-active-session" });
          continue;
        }
        const sizes = commitCompressed(
          agentDir,
          file.sessionId,
          gzipped.source,
          gzipped.gz,
        );
        if (!sizes) {
          refused.push({ path: file.path, reason: "modified-since-plan" });
          continue;
        }
        compressed++;
        bytesBefore += sizes.bytesBefore;
        bytesAfter += sizes.bytesAfter;
      } catch {
        refused.push({ path: file.path, reason: "compress-failed" });
      }
    }
    utimesSync(agentDir, dirStat.atime, dirStat.mtime);
  }

  return { compressed, bytesBefore, bytesAfter, refused };
}
