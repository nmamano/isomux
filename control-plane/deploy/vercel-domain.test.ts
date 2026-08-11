// The rollback lever, canary-tested BEFORE the thing it rolls back exists.

import { describe, expect, test } from "bun:test";
import {
  TARGET_DOMAIN,
  detachRequest,
  recordSet,
  TARGET_LABEL,
  attachHeld,
  challengeFrom,
  detachHeld,
  isAutoDomain,
  judgeDomains,
  mayDetach,
  recordFrom,
  renderRecord,
} from "./vercel-domain.ts";

const AUTO = { name: "isomux-control-plane.vercel.app", verified: true };
const TARGET = { name: TARGET_DOMAIN, verified: true };
/** The landing page's own hostname. Nothing here may ever remove it. */
const LANDING = { name: "isomux.com", verified: true };

describe("which hostname may be detached", () => {
  test("ONLY THE ONE THIS SLICE ATTACHED", () => {
    expect(mayDetach(TARGET_DOMAIN)).toBe(true);
    for (const name of [
      "isomux.com",
      "www.isomux.com",
      "isomux-control-plane.vercel.app",
      "cloud.isomux.com.evil.test",
      "",
      "*.isomux.com",
    ]) {
      expect({ name, may: mayDetach(name) }).toEqual({ name, may: false });
    }
  });

  test("the project's generated hostname is recognised and protected", () => {
    expect(isAutoDomain(AUTO.name)).toBe(true);
    expect(isAutoDomain(TARGET_DOMAIN)).toBe(false);
  });
});

describe("did the attach or the detach do exactly one thing", () => {
  test("attached: ours present, the generated one untouched, nothing else", () => {
    const verdict = judgeDomains([AUTO, TARGET]);
    expect(attachHeld(verdict)).toBe(true);
    expect(verdict.otherDomainsAdded).toBe(0);
  });

  test("A DETACH THAT REMOVED THE WRONG RECORD IS CAUGHT", () => {
    // Ours is gone, which alone looks like success - and the generated domain
    // went with it. That is the failure this second half exists for.
    const verdict = judgeDomains([]);
    expect(verdict.targetPresent).toBe(false);
    expect(detachHeld(verdict)).toBe(false);
  });

  test("detached cleanly", () => {
    expect(detachHeld(judgeDomains([AUTO]))).toBe(true);
  });

  test("a domain nobody asked for fails both verdicts", () => {
    const verdict = judgeDomains([AUTO, TARGET, LANDING]);
    expect(verdict.otherDomainsAdded).toBe(1);
    expect(attachHeld(verdict)).toBe(false);
    expect(detachHeld(judgeDomains([AUTO, LANDING]))).toBe(false);
  });
});

describe("the record handed to a human", () => {
  test("a per-project CNAME target is accepted and rendered", () => {
    const record = recordFrom({
      recommendedCNAME: "d1d4fc829fe7bc7c.vercel-dns-017.com",
    });
    expect(record).toEqual({
      type: "CNAME",
      name: TARGET_LABEL,
      value: "d1d4fc829fe7bc7c.vercel-dns-017.com",
    });
    expect(renderRecord(record!)).toBe(
      "CNAME  cloud  d1d4fc829fe7bc7c.vercel-dns-017.com",
    );
  });

  test("the array form the API sometimes uses is accepted", () => {
    expect(
      recordFrom({ recommendedCNAME: ["abc123.vercel-dns.com"] })?.value,
    ).toBe("abc123.vercel-dns.com");
  });

  test("THE SHAPE THE LIVE API ACTUALLY ANSWERS WITH", () => {
    // Verbatim from `/v6/domains/cloud.isomux.com/config`, measured
    // 2026-08-11: ranked objects, and a root dot on the value. The first
    // attach was rolled back because neither was accepted here.
    const record = recordFrom({
      recommendedCNAME: [{ rank: 1, value: "cname.vercel-dns.com." }],
    });
    expect(record).toEqual({
      type: "CNAME",
      name: TARGET_LABEL,
      value: "cname.vercel-dns.com",
    });
    expect(renderRecord(record!)).toBe("CNAME  cloud  cname.vercel-dns.com");
  });

  test("the root dot goes in the plain string form too, and only one of them", () => {
    expect(
      recordFrom({ recommendedCNAME: "d1d4fc829fe7bc7c.vercel-dns-017.com." })
        ?.value,
    ).toBe("d1d4fc829fe7bc7c.vercel-dns-017.com");
    // A doubled dot is malformed, not something to tidy into a valid name.
    expect(
      recordFrom({ recommendedCNAME: "cname.vercel-dns.com.." }),
    ).toBeNull();
  });

  test("a per-project target arrives in the ranked form as well", () => {
    expect(
      recordFrom({
        recommendedCNAME: [
          { rank: 1, value: "d1d4fc829fe7bc7c.vercel-dns-017.com" },
        ],
      })?.value,
    ).toBe("d1d4fc829fe7bc7c.vercel-dns-017.com");
  });

  test("TOP-RANKED IS THE LOWEST NUMBER, and a rank-2 answer is still an answer", () => {
    // Ruling R-2026-08-11-3 as clarified: rank 1 beats rank 2.
    expect(
      recordFrom({
        recommendedCNAME: [
          { rank: 2, value: "second.vercel-dns.com." },
          { rank: 1, value: "first.vercel-dns.com." },
        ],
      })?.value,
    ).toBe("first.vercel-dns.com");
    // The LOWEST PRESENT rank, not the literal 1. This is an ordering, not a
    // requirement that rank 1 exist, so ranks 2 and 3 make rank 2 the winner.
    expect(
      recordFrom({
        recommendedCNAME: [
          { rank: 3, value: "third.vercel-dns.com." },
          { rank: 2, value: "second.vercel-dns.com." },
        ],
      })?.value,
    ).toBe("second.vercel-dns.com");
    expect(
      recordFrom({
        recommendedCNAME: [{ rank: 2, value: "only.vercel-dns.com." }],
      })?.value,
    ).toBe("only.vercel-dns.com");
  });

  test("AN AMBIGUOUS WINNING RANK IS NOT AN ANSWER", () => {
    // Two different names tied at the top: nothing here decides which one a
    // human types into a registrar.
    expect(
      recordFrom({
        recommendedCNAME: [
          { rank: 1, value: "a.vercel-dns.com." },
          { rank: 1, value: "b.vercel-dns.com." },
        ],
      }),
    ).toBeNull();
    // The same name twice is not ambiguity - and the tie is judged AFTER the
    // root dot goes, so these two are one answer rather than two.
    expect(
      recordFrom({
        recommendedCNAME: [
          { rank: 1, value: "same.vercel-dns.com." },
          { rank: 1, value: "same.vercel-dns.com" },
        ],
      })?.value,
    ).toBe("same.vercel-dns.com");
    // A tie below the winning rank changes nothing.
    expect(
      recordFrom({
        recommendedCNAME: [
          { rank: 1, value: "winner.vercel-dns.com." },
          { rank: 2, value: "a.vercel-dns.com." },
          { rank: 2, value: "b.vercel-dns.com." },
        ],
      })?.value,
    ).toBe("winner.vercel-dns.com");
    // Two string entries that disagree, in the older shape. The pre-fix code
    // silently took element 0.
    expect(
      recordFrom({
        recommendedCNAME: ["a.vercel-dns.com", "b.vercel-dns.com"],
      }),
    ).toBeNull();
    expect(
      recordFrom({
        recommendedCNAME: ["same.vercel-dns.com.", "same.vercel-dns.com"],
      })?.value,
    ).toBe("same.vercel-dns.com");
  });

  test("THE WINNER IS NEVER SKIPPED IN FAVOUR OF A LOWER-RANKED VALID NAME", () => {
    // Vercel's own top answer fails the closed set. Handing over the runner-up
    // would be this module inventing a record.
    expect(
      recordFrom({
        recommendedCNAME: [
          { rank: 1, value: "not-a-vercel-target.example.com." },
          { rank: 2, value: "fallback.vercel-dns.com." },
        ],
      }),
    ).toBeNull();
  });

  test("A MALFORMED ROW REFUSES THE WHOLE ANSWER", () => {
    // Not "drop that row and rank the rest". If one row is not the shape we
    // measured, the envelope is not the shape we measured either - so a
    // perfectly good row sitting beside a bad one does not get promoted.
    const VALID = { rank: 2, value: "usable.vercel-dns.com." };
    for (const recommendedCNAME of [
      [],
      [{ value: "cname.vercel-dns.com." }],
      [{ rank: "1", value: "cname.vercel-dns.com." }],
      [{ rank: Number.NaN, value: "cname.vercel-dns.com." }],
      // A rank that is not a whole number is not a rank we have measured.
      [{ rank: 1.5, value: "cname.vercel-dns.com." }],
      // The `recommendedIPv4` envelope: same ranked object, ARRAY inside
      // `value`. Measured alongside the CNAME on 2026-08-11.
      [{ rank: 1, value: ["76.76.21.21"] }],
      [{ rank: 1, value: ["76.76.21.21"] }, VALID],
      // A ranked object mixed with a bare string, a null, a nested array.
      ["cname.vercel-dns.com", { rank: 1, value: "cname.vercel-dns.com." }],
      [null, { rank: 1, value: "cname.vercel-dns.com." }],
      [[{ rank: 1, value: "cname.vercel-dns.com." }]],
    ]) {
      expect({
        recommendedCNAME,
        record: recordFrom({ recommendedCNAME }),
      }).toEqual({ recommendedCNAME, record: null });
    }
  });

  test("a lookalike is refused in the ranked form too", () => {
    expect(
      recordFrom({
        recommendedCNAME: [
          { rank: 1, value: "cname.vercel-dns.com.evil.test." },
        ],
      }),
    ).toBeNull();
    expect(
      recordFrom({ recommendedCNAME: [{ rank: 1, value: "" }] }),
    ).toBeNull();
  });

  test("NOTHING IS INVENTED WHEN VERCEL NAMES NO TARGET", () => {
    // Guessing `cname.vercel-dns.com` would produce a record that looks right,
    // gets typed into a registrar by a human, and does not work.
    expect(recordFrom({})).toBeNull();
    expect(recordFrom({ recommendedIPv4: "76.76.21.21" })).toBeNull();
    expect(recordFrom({ recommendedCNAME: "" })).toBeNull();
    expect(
      recordFrom({ recommendedCNAME: "not-a-vercel-target.example.com" }),
    ).toBeNull();
    expect(recordFrom({ recommendedCNAME: 7 })).toBeNull();
  });

  test("a TXT challenge is read, never invented", () => {
    expect(
      challengeFrom([
        {
          type: "TXT",
          domain: "_vercel.isomux.com",
          value: "vc-domain-verify=x",
        },
      ]),
    ).toEqual({
      type: "TXT",
      name: "_vercel.isomux.com",
      value: "vc-domain-verify=x",
    });
    expect(challengeFrom([])).toBeNull();
    expect(challengeFrom(null)).toBeNull();
    expect(
      challengeFrom([{ type: "CNAME", domain: "x", value: "y" }]),
    ).toBeNull();
  });
});

describe("the DELETE this phase may issue", () => {
  const PROVED = "prj_ours";

  test("it targets the constant hostname on the proved project, and encodes both", () => {
    const request = detachRequest(PROVED, PROVED);
    expect(request).toEqual({
      method: "DELETE",
      path: "/v9/projects/prj_ours/domains/cloud.isomux.com",
    });
  });

  test("IT CANNOT WANDER TO ANOTHER PROJECT, even with the right hostname", () => {
    expect(detachRequest("prj_landing", PROVED)).toBeNull();
    expect(detachRequest("", PROVED)).toBeNull();
    expect(detachRequest(PROVED, "")).toBeNull();
  });

  test("no hostname reaches it, so it can never select the generated one", () => {
    // The path is built from a constant. There is no argument for a name.
    const request = detachRequest(PROVED, PROVED)!;
    expect(request.path).toContain("cloud.isomux.com");
    expect(request.path).not.toContain(".vercel.app");
    expect(request.path).not.toContain("isomux.com/domains/isomux.com");
  });
});

describe("the closed record set handed to a human", () => {
  const CNAME = { recommendedCNAME: "d1d4fc829fe7bc7c.vercel-dns-017.com" };

  test("one CNAME alone is a complete answer", () => {
    const set = recordSet(CNAME, []);
    expect(set.ok).toBe(true);
    expect(set.records.length).toBe(1);
    expect(set.records[0].type).toBe("CNAME");
  });

  test("one CNAME plus the exact TXT challenge is also complete", () => {
    const set = recordSet(CNAME, [
      {
        type: "TXT",
        domain: "_vercel.isomux.com",
        value: "vc-domain-verify=x",
      },
    ]);
    expect(set.ok).toBe(true);
    expect(set.records.map((r) => r.type)).toEqual(["CNAME", "TXT"]);
  });

  test("NO CNAME MEANS STOP, whatever else came back", () => {
    expect(recordSet({}, []).ok).toBe(false);
    expect(
      recordSet({ recommendedCNAME: "cname.vercel-dns.com.evil.test" }, []).ok,
    ).toBe(false);
  });

  test("the measured live config yields exactly one record", () => {
    // The whole answer as `/v6/domains/cloud.isomux.com/config` gave it on
    // 2026-08-11, challenges included: one CNAME, no TXT, no conflict.
    const live = {
      recommendedCNAME: [{ rank: 1, value: "cname.vercel-dns.com." }],
      recommendedIPv4: [{ rank: 1, value: ["76.76.21.21"] }],
      conflicts: [],
      acceptedChallenges: [],
    };
    const set = recordSet(live, live.acceptedChallenges);
    expect(set.ok).toBe(true);
    expect(set.conflicts).toBe(0);
    expect(set.records.map(renderRecord)).toEqual([
      "CNAME  cloud  cname.vercel-dns.com",
    ]);
  });

  test("A CONFLICTING RECORD ALREADY IN THE ZONE MEANS STOP", () => {
    // Never tell a human to overwrite something we did not put there.
    const set = recordSet(
      { ...CNAME, conflicts: [{ type: "A", name: "cloud" }] },
      [],
    );
    expect(set.conflicts).toBe(1);
    expect(set.ok).toBe(false);
  });
});
