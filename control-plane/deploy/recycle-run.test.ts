// The recycle ladder, exercised the way a live run cannot be: with a provider
// that answers whatever the case needs and a rebuild that never happens.
//
// The two failures these tests exist for are both fail-OPEN ones, and both were
// found in review before a single command ran (2026-08-12):
//
//   1. absence inferred from a command that failed. `grep -c` exits 1 for a
//      count of zero and 2 for a file it could not read; a ladder that reads any
//      non-zero code as "nothing pending" would rebuild a box that is already
//      rebuilding, which is the one thing the recovery story forbids.
//   2. a post-state read that trusts the child for WHICH record to check. An
//      extracted id that is stale proves "reachable" about a record this run did
//      not create, and the acceptance is then vacuous.
//
// So the assertions are mostly about what does NOT happen: which commands were
// never sent, and which exit code an unproved state produces.

import { describe, expect, test } from "bun:test";
import type { BoundedResult } from "./fly-cli.ts";
import {
  ACCEPTED,
  AMBIGUOUS,
  ACCOUNT_COMMAND,
  LIST_RUNS_COMMAND,
  MAX_RUN_RECORDS,
  RECYCLE_COMMAND,
  RECYCLE_DEADLINE_MS,
  REFUSED,
  type Seams,
  classifyGrep,
  classifyList,
  connect,
  ENV_PIN_COMMAND,
  LEGACY_RUNS_COMMAND,
  PARENT_LIST_COMMAND,
  PINNED_HOME,
  classifyParent,
  envPinProved,
  volumeEntries,
  connectCommand,
  consoleArgv,
  execute,
  extractChildFacts,
  isRunId,
  judgeDelta,
  parseCount,
  pendingCommand,
  reachableCommand,
  resolveRuns,
  shellInert,
  state,
  stateFieldCommand,
  verify,
} from "./recycle-run.ts";
import {
  EXPECTED_INSTANCE_ID,
  judgeRemote,
  parseRemote,
} from "./provider-account.ts";

const RUN = "run-20260812084500-ab1c";
const OTHER_RUN = "run-20260811120000-zz9y";
/** The record the unpinned run left on the ephemeral root, measured 2026-08-12.
 * The negative control asks that this listing gains nothing. */
const LEGACY_RUN = "run-20260812130101-hc5b";

/** A clean bounded run with a code and some stdout. */
function ended(code: number, stdout = ""): BoundedResult {
  return {
    code,
    timedOut: false,
    groupSurvived: false,
    groupEmpty: true,
    stdout,
    stderr: "",
  };
}

const TIMED_OUT: BoundedResult = {
  code: null,
  timedOut: true,
  groupSurvived: false,
  groupEmpty: true,
  stdout: "",
  stderr: "",
};

const GROUP_ALIVE: BoundedResult = {
  code: 0,
  timedOut: false,
  groupSurvived: true,
  groupEmpty: false,
  stdout: "1\n",
  stderr: "",
};

const GOOD_ACCOUNT = [
  "provider_rows: 2",
  "provider_total_elements: 2",
  "listing_complete: true",
  "expected_id_present: true",
  "other_instances: 1",
  "asset_state: running",
  "power_state: running",
  "cancel_date: 2026-08-29",
].join("\n");

const CHILD_TRANSCRIPT = [
  "adopting instance 203474835 (running, running, 203.0.113.7)",
  "recycle: reinstalling 203474835 with defaultUser=root",
  "MEASUREMENT reinstall-to-SSH: 297s (ssh wait 187s)",
  `run ${RUN} recorded; login user is root`,
].join("\n");

/** A console whose answers are looked up by command, and which REMEMBERS the
 * order it was asked - which is what the ordering assertions read. */
function fakeConsole(answers: Record<string, BoundedResult | BoundedResult[]>) {
  const sent: string[] = [];
  const cursor: Record<string, number> = {};
  return {
    sent,
    run: async (command: string): Promise<BoundedResult> => {
      sent.push(command);
      const answer = answers[command];
      if (answer === undefined) throw new Error(`unmapped command: ${command}`);
      if (!Array.isArray(answer)) return answer;
      const at = cursor[command] ?? 0;
      cursor[command] = at + 1;
      return answer[Math.min(at, answer.length - 1)];
    },
  };
}

/** The happy world: one stranger on the account, an empty runs directory, a
 * rebuild that writes exactly one reachable record - and, since the env fix, a
 * volume that gains runs, keys and the audit log while the old ephemeral root
 * gains nothing. */
function happyAnswers() {
  const listing = [ended(0, ""), ended(0, `${RUN}.json\n`)];
  return {
    [LIST_RUNS_COMMAND]: listing,
    [PARENT_LIST_COMMAND]: [
      parentListing(MARKER, "keys"),
      parentListing(MARKER, "keys", "runs", "audit.jsonl"),
    ],
    [ENV_PIN_COMMAND]: ended(0, "/data\n"),
    [LEGACY_RUNS_COMMAND]: ended(0, `${LEGACY_RUN}.json\n`),
    [ACCOUNT_COMMAND]: ended(0, GOOD_ACCOUNT),
    [RECYCLE_COMMAND]: ended(0, CHILD_TRANSCRIPT),
    [stateFieldCommand(RUN)]: ended(0, "1\n"),
    [pendingCommand(RUN)]: ended(1, "0\n"),
    [reachableCommand(RUN)]: ended(0, "1\n"),
  };
}

function seamsFor(
  answers: Record<string, BoundedResult | BoundedResult[]>,
  health: boolean | null = true,
) {
  const console_ = fakeConsole(answers);
  const said: string[] = [];
  const seams: Seams = {
    health: async () => health,
    run: console_.run,
    say: (line) => said.push(line),
  };
  return { seams, said, sent: console_.sent };
}

/** One printed label's value. */
function label(said: string[], name: string): string | undefined {
  const line = said.find((l) => l.startsWith(`${name}: `));
  return line?.slice(name.length + 2);
}

describe("remote commands are shell-inert, and the id is validated", () => {
  test("every command this program sends survives a re-split", () => {
    for (const command of [
      LIST_RUNS_COMMAND,
      PARENT_LIST_COMMAND,
      ACCOUNT_COMMAND,
      RECYCLE_COMMAND,
      connectCommand(RUN),
      stateFieldCommand(RUN),
      pendingCommand(RUN),
      reachableCommand(RUN),
    ]) {
      expect(shellInert(command)).toBe(true);
      // The wire carries the pinned-home prefix; inertness covers the whole line.
      expect(consoleArgv(command)[6]).toBe(
        `env HOME=${PINNED_HOME} ${command}`,
      );
    }
  });

  test("a quoted or spaced pattern is refused rather than sent", () => {
    expect(shellInert('grep -c "state": file')).toBe(false);
    expect(shellInert("grep -c state; rm -rf /data file")).toBe(false);
    expect(shellInert("grep -c $STATE file")).toBe(false);
    expect(() => consoleArgv('grep -c "x y" file')).toThrow();
  });

  test("the recycle command carries the literal box and host", () => {
    expect(RECYCLE_COMMAND).toContain(` --instance ${EXPECTED_INSTANCE_ID} `);
    expect(RECYCLE_COMMAND).toContain(" --host cp2.test.isomux.app");
    expect(EXPECTED_INSTANCE_ID).toBe("203474835");
  });

  test("a run id of an unruled shape reaches no command line", () => {
    expect(isRunId(RUN)).toBe(true);
    expect(isRunId("../../etc/passwd")).toBe(false);
    expect(isRunId("run-1 2")).toBe(false);
    expect(isRunId("RUN-20260812")).toBe(false);
    expect(isRunId("inst-20260812")).toBe(false);
    expect(() => stateFieldCommand("../../etc/passwd")).toThrow();
    expect(() => connectCommand("run-1;rm")).toThrow();
  });
});

describe("grep exit codes mean what they mean - absence is proved, not inferred", () => {
  test("exit 1 with a count of 0 is the only absence", () => {
    expect(classifyGrep(ended(1, "0\n"))).toEqual({ kind: "count", count: 0 });
  });

  test("exit 0 with a count of 1 is a match", () => {
    expect(classifyGrep(ended(0, "1\n"))).toEqual({ kind: "count", count: 1 });
  });

  test("exit 2 is unreadable, never zero", () => {
    expect(classifyGrep(ended(2, ""))).toEqual({ kind: "unreadable" });
    expect(classifyGrep(ended(2, "0\n"))).toEqual({ kind: "unreadable" });
  });

  test("a code and a count that disagree are not evidence", () => {
    expect(classifyGrep(ended(0, "0\n"))).toEqual({ kind: "unusable" });
    expect(classifyGrep(ended(1, "1\n"))).toEqual({ kind: "unusable" });
  });

  test("an unparsable count is not a count", () => {
    expect(classifyGrep(ended(0, "grep: no such file\n"))).toEqual({
      kind: "unusable",
    });
    expect(classifyGrep(ended(0, "\n"))).toEqual({ kind: "unusable" });
    expect(parseCount(" 12 \n")).toBe(12);
    expect(parseCount("")).toBe(null);
    expect(parseCount("1 2")).toBe(null);
  });

  test("a run that did not end cleanly is unusable whatever it printed", () => {
    expect(classifyGrep(TIMED_OUT)).toEqual({ kind: "unusable" });
    expect(classifyGrep(GROUP_ALIVE)).toEqual({ kind: "unusable" });
  });
});

describe("the runs directory is a reading or a refusal", () => {
  test("an empty directory is zero records", () => {
    expect(classifyList(ended(0, ""))).toEqual({ kind: "ids", ids: [] });
  });

  test("an absent directory is unreadable, never zero records", () => {
    expect(classifyList(ended(2, ""))).toEqual({ kind: "unreadable" });
    expect(classifyList(ended(1, ""))).toEqual({ kind: "unreadable" });
  });

  test("ids come back sorted, and only from record filenames", () => {
    expect(classifyList(ended(0, `${RUN}.json\n${OTHER_RUN}.json\n`))).toEqual({
      kind: "ids",
      ids: [OTHER_RUN, RUN].sort(),
    });
  });

  test("a leftover temp file or a stray entry is malformed", () => {
    expect(classifyList(ended(0, `${RUN}.json.4711.tmp\n`))).toEqual({
      kind: "malformed",
    });
    expect(classifyList(ended(0, `${RUN}.json\nkeys\n`))).toEqual({
      kind: "malformed",
    });
    expect(classifyList(ended(0, `${RUN}.json\n${RUN}.json\n`))).toEqual({
      kind: "malformed",
    });
  });

  test("more records than the walk allows is its own refusal", () => {
    const many = Array.from(
      { length: MAX_RUN_RECORDS + 1 },
      (_, i) => `run-2026081200000${i}-aaaa.json`,
    ).join("\n");
    expect(classifyList(ended(0, many))).toEqual({ kind: "over_cap" });
  });

  test("an unclean run is unusable", () => {
    expect(classifyList(TIMED_OUT)).toEqual({ kind: "unusable" });
  });
});

// The state root, listed with dotfiles. `.deployment` is the boot marker and is
// the POSITIVE CONTROL: without requiring it, a clean empty listing - which is
// exactly what a volume that has never held a run looks like, and also what a
// transport returning success with no output looks like - would read as "runs is
// absent" and put absence back on an empty answer (reviewer sharpening).
const MARKER = ".deployment";
const parentListing = (...entries: string[]) =>
  ended(0, [".", "..", ...entries].join("\n") + "\n");

describe("every command carries the pinned home, and the pin is proved", () => {
  test("the prefix is on every command, and it is inert", () => {
    for (const command of [
      LIST_RUNS_COMMAND,
      PARENT_LIST_COMMAND,
      LEGACY_RUNS_COMMAND,
      ENV_PIN_COMMAND,
      ACCOUNT_COMMAND,
      RECYCLE_COMMAND,
      connectCommand(RUN),
      stateFieldCommand(RUN),
      pendingCommand(RUN),
      reachableCommand(RUN),
    ]) {
      // Uniform, including the reads: sorting commands into writers and readers
      // is what produced two audit logs.
      expect(consoleArgv(command)[6]).toBe(`env HOME=/data ${command}`);
      expect(shellInert(`env HOME=${PINNED_HOME} ${command}`)).toBe(true);
    }
  });

  test("only the pinned path proves the prefix reached the child", () => {
    expect(envPinProved(ended(0, "/data\n"))).toBe(true);
    expect(envPinProved(ended(0, "/data"))).toBe(true);
    expect(envPinProved(ended(0, "/root\n"))).toBe(false);
    expect(envPinProved(ended(0, "/data/other\n"))).toBe(false);
    expect(envPinProved(ended(0, ""))).toBe(false);
    expect(envPinProved(ended(1, "/data\n"))).toBe(false);
    expect(envPinProved(TIMED_OUT)).toBe(false);
    expect(envPinProved(GROUP_ALIVE)).toBe(false);
  });
});

describe("the volume's own entries, as the audit-unity control", () => {
  test("the four booleans come from the listing", () => {
    expect(
      volumeEntries(parentListing(MARKER, "runs", "keys", "audit.jsonl")),
    ).toEqual({ marker: true, runs: true, keys: true, audit: true });
    expect(volumeEntries(parentListing(MARKER))).toEqual({
      marker: true,
      runs: false,
      keys: false,
      audit: false,
    });
  });

  test("a listing without the marker establishes nothing", () => {
    expect(volumeEntries(parentListing("runs", "keys", "audit.jsonl"))).toBe(
      null,
    );
    expect(volumeEntries(ended(0, ""))).toBe(null);
  });

  test("a non-zero or unclean read establishes nothing", () => {
    expect(volumeEntries(ended(2, ""))).toBe(null);
    expect(volumeEntries(TIMED_OUT)).toBe(null);
    expect(volumeEntries(GROUP_ALIVE)).toBe(null);
  });

  // A failed read that still PRINTED entries is the case the marker control
  // cannot catch, so the exit code has to be checked in its own right.
  test("a non-zero read is refused even when it printed a full listing", () => {
    const full = parentListing(MARKER, "runs", "keys", "audit.jsonl");
    expect(volumeEntries({ ...full, code: 2 })).toBe(null);
    expect(volumeEntries({ ...full, code: 1 })).toBe(null);
    expect(volumeEntries({ ...full, timedOut: true, code: null })).toBe(null);
  });
});

describe("the runs directory's absence is proved by the parent, or not at all", () => {
  test("the marker present and no runs entry proves absence", () => {
    expect(classifyParent(parentListing(MARKER))).toEqual({
      kind: "runs_absent",
    });
    expect(
      classifyParent(parentListing(MARKER, "keys", "audit.jsonl")),
    ).toEqual({ kind: "runs_absent" });
  });

  test("a runs entry means the earlier refusal was a failed read", () => {
    expect(classifyParent(parentListing(MARKER, "runs"))).toEqual({
      kind: "runs_present",
    });
  });

  test("no marker establishes nothing, even with entries present", () => {
    expect(classifyParent(parentListing("keys"))).toEqual({
      kind: "no_marker",
    });
  });

  test("a clean EMPTY listing establishes nothing", () => {
    expect(classifyParent(ended(0, ""))).toEqual({ kind: "no_marker" });
    expect(classifyParent(ended(0, "\n"))).toEqual({ kind: "no_marker" });
    expect(classifyParent(ended(0, ".\n..\n"))).toEqual({ kind: "no_marker" });
  });

  test("a non-zero or unclean parent read establishes nothing", () => {
    expect(classifyParent(ended(2, ""))).toEqual({ kind: "unreadable" });
    expect(classifyParent(TIMED_OUT)).toEqual({ kind: "unusable" });
    expect(classifyParent(GROUP_ALIVE)).toEqual({ kind: "unusable" });
  });

  test("the parent is read only when the runs listing refused", async () => {
    const { seams, sent } = seamsFor({
      [LIST_RUNS_COMMAND]: ended(0, `${RUN}.json\n`),
    });
    const reading = await resolveRuns(seams);
    expect(reading.ids).toEqual([RUN]);
    expect(reading.dirPresent).toBe(true);
    expect(reading.parent).toBe(null);
    expect(sent).not.toContain(PARENT_LIST_COMMAND);
  });

  test("a malformed listing does not get a second chance from the parent", async () => {
    const { seams, sent } = seamsFor({
      [LIST_RUNS_COMMAND]: ended(0, "stray-file\n"),
    });
    const reading = await resolveRuns(seams);
    expect(reading.ids).toBe(null);
    expect(reading.listing).toBe("malformed");
    // It exited 0, so the directory DOES exist - its contents are what refuses.
    expect(reading.dirPresent).toBe(true);
    expect(sent).not.toContain(PARENT_LIST_COMMAND);
  });

  test("an unusable listing claims nothing about the directory", async () => {
    const { seams, sent } = seamsFor({ [LIST_RUNS_COMMAND]: TIMED_OUT });
    const reading = await resolveRuns(seams);
    expect(reading.ids).toBe(null);
    expect(reading.listing).toBe("unusable");
    expect(reading.dirPresent).toBe(null);
    expect(sent).not.toContain(PARENT_LIST_COMMAND);
  });

  test("a refused listing plus a proved-absent parent is zero records", async () => {
    const { seams, sent } = seamsFor({
      [LIST_RUNS_COMMAND]: ended(2, ""),
      [PARENT_LIST_COMMAND]: parentListing(MARKER),
    });
    const reading = await resolveRuns(seams);
    expect(reading.ids).toEqual([]);
    expect(reading.dirPresent).toBe(false);
    expect(reading.parent).toBe("runs_absent");
    expect(reading.markerPresent).toBe(true);
    expect(sent).toContain(PARENT_LIST_COMMAND);
  });

  test("a refused listing with runs present stays a refusal", async () => {
    const { seams } = seamsFor({
      [LIST_RUNS_COMMAND]: ended(2, ""),
      [PARENT_LIST_COMMAND]: parentListing(MARKER, "runs"),
    });
    const reading = await resolveRuns(seams);
    expect(reading.ids).toBe(null);
    expect(reading.dirPresent).toBe(true);
    expect(reading.parent).toBe("runs_present");
  });

  test("a refused listing with an empty parent stays a refusal", async () => {
    const { seams } = seamsFor({
      [LIST_RUNS_COMMAND]: ended(2, ""),
      [PARENT_LIST_COMMAND]: ended(0, ""),
    });
    const reading = await resolveRuns(seams);
    expect(reading.ids).toBe(null);
    expect(reading.markerPresent).toBe(false);
    expect(reading.parent).toBe("no_marker");
  });

  test("a refused listing with an unreadable parent stays a refusal", async () => {
    for (const answer of [ended(2, ""), TIMED_OUT]) {
      const { seams } = seamsFor({
        [LIST_RUNS_COMMAND]: ended(2, ""),
        [PARENT_LIST_COMMAND]: answer,
      });
      const reading = await resolveRuns(seams);
      expect(reading.ids).toBe(null);
      expect(reading.dirPresent).toBe(null);
      expect(reading.markerPresent).toBe(null);
    }
  });
});

describe("the child's transcript crosses as three whitelisted facts", () => {
  test("the recorded line and the measurement are extracted", () => {
    expect(extractChildFacts(CHILD_TRANSCRIPT)).toEqual({
      runId: RUN,
      seconds: 297,
      loginUser: "root",
    });
  });

  test("nothing else crosses, including an address or an error blob", () => {
    const facts = extractChildFacts(
      [
        "Error: connect ECONNREFUSED 203.0.113.7:22 (host cp2.test.isomux.app)",
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        `run ${RUN} recorded; login user is root`,
      ].join("\n"),
    );
    expect(facts).toEqual({ runId: RUN, seconds: null, loginUser: "root" });
    expect(JSON.stringify(facts)).not.toContain("203.0.113.7");
  });

  test("two recorded lines yield no id at all", () => {
    const twice = `run ${RUN} recorded; login user is root\nrun ${OTHER_RUN} recorded; login user is root`;
    expect(extractChildFacts(twice).runId).toBe(null);
  });

  test("a missing recorded line yields no id", () => {
    expect(
      extractChildFacts("MEASUREMENT reinstall-to-SSH: 10s (ssh wait 9s)"),
    ).toEqual({ runId: null, seconds: 10, loginUser: null });
  });
});

describe("the listing delta corroborates the child", () => {
  test("exactly one new id, and it is the child's", () => {
    const v = judgeDelta([OTHER_RUN], [OTHER_RUN, RUN], RUN);
    expect(v.ok).toBe(true);
    expect(v.added).toBe(1);
    expect(v.removed).toBe(0);
  });

  test("no new record is not an acceptance", () => {
    expect(judgeDelta([OTHER_RUN], [OTHER_RUN], RUN).ok).toBe(false);
  });

  test("two new records is not an acceptance", () => {
    const v = judgeDelta([], [RUN, OTHER_RUN], RUN);
    expect(v.ok).toBe(false);
    expect(v.added).toBe(2);
  });

  test("a mismatched id is not an acceptance", () => {
    const v = judgeDelta([], [OTHER_RUN], RUN);
    expect(v.ok).toBe(false);
    expect(v.matchesChild).toBe(false);
  });

  test("an id the child never printed is not an acceptance", () => {
    expect(judgeDelta([], [RUN], null).ok).toBe(false);
  });

  test("a record that vanished is not an acceptance", () => {
    const v = judgeDelta([OTHER_RUN], [RUN], RUN);
    expect(v.ok).toBe(false);
    expect(v.removed).toBe(1);
  });
});

// WHY TWO OF THE ACCEPTANCE CLAUSES CANNOT BE MUTATION-KILLED HERE, written
// down rather than left as a gap in the mutation report (2026-08-12). The
// account gate reads `!before.ok || !before.cancelScheduled`, and the second
// clause alone is observably equivalent, because `judgeRemote` never reports a
// scheduled cancel for a reading it refused. The clause stays as the statement
// of what the rung requires; this test pins the invariant that makes the
// redundancy safe, so a future `judgeRemote` that broke it would fail HERE.
describe("the invariant behind the account gate's redundant clause", () => {
  test("a refused reading never claims a scheduled cancel", () => {
    for (const remote of [
      GOOD_ACCOUNT.replace("listing_complete: true", "listing_complete: false"),
      GOOD_ACCOUNT.replace(
        "expected_id_present: true",
        "expected_id_present: false",
      ),
      GOOD_ACCOUNT.replace("other_instances: 1", "other_instances: 2"),
      GOOD_ACCOUNT.replace("provider_rows: 2", "provider_rows: 9"),
      GOOD_ACCOUNT.replace("asset_state: running", "asset_state: on_fire"),
      GOOD_ACCOUNT.replace(
        "cancel_date: 2026-08-29",
        "cancel_date: 2026-99-99",
      ),
    ]) {
      const verdict = judgeRemote(parseRemote(remote));
      expect(verdict.ok).toBe(false);
      expect(verdict.cancelScheduled).toBe(false);
    }
    expect(judgeRemote(null).cancelScheduled).toBe(false);
  });
});

describe("execute: the happy ladder", () => {
  test("accepts, and sends the rungs in the only order they may run", async () => {
    const { seams, said, sent } = seamsFor(happyAnswers());
    expect(await execute(seams)).toBe(ACCEPTED);
    expect(label(said, "recycle_accepted")).toBe("true");
    expect(label(said, "run_id")).toBe(RUN);
    expect(label(said, "cancel_date")).toBe("2026-08-29");
    expect(label(said, "cancel_date_after")).toBe("2026-08-29");
    expect(label(said, "cancel_date_unchanged")).toBe("true");
    expect(label(said, "other_instances")).toBe("1");
    expect(label(said, "other_instances_after")).toBe("1");
    expect(label(said, "pending_rebuilds_before")).toBe("0");
    expect(label(said, "pending_rebuilds_after")).toBe("0");
    expect(label(said, "run_state_reachable")).toBe("true");
    expect(label(said, "next_action")).toBe("none");
    // The account and the runs listing both precede the rebuild.
    expect(sent.indexOf(ACCOUNT_COMMAND)).toBeLessThan(
      sent.indexOf(RECYCLE_COMMAND),
    );
    expect(sent.indexOf(LIST_RUNS_COMMAND)).toBeLessThan(
      sent.indexOf(RECYCLE_COMMAND),
    );
    // Exactly one rebuild, on the happy path as on every other.
    expect(sent.filter((c) => c === RECYCLE_COMMAND).length).toBe(1);
  });

  // The state this volume is actually in, measured 2026-08-12: no run has ever
  // been written, so the runs directory does not exist yet and `saveRun` creates
  // it 0700 on the write that matters. The transcript must show it going from
  // absent to present across the rebuild.
  test("a virgin volume is accepted, and the directory appears across the rebuild", async () => {
    const { seams, said, sent } = seamsFor({
      ...happyAnswers(),
      [LIST_RUNS_COMMAND]: [ended(2, ""), ended(0, `${RUN}.json\n`)],
      // Read three times on this path: the volume rung, resolveRuns' absence
      // proof, then the volume rung again after the rebuild.
      [PARENT_LIST_COMMAND]: [
        parentListing(MARKER, "keys"),
        parentListing(MARKER, "keys"),
        parentListing(MARKER, "keys", "runs", "audit.jsonl"),
      ],
    });
    expect(await execute(seams)).toBe(ACCEPTED);
    expect(label(said, "volume_audit_before")).toBe("false");
    expect(label(said, "volume_audit_after")).toBe("true");
    expect(label(said, "legacy_runs_added")).toBe("0");
    expect(label(said, "runs_dir_present_before")).toBe("false");
    expect(label(said, "runs_before")).toBe("0");
    expect(label(said, "pending_rebuilds_before")).toBe("0");
    expect(label(said, "runs_dir_present_after")).toBe("true");
    expect(label(said, "runs_added")).toBe("1");
    expect(label(said, "recycle_accepted")).toBe("true");
    expect(sent.filter((c) => c === RECYCLE_COMMAND).length).toBe(1);
    // No grep runs before the rebuild on a virgin volume - there is nothing to
    // read - so the post-state reads are the first exercise of that path.
    expect(sent.indexOf(PARENT_LIST_COMMAND)).toBeLessThan(
      sent.indexOf(RECYCLE_COMMAND),
    );
    expect(sent.indexOf(stateFieldCommand(RUN))).toBeGreaterThan(
      sent.indexOf(RECYCLE_COMMAND),
    );
  });

  test("a directory still absent after a clean rebuild is ambiguous", async () => {
    const { seams, said } = seamsFor({
      ...happyAnswers(),
      [LIST_RUNS_COMMAND]: ended(2, ""),
      [PARENT_LIST_COMMAND]: parentListing(MARKER),
    });
    expect(await execute(seams)).toBe(AMBIGUOUS);
    expect(label(said, "runs_dir_present_after")).toBe("false");
    expect(label(said, "runs_added")).toBe("0");
    expect(label(said, "next_action")).toBe("verify");
  });

  test("the report-only facts are printed and marked as such", async () => {
    const { seams, said } = seamsFor(happyAnswers());
    await execute(seams);
    expect(said).toContain("reinstall_to_ssh_seconds: 297 (report only)");
    expect(said).toContain("login_user: root (report only)");
  });

  test("the rebuild gets the deadline that sits above the child's own wait", async () => {
    const seen: number[] = [];
    const answers = happyAnswers();
    const inner = fakeConsole(answers);
    const seams: Seams = {
      health: async () => true,
      run: (command, deadlineMs) => {
        if (command === RECYCLE_COMMAND) seen.push(deadlineMs);
        return inner.run(command);
      },
      say: () => {},
    };
    await execute(seams);
    expect(seen).toEqual([RECYCLE_DEADLINE_MS]);
    expect(RECYCLE_DEADLINE_MS).toBeGreaterThan(15 * 60_000);
  });
});

describe("execute: nothing is rebuilt when a gate is unmet", () => {
  const refuses = async (
    answers: Record<string, BoundedResult | BoundedResult[]>,
    health: boolean | null = true,
  ) => {
    const { seams, said, sent } = seamsFor(answers, health);
    const code = await execute(seams);
    expect(code).toBe(REFUSED);
    expect(sent).not.toContain(RECYCLE_COMMAND);
    expect(label(said, "recycle_spawned")).toBe("false");
    expect(label(said, "next_action")).toBe("stop_and_report");
    return said;
  };

  test("an unreadable health surface refuses before the account is read", async () => {
    const { seams, sent } = seamsFor(happyAnswers(), null);
    expect(await execute(seams)).toBe(REFUSED);
    expect(sent).toEqual([]);
  });

  test("a machine that does not hold the credentials refuses", async () => {
    const said = await refuses(happyAnswers(), false);
    expect(label(said, "provider_configured")).toBe("false");
  });

  test("a stranger count above one refuses with the number only", async () => {
    const two = GOOD_ACCOUNT.replace("provider_rows: 2", "provider_rows: 3")
      .replace("provider_total_elements: 2", "provider_total_elements: 3")
      .replace("other_instances: 1", "other_instances: 2");
    const said = await refuses({
      ...happyAnswers(),
      [ACCOUNT_COMMAND]: ended(0, two),
    });
    expect(label(said, "other_instances")).toBe("2");
    expect(label(said, "account_as_ruling_7_requires")).toBe("false");
  });

  test("an incomplete listing refuses", async () => {
    const said = await refuses({
      ...happyAnswers(),
      [ACCOUNT_COMMAND]: ended(
        0,
        GOOD_ACCOUNT.replace(
          "listing_complete: true",
          "listing_complete: false",
        ),
      ),
    });
    expect(label(said, "listing_complete")).toBe("false");
  });

  test("a box that is no longer cancel-scheduled refuses", async () => {
    const said = await refuses({
      ...happyAnswers(),
      [ACCOUNT_COMMAND]: ended(
        0,
        GOOD_ACCOUNT.replace("cancel_date: 2026-08-29", "cancel_date: none"),
      ),
    });
    expect(label(said, "cancel_scheduled")).toBe("false");
  });

  test("an account read that did not end cleanly refuses", async () => {
    await refuses({ ...happyAnswers(), [ACCOUNT_COMMAND]: GROUP_ALIVE });
  });

  // The volume read comes FIRST now, so these give it a good answer and fail the
  // parent read that `resolveRuns` takes afterwards - which is the interaction
  // each of them was written to exercise.
  test("a refused runs listing the parent cannot explain refuses", async () => {
    const said = await refuses({
      ...happyAnswers(),
      [LIST_RUNS_COMMAND]: ended(2, ""),
      [PARENT_LIST_COMMAND]: [parentListing(MARKER, "keys"), ended(2, "")],
    });
    expect(label(said, "runs_listing_before")).toBe("unreadable");
    expect(label(said, "runs_parent_before")).toBe("unreadable");
    expect(label(said, "runs_dir_present_before")).toBe("unknown");
  });

  test("a refused listing over an EXISTING runs directory refuses", async () => {
    const said = await refuses({
      ...happyAnswers(),
      [LIST_RUNS_COMMAND]: ended(2, ""),
      [PARENT_LIST_COMMAND]: [
        parentListing(MARKER, "runs"),
        parentListing(MARKER, "runs"),
      ],
    });
    expect(label(said, "runs_parent_before")).toBe("runs_present");
    expect(label(said, "runs_dir_present_before")).toBe("true");
  });

  test("a refused listing with an empty parent refuses", async () => {
    const said = await refuses({
      ...happyAnswers(),
      [LIST_RUNS_COMMAND]: ended(2, ""),
      [PARENT_LIST_COMMAND]: [parentListing(MARKER, "keys"), ended(0, "")],
    });
    expect(label(said, "runs_parent_before")).toBe("no_marker");
    expect(label(said, "runs_parent_marker_present_before")).toBe("false");
  });

  test("an unproved env pin refuses before anything else is read", async () => {
    for (const answer of [
      ended(0, "/root\n"),
      ended(0, ""),
      ended(2, ""),
      TIMED_OUT,
    ]) {
      const { seams, said, sent } = seamsFor({
        ...happyAnswers(),
        [ENV_PIN_COMMAND]: answer,
      });
      expect(await execute(seams)).toBe(REFUSED);
      expect(label(said, "env_pin_proved")).toBe("false");
      expect(sent).not.toContain(RECYCLE_COMMAND);
      // The pin is the link everything after depends on, so nothing after it runs.
      expect(sent).not.toContain(LIST_RUNS_COMMAND);
      expect(sent).not.toContain(LEGACY_RUNS_COMMAND);
    }
  });

  test("a volume read that establishes nothing refuses", async () => {
    for (const answer of [ended(2, ""), ended(0, ""), parentListing("keys")]) {
      const { seams, said, sent } = seamsFor({
        ...happyAnswers(),
        [PARENT_LIST_COMMAND]: answer,
      });
      expect(await execute(seams)).toBe(REFUSED);
      expect(label(said, "volume_readable_before")).toBe("false");
      expect(sent).not.toContain(RECYCLE_COMMAND);
    }
  });

  test("an unreadable legacy root refuses - the control needs a baseline", async () => {
    const said = await refuses({
      ...happyAnswers(),
      [LEGACY_RUNS_COMMAND]: ended(2, ""),
    });
    expect(label(said, "legacy_runs_before")).toBe("unknown");
  });

  test("a record already mid-rebuild refuses", async () => {
    const said = await refuses({
      ...happyAnswers(),
      [LIST_RUNS_COMMAND]: ended(0, `${OTHER_RUN}.json\n`),
      [stateFieldCommand(OTHER_RUN)]: ended(0, "1\n"),
      [pendingCommand(OTHER_RUN)]: ended(0, "1\n"),
    });
    expect(label(said, "pending_rebuilds_before")).toBe("1");
  });

  test("a record whose state cannot be read refuses", async () => {
    const said = await refuses({
      ...happyAnswers(),
      [LIST_RUNS_COMMAND]: ended(0, `${OTHER_RUN}.json\n`),
      [stateFieldCommand(OTHER_RUN)]: ended(2, ""),
    });
    expect(label(said, "pending_rebuilds_before")).toBe("unknown");
  });

  // The next two are what the two-call form is FOR. In both, call two answers
  // definitely - "not pending" - and only call one knows the file is not the
  // shape a state read may be taken from. A ladder that asked the pending
  // question alone would rebuild on the strength of that answer.
  test("a record holding two state fields refuses, however call two answers", async () => {
    const said = await refuses({
      ...happyAnswers(),
      [LIST_RUNS_COMMAND]: ended(0, `${OTHER_RUN}.json\n`),
      [stateFieldCommand(OTHER_RUN)]: ended(0, "2\n"),
      [pendingCommand(OTHER_RUN)]: ended(1, "0\n"),
      [reachableCommand(OTHER_RUN)]: ended(0, "1\n"),
    });
    expect(label(said, "pending_rebuilds_before")).toBe("unknown");
  });

  test("a record holding no state field refuses, however call two answers", async () => {
    const said = await refuses({
      ...happyAnswers(),
      [LIST_RUNS_COMMAND]: ended(0, `${OTHER_RUN}.json\n`),
      [stateFieldCommand(OTHER_RUN)]: ended(1, "0\n"),
      [pendingCommand(OTHER_RUN)]: ended(1, "0\n"),
      [reachableCommand(OTHER_RUN)]: ended(1, "0\n"),
    });
    expect(label(said, "pending_rebuilds_before")).toBe("unknown");
  });
});

describe("execute: an unproved post-state is ambiguous, never accepted", () => {
  const ambiguous = async (
    answers: Record<string, BoundedResult | BoundedResult[]>,
  ) => {
    const { seams, said, sent } = seamsFor(answers);
    expect(await execute(seams)).toBe(AMBIGUOUS);
    expect(label(said, "recycle_accepted") ?? "false").toBe("false");
    expect(label(said, "next_action")).toBe("verify");
    expect(sent.filter((c) => c === RECYCLE_COMMAND).length).toBe(1);
    return said;
  };

  test("a rebuild that timed out is ambiguous and is not retried", async () => {
    const said = await ambiguous({
      ...happyAnswers(),
      [RECYCLE_COMMAND]: TIMED_OUT,
      [LIST_RUNS_COMMAND]: [ended(0, ""), ended(0, `${RUN}.json\n`)],
    });
    expect(label(said, "recycle_clean")).toBe("false");
    expect(label(said, "run_id")).toBe("unknown");
  });

  test("a rebuild whose group survived is ambiguous", async () => {
    await ambiguous({ ...happyAnswers(), [RECYCLE_COMMAND]: GROUP_ALIVE });
  });

  test("a spawn that threw is ambiguous, not a refusal", async () => {
    const answers = happyAnswers();
    const inner = fakeConsole(answers);
    const said: string[] = [];
    const seams: Seams = {
      health: async () => true,
      run: (command) => {
        if (command === RECYCLE_COMMAND) throw new Error("flyctl is not here");
        return inner.run(command);
      },
      say: (line) => said.push(line),
    };
    expect(await execute(seams)).toBe(AMBIGUOUS);
    expect(label(said, "recycle_threw")).toBe("true");
    expect(label(said, "next_action")).toBe("verify");
  });

  test("no new record after a clean rebuild is ambiguous", async () => {
    const said = await ambiguous({
      ...happyAnswers(),
      [LIST_RUNS_COMMAND]: ended(0, ""),
    });
    expect(label(said, "runs_added")).toBe("0");
  });

  test("a new record that is not the child's is ambiguous", async () => {
    const said = await ambiguous({
      ...happyAnswers(),
      [LIST_RUNS_COMMAND]: [ended(0, ""), ended(0, `${OTHER_RUN}.json\n`)],
      [stateFieldCommand(OTHER_RUN)]: ended(0, "1\n"),
      [pendingCommand(OTHER_RUN)]: ended(1, "0\n"),
    });
    expect(label(said, "delta_matches_child")).toBe("false");
  });

  test("a record that is not reachable afterwards is ambiguous", async () => {
    const said = await ambiguous({
      ...happyAnswers(),
      [reachableCommand(RUN)]: ended(1, "0\n"),
    });
    expect(label(said, "run_state_reachable")).toBe("false");
  });

  test("a cancel date that moved is ambiguous", async () => {
    const said = await ambiguous({
      ...happyAnswers(),
      [ACCOUNT_COMMAND]: [
        ended(0, GOOD_ACCOUNT),
        ended(
          0,
          GOOD_ACCOUNT.replace("cancel_date: 2026-08-29", "cancel_date: none"),
        ),
      ],
    });
    expect(label(said, "cancel_date_unchanged")).toBe("false");
  });

  // Q5(b): the post-state asks about EVERY record, not only the new one. Here
  // the rebuild itself went perfectly - one new reachable record, the account
  // unchanged - and another record on the volume went mid-rebuild while this ran.
  test("a pending rebuild anywhere on the volume afterwards is ambiguous", async () => {
    const said = await ambiguous({
      ...happyAnswers(),
      [LIST_RUNS_COMMAND]: [
        ended(0, `${OTHER_RUN}.json\n`),
        ended(0, `${OTHER_RUN}.json\n${RUN}.json\n`),
      ],
      [stateFieldCommand(OTHER_RUN)]: ended(0, "1\n"),
      [pendingCommand(OTHER_RUN)]: [ended(1, "0\n"), ended(0, "1\n")],
      [reachableCommand(OTHER_RUN)]: ended(1, "0\n"),
    });
    expect(label(said, "runs_added")).toBe("1");
    expect(label(said, "delta_matches_child")).toBe("true");
    expect(label(said, "pending_rebuilds_after")).toBe("1");
    expect(label(said, "run_state_reachable")).toBe("true");
  });

  test("a record that cannot be read afterwards is ambiguous, not zero pending", async () => {
    const said = await ambiguous({
      ...happyAnswers(),
      [LIST_RUNS_COMMAND]: [
        ended(0, `${OTHER_RUN}.json\n`),
        ended(0, `${OTHER_RUN}.json\n${RUN}.json\n`),
      ],
      [stateFieldCommand(OTHER_RUN)]: [ended(0, "1\n"), ended(2, "")],
      [pendingCommand(OTHER_RUN)]: ended(1, "0\n"),
      [reachableCommand(OTHER_RUN)]: ended(1, "0\n"),
    });
    expect(label(said, "pending_rebuilds_after")).toBe("unknown");
  });

  // Audit unity and durability, promoted to an acceptance property: the pinned
  // run's rows must be on the VOLUME, because the account of what happened to
  // the box cannot live in two places (reviewer ruling).
  test("a volume without the audit log afterwards is ambiguous", async () => {
    const said = await ambiguous({
      ...happyAnswers(),
      [PARENT_LIST_COMMAND]: [
        parentListing(MARKER, "keys"),
        parentListing(MARKER, "keys", "runs"),
      ],
    });
    expect(label(said, "volume_audit_after")).toBe("false");
    expect(label(said, "volume_runs_after")).toBe("true");
  });

  test("a volume without the keys directory afterwards is ambiguous", async () => {
    const said = await ambiguous({
      ...happyAnswers(),
      [PARENT_LIST_COMMAND]: [
        parentListing(MARKER, "keys"),
        parentListing(MARKER, "runs", "audit.jsonl"),
      ],
    });
    expect(label(said, "volume_keys_after")).toBe("false");
  });

  test("a post-state volume read that establishes nothing is ambiguous", async () => {
    const said = await ambiguous({
      ...happyAnswers(),
      [PARENT_LIST_COMMAND]: [parentListing(MARKER, "keys"), ended(2, "")],
    });
    expect(label(said, "volume_readable_after")).toBe("false");
  });

  // The negative control: a record landing in the OLD place is the defect
  // reappearing, and it is not an acceptance even when everything else holds.
  test("a record appearing in the legacy root is ambiguous", async () => {
    const said = await ambiguous({
      ...happyAnswers(),
      [LEGACY_RUNS_COMMAND]: [
        ended(0, `${LEGACY_RUN}.json\n`),
        ended(0, `${LEGACY_RUN}.json\n${RUN}.json\n`),
      ],
    });
    expect(label(said, "legacy_runs_before")).toBe("1");
    expect(label(said, "legacy_runs_after")).toBe("2");
    expect(label(said, "legacy_runs_added")).toBe("1");
  });

  test("an unreadable legacy root afterwards is ambiguous", async () => {
    const said = await ambiguous({
      ...happyAnswers(),
      [LEGACY_RUNS_COMMAND]: [ended(0, `${LEGACY_RUN}.json\n`), ended(2, "")],
    });
    expect(label(said, "legacy_runs_added")).toBe("unknown");
  });

  test("a post-state account read that fails is ambiguous", async () => {
    await ambiguous({
      ...happyAnswers(),
      [ACCOUNT_COMMAND]: [ended(0, GOOD_ACCOUNT), GROUP_ALIVE],
    });
  });
});

describe("verify and connect: reading, and the one recovery", () => {
  test("verify reports a reachable record and asks for nothing", async () => {
    const { seams, said } = seamsFor({
      [LIST_RUNS_COMMAND]: ended(0, `${RUN}.json\n`),
      [ACCOUNT_COMMAND]: ended(0, GOOD_ACCOUNT),
      [stateFieldCommand(RUN)]: ended(0, "1\n"),
      [pendingCommand(RUN)]: ended(1, "0\n"),
      [reachableCommand(RUN)]: ended(0, "1\n"),
    });
    expect(await verify(seams, RUN)).toBe(ACCEPTED);
    expect(label(said, "run_state")).toBe("reachable");
    expect(label(said, "next_action")).toBe("none");
  });

  test("verify reports a mid-rebuild record and points at connect", async () => {
    const { seams, said, sent } = seamsFor({
      [LIST_RUNS_COMMAND]: ended(0, `${RUN}.json\n`),
      [ACCOUNT_COMMAND]: ended(0, GOOD_ACCOUNT),
      [stateFieldCommand(RUN)]: ended(0, "1\n"),
      [pendingCommand(RUN)]: ended(0, "1\n"),
    });
    expect(await verify(seams, RUN)).toBe(AMBIGUOUS);
    expect(label(said, "run_state")).toBe("reinstall_requested");
    expect(label(said, "next_action")).toBe("connect");
    // Reading only: no rebuild, no wait, no provider mutation.
    expect(sent).not.toContain(RECYCLE_COMMAND);
    expect(sent).not.toContain(connectCommand(RUN));
  });

  test("verify refuses when the record is absent", async () => {
    const { seams, said } = seamsFor({
      [LIST_RUNS_COMMAND]: ended(0, ""),
      [ACCOUNT_COMMAND]: ended(0, GOOD_ACCOUNT),
    });
    expect(await verify(seams, RUN)).toBe(REFUSED);
    expect(label(said, "run_present")).toBe("false");
  });

  test("connect waits only on a record that is mid-rebuild", async () => {
    const { seams, said, sent } = seamsFor({
      [stateFieldCommand(RUN)]: ended(0, "1\n"),
      [pendingCommand(RUN)]: [ended(0, "1\n"), ended(1, "0\n")],
      [reachableCommand(RUN)]: ended(0, "1\n"),
      [connectCommand(RUN)]: ended(0, "reachable after 42s"),
    });
    expect(await connect(seams, RUN)).toBe(ACCEPTED);
    expect(label(said, "run_state_after")).toBe("reachable");
    expect(sent).toContain(connectCommand(RUN));
    expect(sent).not.toContain(RECYCLE_COMMAND);
  });

  test("connect refuses a record that is already reachable", async () => {
    const { seams, said, sent } = seamsFor({
      [stateFieldCommand(RUN)]: ended(0, "1\n"),
      [pendingCommand(RUN)]: ended(1, "0\n"),
      [reachableCommand(RUN)]: ended(0, "1\n"),
    });
    expect(await connect(seams, RUN)).toBe(REFUSED);
    expect(label(said, "connect_spawned")).toBe("false");
    expect(sent).not.toContain(connectCommand(RUN));
  });

  test("connect never rebuilds, even when its own wait fails", async () => {
    const { seams, said, sent } = seamsFor({
      [stateFieldCommand(RUN)]: ended(0, "1\n"),
      [pendingCommand(RUN)]: ended(0, "1\n"),
      [connectCommand(RUN)]: TIMED_OUT,
    });
    expect(await connect(seams, RUN)).toBe(AMBIGUOUS);
    expect(label(said, "next_action")).toBe("verify");
    expect(sent).not.toContain(RECYCLE_COMMAND);
  });
});

describe("state: a read-only inventory", () => {
  test("prints every record's state and mutates nothing", async () => {
    const { seams, said, sent } = seamsFor({
      [LIST_RUNS_COMMAND]: ended(0, `${RUN}.json\n${OTHER_RUN}.json\n`),
      [ACCOUNT_COMMAND]: ended(0, GOOD_ACCOUNT),
      [stateFieldCommand(RUN)]: ended(0, "1\n"),
      [pendingCommand(RUN)]: ended(1, "0\n"),
      [reachableCommand(RUN)]: ended(0, "1\n"),
      [stateFieldCommand(OTHER_RUN)]: ended(0, "1\n"),
      [pendingCommand(OTHER_RUN)]: ended(0, "1\n"),
    });
    expect(await state(seams)).toBe(ACCEPTED);
    expect(said).toContain(`run_state ${RUN}: reachable`);
    expect(said).toContain(`run_state ${OTHER_RUN}: reinstall_requested`);
    expect(sent).not.toContain(RECYCLE_COMMAND);
    expect(sent).not.toContain(connectCommand(RUN));
  });

  test("an unreadable runs directory is reported, not passed", async () => {
    const { seams, said } = seamsFor({
      [LIST_RUNS_COMMAND]: ended(2, ""),
      [PARENT_LIST_COMMAND]: ended(2, ""),
      [ACCOUNT_COMMAND]: ended(0, GOOD_ACCOUNT),
    });
    expect(await state(seams)).toBe(REFUSED);
    expect(label(said, "runs_listing")).toBe("unreadable");
    expect(label(said, "runs_parent")).toBe("unreadable");
    expect(label(said, "runs_dir_present")).toBe("unknown");
  });

  test("a virgin volume reads as zero records and reaches the account", async () => {
    const { seams, said, sent } = seamsFor({
      [LIST_RUNS_COMMAND]: ended(2, ""),
      [PARENT_LIST_COMMAND]: parentListing(MARKER),
      [ACCOUNT_COMMAND]: ended(0, GOOD_ACCOUNT),
    });
    expect(await state(seams)).toBe(ACCEPTED);
    expect(label(said, "runs_dir_present")).toBe("false");
    expect(label(said, "runs")).toBe("0");
    expect(label(said, "other_instances")).toBe("1");
    expect(label(said, "cancel_scheduled")).toBe("true");
    expect(said.some((l) => l.startsWith("run_state "))).toBe(false);
    expect(sent).not.toContain(RECYCLE_COMMAND);
  });
});
