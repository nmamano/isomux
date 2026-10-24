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
  AUDITED_CMDRUN_HELPER_SURFACES,
  AUDITED_CMDRUN_SURFACES,
  AUDITED_HANDLER_KINDS,
  AUDITED_PROVIDER_HANDLER_KINDS,
  AUDITED_STRIPE_HANDLER_KINDS,
} from "./roles.ts";
import {
  PROVIDER_DEPENDENT_KINDS,
  type ProviderVerbs,
  tickerHandlerRoster,
} from "./run-roster.ts";
import type { HandlerDeps } from "./handlers.ts";
import type { CreateCoordinator } from "./create-coordinator.ts";
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
  getAddress: async () => ({
    assetState: "active",
    powerState: "running",
    raw: null,
  }),
};

const create = {
  coordinator: {} as CreateCoordinator,
  createRequest: (async () => {
    throw new Error("no handler runs in this test");
  }) as NonNullable<HandlerDeps["createRequest"]>,
};

const kindsOf = (p: ProviderVerbs | null): string[] =>
  tickerHandlerRoster({
    box,
    provider: p,
    create: p ? create : null,
    report: () => {},
  }).map((h) => h.kind);

const stripe = {
  client: {} as StripeClient,
  reader: {} as StripeObjectReader,
};

describe("the audited roster is the roster the loop is built from", () => {
  // THE ABSENCE THE MATRIX RESTS ON. Four verbs came off the provisioner's
  // matrix because the create path is unreachable: create_instance is in the
  // provider list below and not in this one.
  test("the registered kinds are exactly the audited ones", () => {
    expect(kindsOf(null).sort()).toEqual([...AUDITED_HANDLER_KINDS].sort());
  });

  // The health surface asks the ticker about PROVIDER_DEPENDENT_KINDS, a third
  // copy of the same set; this keeps the three from drifting. A duplicate kind
  // would silently overwrite its twin in the ticker's handler map.
  test("provider credentials add exactly the audited provider kinds, once each", () => {
    const all = kindsOf(provider);
    const extra = all.filter((k) => !kindsOf(null).includes(k)).sort();
    expect(extra).toEqual([...AUDITED_PROVIDER_HANDLER_KINDS].sort());
    expect([...PROVIDER_DEPENDENT_KINDS].sort()).toEqual(
      extra as (typeof PROVIDER_DEPENDENT_KINDS)[number][],
    );
    expect(new Set(all).size).toBe(all.length);
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
});

const CLI_SOURCE = fs.readFileSync(
  path.join(import.meta.dir, "cli.ts"),
  "utf8",
);

/** Where a top-level function of `cli.ts` is declared, or -1. */
function declarationOf(name: string): number {
  const literal = name.replace(/[.$]/g, "\\$&");
  return CLI_SOURCE.search(
    new RegExp(`^(?:async )?function ${literal}\\(`, "m"),
  );
}

/**
 * A top-level `cli.ts` function's body, as the set of names it calls.
 *
 * Read as text on purpose: importing `cli.ts` runs its `main()`. The extraction
 * takes the function from its declaration to the first line that closes it at
 * column zero, which is how every top-level function in that file ends.
 */
function calleesOf(name: string): string[] {
  const start = declarationOf(name);
  expect(start).toBeGreaterThan(0);
  const end = CLI_SOURCE.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  const body = CLI_SOURCE.slice(start, end);

  // Language constructs and locals are not surfaces. Anything a reader would
  // call a CALL INTO THIS BUILD survives the filter, which is the point: the
  // list has to fail on a new one rather than absorb it.
  const ignore = new Set([
    name,
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
    const callee = match[1];
    if (!ignore.has(callee)) found.add(callee);
  }
  return [...found].sort();
}

const cmdRunCallees = (): string[] => calleesOf("cmdRun");

/** Every top-level `cli.ts` function `cmdRun` reaches, through any depth of
 * other `cli.ts` functions. */
function helpersReached(): string[] {
  const reached = new Set<string>();
  const queue = ["cmdRun"];
  while (queue.length > 0) {
    for (const callee of calleesOf(queue.shift()!)) {
      if (reached.has(callee) || declarationOf(callee) < 0) continue;
      reached.add(callee);
      queue.push(callee);
    }
  }
  return [...reached].sort();
}

describe("the audited surface is the surface cmdRun drives", () => {
  // A NEW CALL FAILS THIS, which is the whole point: `startMintSeam` is how the
  // verb the 2026-08-12 run was refused is reached, and it is not a handler.
  test("cmdRun calls exactly the audited non-handler surfaces", () => {
    expect(cmdRunCallees()).toEqual([...AUDITED_CMDRUN_SURFACES].sort());
  });

  // THE HOLE THE CHECKOUT POLL WENT THROUGH: the case above read cmdRun's body
  // and stopped at runLifecycleCadence, so the poll added inside it on
  // 2026-08-23 reached name_reservations UPDATE without a test noticing.
  test("cmdRun reaches exactly the audited cli.ts functions", () => {
    expect(helpersReached()).toEqual(
      Object.keys(AUDITED_CMDRUN_HELPER_SURFACES).sort(),
    );
  });

  for (const [helper, audited] of Object.entries(
    AUDITED_CMDRUN_HELPER_SURFACES,
  )) {
    test(`${helper} calls exactly its audited surfaces`, () => {
      expect(calleesOf(helper)).toEqual([...audited].sort());
    });
  }
});
