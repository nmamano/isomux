// The audit's premise, pinned to the code the audit was about.
//
// `PROVISIONER_REACHABLE` in `roles.ts` says which verbs the deployed command
// reaches, and the grant matrix is derived from it. That claim rests on a
// SET - which handlers the tick loop registers, and which non-handler surfaces
// `cmdRun` drives - and a verb list cannot state its own premise. Before this
// file, a handler added to the roster could touch a new table while every test
// about the matrix stayed green: the same shape as the omission that left the
// invite seam unable to read a reservation row on 2026-08-12.
//
// So both halves are read from the real thing:
//
//   - the ROSTER is built through `run-roster.ts`, the function `cli.ts`
//     actually calls, and compared to the audited kinds;
//   - the SURFACE is read out of `cli.ts` as text, because `cli.ts` runs
//     `main()` at import and cannot be imported by a test. What is compared is
//     the set of things `cmdRun`'s body CALLS.
//
// Neither test says the verbs are right - that is a human audit, and the `via`
// citations are where it is written down. What they say is that the audit was
// about the roster the deployed command actually has.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AUDITED_CMDRUN_SURFACES,
  AUDITED_HANDLER_KINDS,
  AUDITED_PROVIDER_HANDLER_KINDS,
  AUDITED_STRIPE_HANDLER_KINDS,
  PROVISIONER_REACHABLE,
} from "./roles.ts";
import {
  PROVIDER_DEPENDENT_KINDS,
  type ProviderVerbs,
  tickerHandlerRoster,
} from "./run-roster.ts";
import type { HandlerDeps } from "./handlers.ts";
import type { StripeClient } from "./stripe/client.ts";
import type { StripeObjectReader } from "./stripe/reader.ts";

/** Enough of the deps to CONSTRUCT the handlers. None of them runs here: what
 * is being read is the roster, and a handler that ran would need a database. */
const box = {
  exec: (() => {
    throw new Error("no handler runs in this test");
  }) as unknown as HandlerDeps["exec"],
  reporter: {
    line: () => {},
    step: () => {},
    problem: () => {},
  } as unknown as HandlerDeps["reporter"],
  runsDir: "/nonexistent/runs",
  keysDir: "/nonexistent/keys",
} as HandlerDeps;

const provider: ProviderVerbs = {
  reboot: async () => {},
  powerOff: async () => {},
  powerOn: async () => {},
  cancel: async () => ({ assetState: "active" }),
  getAsset: async () => ({ assetState: "active" }),
};

const kindsOf = (p: ProviderVerbs | null): string[] =>
  tickerHandlerRoster({ box, provider: p, report: () => {} }).map(
    (h) => h.kind,
  );

const stripe = {
  client: {} as StripeClient,
  reader: {} as StripeObjectReader,
};

describe("the audited roster is the roster the loop is built from", () => {
  test("the registered kinds are exactly the audited ones", () => {
    expect(kindsOf(null).sort()).toEqual([...AUDITED_HANDLER_KINDS].sort());
  });

  test("provider credentials add exactly the audited provider kinds", () => {
    const extra = kindsOf(provider).filter((k) => !kindsOf(null).includes(k));
    expect(extra.sort()).toEqual([...AUDITED_PROVIDER_HANDLER_KINDS].sort());
  });

  test("Stripe credentials add exactly the Checkout-expiry handler", () => {
    const base = kindsOf(null);
    const withStripe = tickerHandlerRoster({
      box,
      provider: null,
      report: () => {},
      stripe,
    }).map((handler) => handler.kind);
    expect(withStripe.filter((kind) => !base.includes(kind))).toEqual([
      ...AUDITED_STRIPE_HANDLER_KINDS,
    ]);
  });

  test("the provisioner refuses startup without Checkout-expiry capability", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dir, "cli.ts"),
      "utf8",
    );
    expect(source).toContain(
      'if (!stripeKey) {\n    throw new Error(\n      "STRIPE_TEST_SECRET_KEY is required by the provisioner because retained-office deletion must expire Checkout first"',
    );
  });

  // The health surface reports whether the provider handlers exist, and it asks
  // the ticker rather than the environment - but it needs a list of kinds to
  // ask about, and that list is a third copy of the same set. This is the test
  // that keeps the three from drifting: what the deployed process asks about is
  // exactly what provider credentials add.
  test("PROVIDER_DEPENDENT_KINDS is exactly what credentials add", () => {
    const extra = kindsOf(provider).filter((k) => !kindsOf(null).includes(k));
    expect([...PROVIDER_DEPENDENT_KINDS].sort()).toEqual(
      extra.sort() as (typeof PROVIDER_DEPENDENT_KINDS)[number][],
    );
  });

  test("no handler is registered twice", () => {
    const all = kindsOf(provider);
    expect(new Set(all).size).toBe(all.length);
  });

  // THE ABSENCE THE MATRIX RESTS ON. Four verbs came off the provisioner's
  // matrix because the create path is unreachable, and this is that premise as
  // a test rather than as a comment.
  test("create_instance is not registered, with or without credentials", () => {
    expect(kindsOf(null)).not.toContain("create_instance");
    expect(kindsOf(provider)).not.toContain("create_instance");
  });
});

/**
 * `cmdRun`'s body, as the set of names it calls.
 *
 * Read as text on purpose: importing `cli.ts` runs its `main()`. The extraction
 * takes the function from its declaration to the first line that closes it at
 * column zero, which is how every top-level function in that file ends.
 */
function cmdRunCallees(): string[] {
  const source = fs.readFileSync(path.join(import.meta.dir, "cli.ts"), "utf8");
  const start = source.indexOf("async function cmdRun(");
  expect(start).toBeGreaterThan(0);
  const end = source.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end);

  // Language constructs and locals are not surfaces. Anything a reader would
  // call a CALL INTO THIS BUILD survives the filter, which is the point: the
  // list has to fail on a new one rather than absorb it.
  const ignore = new Set([
    "cmdRun",
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "return",
    "typeof",
    "await",
    "async",
    "function",
    "Number",
    "String",
    "Boolean",
    "Date.now",
    "args.get",
    "reporter.line",
    "reporter.step",
    "process.on",
    "process.off",
    // Method calls on a local rather than surfaces of this build: an optional
    // chain (`seam?.stop()`) and a promise (`.then()`) both reduce to their
    // last segment, and neither reaches a database.
    "stop",
    "then",
  ]);
  const found = new Set<string>();
  for (const match of body.matchAll(
    /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g,
  )) {
    const name = match[1];
    if (!ignore.has(name)) found.add(name);
  }
  return [...found].sort();
}

describe("the audited surface is the surface cmdRun drives", () => {
  // A NEW CALL FAILS THIS, which is the whole point: `startMintSeam` is how the
  // verb the 2026-08-12 run was refused is reached, and it is not a handler.
  test("cmdRun calls exactly the audited non-handler surfaces", () => {
    expect(cmdRunCallees()).toEqual([...AUDITED_CMDRUN_SURFACES].sort());
  });

  test("the extraction found a body worth checking", () => {
    // A regex that matched nothing would make the case above pass forever.
    expect(cmdRunCallees().length).toBeGreaterThan(8);
  });
});

describe("the audit covers the roster it was taken from", () => {
  // The verb list is a human audit; what is checkable is that it was taken from
  // a roster this build still has, and that every entry says where.
  test("the mint seam's reservation read is in the audit", () => {
    const entry = PROVISIONER_REACHABLE.find(
      (r) => r.table === "name_reservations" && r.verb === "select",
    );
    expect(entry?.via).toContain("fetchInvite");
  });

  test("every audited entry cites where the verb is issued", () => {
    for (const entry of PROVISIONER_REACHABLE) {
      expect(entry.via.length).toBeGreaterThan(20);
    }
  });
});
