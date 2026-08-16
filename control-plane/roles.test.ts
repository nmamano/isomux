// The connection posture, as properties rather than as prose.
//
// Two kinds of claim are checked here. The first is arithmetic: the worst case
// is the sum of the two engine-enforced DEPLOYED budgets and it has to fit
// under the ceiling that was actually measured, with a reserve left over. The second is
// the privilege boundary, and it is checked by its ABSENCES - a grant list is
// only least privilege if the things it leaves out stay left out, and a later
// edit that quietly adds `delete` or hands the web tier the create latch should
// fail here rather than in a review nobody ran.

import { describe, expect, test } from "bun:test";
import {
  ALL_VERBS,
  PRIOR_PROVISIONER_GRANTS,
  PROVISIONER_BUDGET,
  PROVISIONER_GRANTS,
  PROVISIONER_POOL,
  PROVISIONER_REACHABLE,
  PROVISIONER_ROLE,
  provisionerMatrixAgainstReachable,
  UNALLOCATED_RESERVE,
  USABLE_CEILING,
  WEB_BUDGET,
  WEB_GRANTS,
  WEB_ROLE,
  WORST_CASE_AGGREGATE,
  assertIdentifier,
  boundsAreExact,
  failedClaims,
  governanceStatements,
  governedRoleCount,
  judgeEffective,
  residueIsInert,
} from "./roles.ts";
import { GOVERNED_SETTINGS } from "./store.ts";

const BOUNDS = GOVERNED_SETTINGS;

describe("the aggregate is a number, and it fits", () => {
  test("the worst case is the sum of the two DEPLOYED budgets and nothing else", () => {
    expect(WORST_CASE_AGGREGATE).toBe(WEB_BUDGET + PROVISIONER_BUDGET);
  });

  test("it fits inside the usable ceiling with the reserve left over", () => {
    expect(WORST_CASE_AGGREGATE).toBeLessThan(USABLE_CEILING);
    expect(UNALLOCATED_RESERVE).toBe(USABLE_CEILING - WORST_CASE_AGGREGATE);
    expect(UNALLOCATED_RESERVE).toBeGreaterThan(0);
  });

  // The provisioner's budget is not a guess about how many machines exist: it
  // is sized so the ONE case that legitimately runs two of them - a redeploy,
  // where the old machine drains while the new one boots - stays inside it.
  test("two overlapping provisioner machines fit inside the provisioner budget", () => {
    expect(PROVISIONER_POOL.max * 2).toBeLessThan(PROVISIONER_BUDGET);
  });
});

describe("the grants are bounded by what the call graph needs", () => {
  const verbsFor = (
    grants: readonly { table: string; verbs: readonly string[] }[],
    table: string,
  ): readonly string[] => grants.find((g) => g.table === table)?.verbs ?? [];

  test("nothing may delete, because nothing in this build deletes", () => {
    for (const grants of [WEB_GRANTS, PROVISIONER_GRANTS]) {
      for (const grant of grants) expect(grant.verbs).not.toContain("delete");
    }
  });

  test("the web cannot reach the create latch at all", () => {
    expect(verbsFor(WEB_GRANTS, "create_intents")).toEqual([]);
  });

  test("the web may ask for work but not drive it", () => {
    expect(verbsFor(WEB_GRANTS, "operations")).toEqual(["select", "insert"]);
  });

  test("the web cannot read the billing event journal", () => {
    expect(verbsFor(WEB_GRANTS, "stripe_events")).toEqual([]);
  });

  test("subscription state is read-only where it is read at all", () => {
    expect(verbsFor(WEB_GRANTS, "subscriptions")).toEqual(["select"]);
    // The deployed command runs the lifecycle cadence, which reads but never
    // writes subscription projection state.
    expect(verbsFor(PROVISIONER_GRANTS, "subscriptions")).toEqual(["select"]);
  });

  test("the provisioner drives operations and holds the latch it can reach", () => {
    expect(verbsFor(PROVISIONER_GRANTS, "operations")).toContain("update");
    // SELECT and INSERT only: the intent UPDATE lives on the create path, and
    // the deployed command does not register the create_instance handler.
    expect(verbsFor(PROVISIONER_GRANTS, "create_intents")).toEqual([
      "select",
      "insert",
    ]);
  });

  test("the provisioner does not create instances or write reservations", () => {
    expect(verbsFor(PROVISIONER_GRANTS, "instances")).not.toContain("insert");
    const reservations = verbsFor(PROVISIONER_GRANTS, "name_reservations");
    expect(reservations).not.toContain("insert");
    expect(reservations).not.toContain("update");
  });

  // THE 2026-08-12 DEFECT, as a test. The G3 forward probe refused because the
  // authenticated seam call reads the reservation row to prove tenant ownership
  // before it may answer even `forbidden`, and the read was not granted. The
  // real invite path makes the same read, so D4's first genuine invite would
  // have failed identically.
  test("the provisioner may read the reservation the invite seam checks", () => {
    expect(verbsFor(PROVISIONER_GRANTS, "name_reservations")).toEqual([
      "select",
    ]);
  });

  test("every grant carries a reason", () => {
    for (const grants of [WEB_GRANTS, PROVISIONER_GRANTS]) {
      for (const grant of grants) {
        expect(grant.because.length).toBeGreaterThan(20);
        expect(grant.verbs.length).toBeGreaterThan(0);
      }
    }
  });
});

/**
 * The matrix against the audited call graph, in BOTH directions.
 *
 * "Is everything the code touches granted" is the question that let four
 * unreachable verbs stand while the one the seam needed was missing. These
 * cases ask the exact question instead, and they fail with the offending
 * table:verb rather than a count.
 */
describe("the matrix is exactly what the deployed command reaches", () => {
  test("no verb the call graph reaches is missing, and none is excess", () => {
    const verdict = provisionerMatrixAgainstReachable();
    expect(verdict.missing).toEqual([]);
    expect(verdict.excess).toEqual([]);
    expect(verdict.exact).toBe(true);
  });

  test("a withheld reachable verb is reported as MISSING", () => {
    const narrowed = PROVISIONER_GRANTS.filter(
      (g) => g.table !== "name_reservations",
    );
    const verdict = provisionerMatrixAgainstReachable(narrowed);
    expect(verdict.missing).toEqual(["name_reservations:select"]);
    expect(verdict.excess).toEqual([]);
    expect(verdict.exact).toBe(false);
  });

  test("a verb nothing reaches is reported as EXCESS", () => {
    const widened = [
      ...PROVISIONER_GRANTS,
      { table: "accounts", verbs: ["select"] as const, because: "nothing" },
    ];
    const verdict = provisionerMatrixAgainstReachable(widened);
    expect(verdict.excess).toEqual(["accounts:select"]);
    expect(verdict.missing).toEqual([]);
    expect(verdict.exact).toBe(false);
  });

  test("every reachable entry cites where the verb is issued", () => {
    for (const entry of PROVISIONER_REACHABLE) {
      expect(entry.via.length).toBeGreaterThan(20);
    }
  });

  // The re-apply's before-state has to be the matrix production actually holds,
  // and the only difference between the two is the provisioner's half.
  test("the prior matrix differs from the current one only where the audit moved it", () => {
    const prior = provisionerMatrixAgainstReachable(PRIOR_PROVISIONER_GRANTS);
    expect(prior.missing).toEqual([
      "certificate_credentials:insert",
      "certificate_credentials:select",
      "certificate_credentials:update",
      "reinstatement_attempts:select",
      "reinstatement_attempts:update",
      "subscriptions:select",
    ]);
    expect(prior.excess).toEqual([]);
  });
});

describe("the statements that put it in place", () => {
  const statements = governanceStatements({
    ownerRole: "owner",
    bounds: BOUNDS,
  });

  test("a role is created before it is governed, and governed before granted", () => {
    for (const role of [WEB_ROLE, PROVISIONER_ROLE]) {
      const created = statements.findIndex(
        (s) => s.includes("create role") && s.includes(role),
      );
      const limited = statements.findIndex((s) =>
        s.startsWith(`alter role ${role} connection limit`),
      );
      const granted = statements.findIndex((s) =>
        s.startsWith(`grant usage on schema public to ${role}`),
      );
      expect(created).toBeGreaterThanOrEqual(0);
      expect(created).toBeLessThan(limited);
      expect(limited).toBeLessThan(granted);
    }
  });

  test("a runtime role is created NOLOGIN and given no password here", () => {
    const creates = statements.filter((s) => s.includes("create role"));
    expect(creates.length).toBe(2);
    for (const s of creates) {
      expect(s).toContain("nologin");
      expect(s).not.toContain("password");
    }
  });

  // The owner is NOT capped, and this is the test that keeps a future edit from
  // quietly reinstating a statement the provider refuses. `ALTER ROLE ...
  // CONNECTION LIMIT` against the project owner answers 42501 from every
  // identity available to us (measured 2026-08-11), so a governance run that
  // issued it would fail halfway through every time.
  test("no statement tries to cap the owner, because the provider refuses it", () => {
    const capping = statements.filter((s) => s.includes("connection limit"));
    expect(capping.length).toBe(2);
    for (const s of capping) expect(s).not.toContain("alter role owner ");
  });

  test("the owner still gets the governed bounds, which DO apply to it", () => {
    for (const [name, value] of BOUNDS) {
      expect(statements).toContain(`alter role owner set ${name} = '${value}'`);
    }
  });

  test("each role is given exactly the governed bounds", () => {
    for (const role of [WEB_ROLE, PROVISIONER_ROLE, "owner"]) {
      for (const [name, value] of BOUNDS) {
        expect(statements).toContain(
          `alter role ${role} set ${name} = '${value}'`,
        );
      }
    }
  });

  test("no statement grants a verb the matrix does not carry", () => {
    for (const statement of statements) {
      if (!statement.startsWith("grant ")) continue;
      expect(statement).not.toContain("delete");
      expect(statement).not.toContain("all privileges");
    }
  });

  // A per-table matrix cannot be expressed as a per-schema default, so the
  // defaults are deliberately absent and this is the check that keeps them so:
  // a future edit that reaches for the convenient blanket has to argue with a
  // test first.
  test("no default privileges are attached", () => {
    for (const statement of statements) {
      expect(statement).not.toContain("alter default privileges");
    }
  });

  test("it refuses to build a statement around a name it cannot recognise", () => {
    expect(() => assertIdentifier('web"; drop role x --')).toThrow();
    expect(() =>
      governanceStatements({
        ownerRole: "owner",
        bounds: [["statement_timeout", "30s'; drop role x --"]],
      }),
    ).toThrow();
  });
});

describe("the verdict a gate exits on", () => {
  // The failure mode this exists for: a command that prints `false` next to a
  // required predicate and then exits zero. Every claim is required, so any
  // false one is a failure and the names come back for the transcript.
  test("every false claim is a failure, and it is named", () => {
    expect(
      failedClaims([
        ["a", true],
        ["b", true],
      ]),
    ).toEqual([]);
    expect(
      failedClaims([
        ["a", true],
        ["b", false],
      ]),
    ).toEqual(["b"]);
    expect(
      failedClaims([
        ["accounts_exactly_1_before", false],
        ["web_effective_privilege_exact", false],
        ["web_is_nologin", true],
      ]),
    ).toEqual(["accounts_exactly_1_before", "web_effective_privilege_exact"]);
  });

  test("no claims is not a pass by accident", () => {
    // An empty list means nothing was checked. It reads as "no failures", which
    // is why the commands claim at least the branch proof before anything else.
    expect(failedClaims([])).toEqual([]);
  });
});

describe("effective privilege, which is what the boundary is about", () => {
  const rows = (
    entries: [string, string, string, boolean][],
  ): { role: string; table: string; verb: string; allowed: boolean }[] =>
    entries.map(([role, table, verb, allowed]) => ({
      role,
      table,
      verb,
      allowed,
    }));

  test("a verb the role can exercise but the matrix omits is EXCESS", () => {
    const verdict = judgeEffective(
      rows([
        [WEB_ROLE, "subscriptions", "select", true],
        [WEB_ROLE, "subscriptions", "delete", true],
      ]),
      WEB_ROLE,
      WEB_GRANTS,
    );
    expect(verdict.excess).toBe(1);
    expect(verdict.exact).toBe(false);
  });

  test("a verb the matrix carries but the role cannot exercise is MISSING", () => {
    const verdict = judgeEffective(
      rows([[WEB_ROLE, "subscriptions", "select", false]]),
      WEB_ROLE,
      WEB_GRANTS,
    );
    expect(verdict.missing).toBe(1);
  });

  test("another role's rows are not this role's verdict", () => {
    const verdict = judgeEffective(
      rows([[PROVISIONER_ROLE, "subscriptions", "delete", true]]),
      WEB_ROLE,
      WEB_GRANTS,
    );
    expect(verdict.exact).toBe(true);
  });
});

describe("the bootstrap report counts only EXACT governance", () => {
  const facts = (over: Partial<import("./roles.ts").RoleFacts> = {}) => ({
    present: true,
    connectionLimit: WEB_BUDGET,
    boundsExact: true,
    canLogin: false,
    memberships: 0,
    writeGrants: 10,
    ...over,
  });
  const posture = (web: object, prov: object) =>
    new Map([
      [WEB_ROLE, web],
      [PROVISIONER_ROLE, prov],
    ] as [string, import("./roles.ts").RoleFacts][]);

  test("both exact counts two", () => {
    expect(
      governedRoleCount(
        posture(facts(), facts({ connectionLimit: PROVISIONER_BUDGET })),
      ),
    ).toBe(2);
  });

  // The state the old loose count could not see: a role with SOME limit and
  // SOME configuration, neither of them the right one.
  test("a wrong limit is not governance", () => {
    expect(
      governedRoleCount(
        posture(
          facts({ connectionLimit: 99 }),
          facts({ connectionLimit: PROVISIONER_BUDGET }),
        ),
      ),
    ).toBe(1);
  });

  test("a stale role setting is not governance", () => {
    expect(
      governedRoleCount(
        posture(
          facts(),
          facts({ connectionLimit: PROVISIONER_BUDGET, boundsExact: false }),
        ),
      ),
    ).toBe(1);
  });

  test("an absent role is not governance", () => {
    expect(
      governedRoleCount(
        posture(
          facts({ present: false }),
          facts({ connectionLimit: PROVISIONER_BUDGET }),
        ),
      ),
    ).toBe(1);
  });
});

describe("the effective sweep asks about EVERY table privilege", () => {
  test("it covers the four Postgres verbs this build never grants", () => {
    for (const verb of ["truncate", "references", "trigger", "maintain"]) {
      expect(ALL_VERBS).toContain(verb as (typeof ALL_VERBS)[number]);
    }
  });

  // A PUBLIC truncate is the shape that passed the old sweep: not granted to
  // the role, not one of the four verbs the matrix speaks about, and enough to
  // empty a table the web tier may only read.
  test("a verb outside the matrix is EXCESS even when the matrix has no opinion", () => {
    const verdict = judgeEffective(
      [
        {
          role: WEB_ROLE,
          table: "subscriptions",
          verb: "select",
          allowed: true,
        },
        {
          role: WEB_ROLE,
          table: "subscriptions",
          verb: "truncate",
          allowed: true,
        },
      ],
      WEB_ROLE,
      WEB_GRANTS,
    );
    expect(verdict.excess).toBe(1);
    expect(verdict.exact).toBe(false);
  });
});

describe("a pre-existing role is only adopted if it is inert", () => {
  const identity = (
    over: Partial<Parameters<typeof residueIsInert>[0]> = {},
  ): Parameters<typeof residueIsInert>[0] => ({
    role: WEB_ROLE,
    can_login: false,
    config: [],
    belongs_to: 0,
    members_of_it: 0,
    members_other_than_owner: 0,
    owns_anything: 0,
    owns_databases: 0,
    owns_schemas: 0,
    owns_relations: 0,
    owns_routines: 0,
    owns_types: 0,
    backends: 0,
    ...over,
  });

  test("the residue a previous run leaves is adoptable", () => {
    expect(residueIsInert(identity())).toBe(true);
  });

  test("anything that looks like somebody else's role is not", () => {
    expect(residueIsInert(identity({ can_login: true }))).toBe(false);
    expect(residueIsInert(identity({ backends: 1 }))).toBe(false);
  });

  // BOTH DIRECTIONS of membership. The second is the dangerous one: adopting a
  // role that OTHER roles are members of hands them everything the matrix is
  // about to grant it, and counting only the first direction misses it
  // entirely.
  test("membership is refused whichever way the edge points", () => {
    expect(residueIsInert(identity({ belongs_to: 1 }))).toBe(false);
    expect(
      residueIsInert(
        identity({ members_of_it: 1, members_other_than_owner: 1 }),
      ),
    ).toBe(false);
  });

  // THE OWNER'S OWN MEMBERSHIP IS NOT A THIRD PARTY. Postgres 16+ creates it
  // when a non-superuser creates a role, so on the managed provider this build
  // deploys on it is present from the moment the role exists (measured on the
  // Neon suites branch 2026-08-12: one member each, the owner, with admin
  // option). Refusing on it would mean the build could never run twice against
  // its own correct state.
  test("the owner's own membership does not make a role somebody else's", () => {
    expect(
      residueIsInert(
        identity({ members_of_it: 1, members_other_than_owner: 0 }),
      ),
    ).toBe(true);
  });

  // And the exemption is exactly one member wide: a second one, whoever it is,
  // still refuses.
  test("a member that is not the owner still refuses", () => {
    expect(
      residueIsInert(
        identity({ members_of_it: 2, members_other_than_owner: 1 }),
      ),
    ).toBe(false);
  });

  // The exemption is one-directional. Our role being a member of something
  // ELSE hands our privileges outward, and no owner argument applies to it.
  test("belongs_to stays zero-tolerance, owner or not", () => {
    expect(
      residueIsInert(
        identity({
          belongs_to: 1,
          members_of_it: 1,
          members_other_than_owner: 0,
        }),
      ),
    ).toBe(false);
  });

  test("an unreadable member count refuses rather than passing", () => {
    expect(residueIsInert(identity({ members_other_than_owner: -1 }))).toBe(
      false,
    );
  });

  // Ownership is CLUSTER-WIDE for a global role name, so a relation in this
  // database is only one of the ways a role can own something.
  test("ownership of anything, anywhere, is refused", () => {
    expect(residueIsInert(identity({ owns_anything: 1 }))).toBe(false);
    expect(residueIsInert(identity({ owns_databases: 1 }))).toBe(false);
    expect(residueIsInert(identity({ owns_schemas: 1 }))).toBe(false);
    expect(residueIsInert(identity({ owns_relations: 1 }))).toBe(false);
    expect(residueIsInert(identity({ owns_routines: 1 }))).toBe(false);
    expect(residueIsInert(identity({ owns_types: 1 }))).toBe(false);
  });

  // A question that could not be asked is not an answer of zero.
  test("a count this build could not read refuses rather than passing", () => {
    expect(residueIsInert(identity({ owns_anything: -1 }))).toBe(false);
    expect(residueIsInert(identity({ backends: Number.NaN }))).toBe(false);
  });
});

describe("the read-back that decides whether a role is governed", () => {
  test("exactly the governed pair passes", () => {
    expect(
      boundsAreExact(
        BOUNDS.map(([n, v]) => `${n}=${v}`),
        BOUNDS,
      ),
    ).toBe(true);
  });

  test("a missing, changed or extra entry fails", () => {
    const exact = BOUNDS.map(([n, v]) => `${n}=${v}`);
    expect(boundsAreExact(exact.slice(1), BOUNDS)).toBe(false);
    expect(boundsAreExact([...exact, "lock_timeout=5s"], BOUNDS)).toBe(false);
    expect(boundsAreExact(["statement_timeout=45s", exact[1]], BOUNDS)).toBe(
      false,
    );
    expect(boundsAreExact([], BOUNDS)).toBe(false);
  });
});
