// What the coordinator is allowed to conclude from a probe child.
//
// Two properties, and the second is the one that makes the first worth having:
//
//   1. an honest transcript parses into typed fields and its verdict is
//      RECOMPUTED from them, so a child cannot be believed about itself;
//   2. every way a transcript can be wrong - short, doubled, mistyped,
//      self-contradicting, or from a program this coordinator has not read - is
//      a HARD failure, not a retry and not a pass.
//
// The transcripts here come from the shared fixture, which derives its verdict
// lines the way the probe does. A case that wants a DISHONEST transcript edits
// one line of an honest one, so what is being tested is visible in the test.

import { describe, expect, test } from "bun:test";
import {
  PROBE_DEFECTS,
  classifyProbeRun,
  derivedAcceptance,
  isReadinessPending,
  parseProbeTranscript,
} from "./probe-transcript.ts";
import {
  notTickingYet,
  probeTranscript,
  probeTranscriptLines,
} from "../testing/probe-fixture.ts";

/** An honest transcript with one line replaced, which is the only way a case
 * here produces a contradiction. */
function edited(
  replacements: Record<string, string>,
  health: Parameters<typeof probeTranscriptLines>[0] = {},
): string {
  const lines = probeTranscriptLines(health).map((line) => {
    const name = line.trim().split(":")[0];
    return name in replacements ? replacements[name] : line;
  });
  return `${lines.join("\n")}\n`;
}

/** A clean run of the child, so a case varies only what it printed. */
const ran = (code: number | null, stdout: string) => ({
  code,
  timedOut: false,
  groupSurvived: false,
  groupEmpty: true,
  stdout,
});

describe("an honest transcript parses and is recomputed", () => {
  test("every field comes back typed", () => {
    const parsed = parseProbeTranscript(probeTranscript().stdout);
    expect(parsed.defects).toEqual([]);
    expect(parsed.ok).toBe(true);
    const f = parsed.fields!;
    expect(f.statuses.invite_with_credential).toBe(404);
    expect(f.counts.health_unexpected_fields).toBe(0);
    expect(f.health.tick_recent).toBe(true);
    expect(f.booleans.accepted).toBe(true);
    expect(derivedAcceptance(f)).toBe(true);
  });

  test("order is not required, completeness is", () => {
    const shuffled = probeTranscriptLines().reverse().join("\n");
    expect(parseProbeTranscript(shuffled).ok).toBe(true);
  });
});

describe("a transcript that is not one refuses", () => {
  test("the lone verdict line - the whole of the old check - is not a transcript", () => {
    const parsed = parseProbeTranscript("accepted: true\n");
    expect(parsed.ok).toBe(false);
    expect(parsed.fields).toBe(null);
    expect(parsed.defects).toContain("missing_field:bearer_enforced");
  });

  test("a truncated run is missing fields", () => {
    const short = probeTranscriptLines().slice(0, 8).join("\n");
    expect(parseProbeTranscript(short).ok).toBe(false);
  });

  test("a field printed twice is a defect whether or not the two agree", () => {
    for (const second of ["accepted: true", "accepted: false"]) {
      const doubled = `${probeTranscript().stdout}${second}\n`;
      const parsed = parseProbeTranscript(doubled);
      expect(parsed.ok).toBe(false);
      expect(parsed.defects).toContain(PROBE_DEFECTS.duplicateField);
    }
  });

  test("a field this coordinator does not know refuses", () => {
    const extra = `${probeTranscript().stdout}invite_url: https://x/i/secret\n`;
    const parsed = parseProbeTranscript(extra);
    expect(parsed.ok).toBe(false);
    expect(parsed.defects).toContain(PROBE_DEFECTS.unknownField);
  });

  test("a line that is not a field at all refuses", () => {
    const noise = `${probeTranscript().stdout}Traceback (most recent call)\n`;
    expect(parseProbeTranscript(noise).defects).toContain(
      PROBE_DEFECTS.unparseableLine,
    );
  });

  test("a value of the wrong kind refuses, per field", () => {
    expect(
      parseProbeTranscript(edited({ accepted: "accepted: yes" })).defects,
    ).toContain(`${PROBE_DEFECTS.notABoolean}:accepted`);
    // What the probe prints when the surface omitted a health key.
    expect(
      parseProbeTranscript(edited({ tick_recent: "  tick_recent: MISSING" }))
        .defects,
    ).toContain(`${PROBE_DEFECTS.notABoolean}:tick_recent`);
    expect(
      parseProbeTranscript(
        edited({ invite_with_credential: "invite_with_credential: ok" }),
      ).defects,
    ).toContain(`${PROBE_DEFECTS.notAStatus}:invite_with_credential`);
    expect(
      parseProbeTranscript(
        edited({ health_missing_fields: "health_missing_fields: -1" }),
      ).defects,
    ).toContain(`${PROBE_DEFECTS.notACount}:health_missing_fields`);
  });
});

/**
 * The half a substring search cannot do at all: the child's own readings are
 * re-added up, and a verdict that does not follow from them is a stop.
 */
describe("a verdict that does not follow from the readings refuses", () => {
  test("acceptance claimed while a gating boolean is false", () => {
    const lying = edited(
      {
        accepted: "accepted: true",
        health_gating_all_true: "health_gating_all_true: true",
      },
      { tick_recent: false, ok: false },
    );
    expect(parseProbeTranscript(lying).defects).toContain(PROBE_DEFECTS.gating);
  });

  test("acceptance claimed while the fields say otherwise", () => {
    const lying = edited(
      { accepted: "accepted: true" },
      { tick_recent: false, ok: false },
    );
    expect(parseProbeTranscript(lying).defects).toContain(
      PROBE_DEFECTS.accepted,
    );
  });

  test("bearer enforcement claimed while an anonymous call was answered", () => {
    const lying = edited({
      invite_without_credential: "invite_without_credential: 200",
    });
    expect(parseProbeTranscript(lying).defects).toContain(PROBE_DEFECTS.bearer);
  });

  test("the forbidden answer claimed on a status that is not 404", () => {
    const lying = edited({
      invite_with_credential: "invite_with_credential: 500",
    });
    const defects = parseProbeTranscript(lying).defects;
    expect(defects).toContain(PROBE_DEFECTS.forbidden);
  });

  test("a surface claimed answering while health did not", () => {
    const lying = edited({
      health_with_credential: "health_with_credential: 503",
    });
    expect(parseProbeTranscript(lying).defects).toContain(
      PROBE_DEFECTS.surface,
    );
  });

  test("a shape claimed exact while a field was unexpected", () => {
    const lying = edited({
      health_unexpected_fields: "health_unexpected_fields: 1",
    });
    expect(parseProbeTranscript(lying).defects).toContain(PROBE_DEFECTS.shape);
  });

  test("counts that cannot be true of six parsed booleans", () => {
    const lying = edited({
      health_missing_fields: "health_missing_fields: 2",
      health_shape_ok: "health_shape_ok: false",
    });
    expect(parseProbeTranscript(lying).defects).toContain(PROBE_DEFECTS.counts);
  });

  test("a mint-file claim the probe would have stopped on", () => {
    const lying = edited({ mint_file_mode_600: "mint_file_mode_600: false" });
    expect(parseProbeTranscript(lying).defects).toContain(
      PROBE_DEFECTS.mintFile,
    );
  });
});

describe("nothing the child printed comes back out", () => {
  test("a defect never carries the child's own text", () => {
    const secret = "https://cp1.test.isomux.app/i/seamsecret";
    const parsed = parseProbeTranscript(
      `${probeTranscript().stdout}invite_url: ${secret}\n${secret}\n`,
    );
    expect(parsed.ok).toBe(false);
    for (const defect of parsed.defects) {
      expect(defect).not.toContain(secret);
      expect(defect).not.toContain("invite_url");
    }
  });
});

describe("what a run amounts to", () => {
  test("a clean exit-zero run carrying acceptance is accepted", () => {
    const green = probeTranscript();
    expect(classifyProbeRun(ran(green.code, green.stdout))).toEqual({
      verdict: "accepted",
      defects: [],
    });
  });

  test("a machine that is up and not yet ticking is pending", () => {
    const pending = notTickingYet();
    expect(pending.code).toBe(1);
    expect(classifyProbeRun(ran(pending.code, pending.stdout))).toEqual({
      verdict: "readiness_pending",
      defects: [],
    });
  });

  test("state_persisted does not decide anything", () => {
    for (const persisted of [true, false]) {
      const t = probeTranscript({
        tick_recent: false,
        ok: false,
        state_persisted: persisted,
      });
      expect(classifyProbeRun(ran(t.code, t.stdout)).verdict).toBe(
        "readiness_pending",
      );
    }
  });

  // PENDING IS NARROW. Each of these is a deployment that is wrong rather than
  // slow, and waiting three minutes before rolling back would only delay the
  // rollback.
  //
  // EACH ONE ALSO CARRIES `tick_recent: false`, and that is deliberate: a
  // machine that has just been replaced has not ticked yet WHATEVER else is
  // wrong with it, so the realistic broken reading is both. It is also the only
  // version of these cases that tests anything - with `tick_recent` true they
  // would be refused by that clause alone, and a predicate that had stopped
  // checking the database would go on passing them.
  const notPending: [string, Parameters<typeof probeTranscript>[0]][] = [
    [
      "a database it cannot reach",
      { database_reachable: false, tick_recent: false, ok: false },
    ],
    [
      "a branch it cannot prove",
      { branch_pinned: false, tick_recent: false, ok: false },
    ],
    [
      "bounds it does not carry",
      { bounds_governed: false, tick_recent: false, ok: false },
    ],
  ];
  for (const [name, health] of notPending) {
    test(`${name} is hard, not pending`, () => {
      const t = probeTranscript(health);
      const outcome = classifyProbeRun(ran(t.code, t.stdout));
      expect(outcome.verdict).toBe("hard");
      expect(outcome.defects).toContain(PROBE_DEFECTS.notPending);
    });
  }

  // A MACHINE CONTRADICTING ITSELF. `ok` is the conjunction that includes
  // `tick_recent`, so `ok: true` alongside `tick_recent: false` is not a state
  // this build's health reporter can produce.
  test("ok true while tick_recent is false is hard", () => {
    const lying = edited(
      { health_gating_all_true: "health_gating_all_true: false" },
      { tick_recent: false, ok: true },
    );
    const outcome = classifyProbeRun(ran(1, lying));
    expect(outcome.verdict).toBe("hard");
  });

  test("an exit-zero child that did not accept is hard", () => {
    const pending = notTickingYet();
    const outcome = classifyProbeRun(ran(0, pending.stdout));
    expect(outcome.verdict).toBe("hard");
    expect(outcome.defects).toContain(PROBE_DEFECTS.exitZeroNotAccepted);
  });

  test("an exit code this program does not issue is hard", () => {
    // Exit 2 is the probe's own credential-file refusal, and its transcript is
    // four lines: neither the code nor the output may be read as a state.
    const green = probeTranscript();
    expect(classifyProbeRun(ran(2, green.stdout)).defects).toContain(
      PROBE_DEFECTS.unexpectedExit,
    );
  });

  // AN UNCLEAN RUN IS NOT PARSED AT ALL. Its output is a fragment by
  // definition, so a transcript that happens to look complete proves nothing
  // about a child that was killed or whose group outlived it.
  test("an unclean run is hard whatever it printed", () => {
    const green = probeTranscript();
    const cases: [string, Parameters<typeof classifyProbeRun>[0]][] = [
      [PROBE_DEFECTS.timedOut, { ...ran(null, green.stdout), timedOut: true }],
      [
        PROBE_DEFECTS.groupSurvived,
        { ...ran(0, green.stdout), groupSurvived: true },
      ],
      [
        PROBE_DEFECTS.groupNotEmpty,
        { ...ran(0, green.stdout), groupEmpty: false },
      ],
      [PROBE_DEFECTS.uncleanExit, ran(null, green.stdout)],
    ];
    for (const [defect, run] of cases) {
      const outcome = classifyProbeRun(run);
      expect(outcome.verdict).toBe("hard");
      expect(outcome.defects).toContain(defect);
    }
  });

  test("the pending predicate is not reachable from a broken transcript", () => {
    const parsed = parseProbeTranscript("accepted: false\n");
    expect(parsed.fields).toBe(null);
    // The predicate is only ever asked of typed fields, which is what makes
    // "complete and valid" a precondition of pending rather than a hope.
    const pending = parseProbeTranscript(notTickingYet().stdout).fields!;
    expect(isReadinessPending(pending)).toBe(true);
  });
});
