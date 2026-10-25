// mg: assemble P8 evidence from run-dir results; strips absolute paths.
import { readFileSync, writeFileSync } from "node:fs"
const R = "/tmp/t-4840abc5/run/mg-1792890083"
const rd = (p: string) => JSON.parse(readFileSync(`${R}/${p}`, "utf8"))
const scrub = (v: any): any => JSON.parse(JSON.stringify(v).replace(/\/(?:home|tmp|srv|opt|var|mnt|root|data)\/[^"\\\s',)]*/g, (m) => (m.startsWith("/tmp/t-4840abc5/") ? m.replace(/\/run\/mg-\d+/, "/run/mg-<ts>") : "<path>")))
const v2first = rd("p8-v2first/result.json")
const perSession = v2first.sessions.perSession
delete v2first.sessions.perSession
const ev = {
  item: "P8 migration and rollback on a real office profile copy",
  date: "2026-10-25",
  source: "office profile <id> (~699 MB, 28 v1 sessions); read only",
  preconditions: {
    method: "pgrep -f opencode (only the checking shell matched); /proc/<pid>/cwd and /proc/<pid>/fd scanned for the profile id across ALL processes (0 hits); server.lock wc -c = 0. /proc/<pid>/environ reads are blocked by the office safety hook, so the fd/cwd scan replaced the environ grep.",
    serverLockBytes: 0,
    processesUsingProfile: 0,
    sourceCredentialFiles: "ls data/opencode | grep -c auth.json = 0 (control: same grep on copy1 after planting = 1)",
  },
  copies: {
    method: "cp -a twice into run/mg-<ts>/copy1 and /keep (mode 0700 run dir); after the office restart a third copy /keep2 was taken the same way for a clean rollback",
    duBytes: { source: 699045765, copy1: 699045765, keep: 699045765, keep2: 699045765 },
    sha256OpencodeDbPrefix: { source: "683697a2b58ac6fe", copy1: "683697a2b58ac6fe", keep: "683697a2b58ac6fe", keep2: "683697a2b58ac6fe" },
    sha256WalPrefix: { source: "a04d6c56c87732a2", all_copies: "a04d6c56c87732a2" },
    sourceUnchangedAtEnd: "re-hashed after all runs: same prefixes",
    plantedFakeAuthJson: { format: "v1 auth.json: {openai:{type:api,key}, anthropic:{type:oauth,refresh,access,expires}}", values: "fake", mode: "600", copies: ["copy1", "keep", "keep2"] },
  },
  censusDiff: "mg-p8-census-diff.json",
  v2FirstStart: scrub({ ...v2first, perSessionSummary: { total: perSession.length, visible: perSession.filter((x: any) => x.visible).length } }),
  v2SecondStart: scrub(rd("p8-v2again/result.json")),
  rollbackV1OnKeptCopy_first: scrub({ ...rd("p8-v1keep/result.json"), note: "keep copy; continue failed because the session's own directory (a deleted /tmp worktree) no longer exists (ENOENT); healthyAfterMs inflated by the harness (see harnessNote)" }),
  rollbackV1OnKeptCopy_clean: scrub({ ...rd("p8-v1keep-keep2-rewritten/result.json"), note: "keep2 copy; the v1 session row of sample 17 was pointed at a scratch repo under the run dir (copy only) because v1 ignores ?directory= and needs the session's own directory" }),
  v1AfterV2Migration_copy1: scrub({ ...rd("p8-v1copy1/result.json"), note: "copy1 after 2.1.4 migrated it; session 17 v1 row pointed at the scratch repo the same way" }),
  splitBrainCheck: {
    method: "bun:sqlite readonly on a db copy of copy1 after v1copy1 then v2again",
    v1TurnOnMigratedCopyVisibleInV2: false,
    v1MessageRowsSession17: 6,
    v2RowsWithV1Marker: 0,
    v2SessionsAfterV2Again: 29,
    v1SessionsAfterV2Again: 28,
    meaning: "after the one-time import, v1 and v2 write to different tables of the same file: a v1 turn after migration never reaches v2, a v2 session never reaches v1",
  },
  harnessNote: "common.ts startServer has no per-request timeout on its health fetch. 1.18.35 on this profile accepted the first early /global/health request and never answered it; Bun's 300 s default fetch timeout made boot look like 360 s. mg-server.ts (3 s per request) measured 5.2-6.0 s boot (boot-v1keep2-t3, p8-v1keep-keep2).",
  repoWritesByV1: "1.18.35 opened instances in session directories when their messages were read (5-10 'creating instance' lines) and wrote <gitdir>/opencode (40 bytes, project id) in real repos: created once in one repo under ~/nil, rewritten with the same content in another. 2.1.4 wrote nothing there (repoWriteSentinel empty for v2first).",
}
writeFileSync("/tmp/t-4840abc5/evidence/mg-p8-migration-rollback.json", JSON.stringify(ev, null, 2) + "\n")
const diff = rd("census/diff-v2first.json")
writeFileSync("/tmp/t-4840abc5/evidence/mg-p8-census-diff.json", JSON.stringify(scrub(diff), null, 2) + "\n")
console.log("ok")
