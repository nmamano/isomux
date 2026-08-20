// The web app's boundary, asserted against the source rather than described in
// a comment.
//
// The design's blast-radius section says the public web app cannot decrypt key
// material and never originates SSH. That is a property of what it IMPORTS, and
// no behavioural test can catch a future page adding one line at the top of a
// file. So this reads the app's own source: which modules it may name, which
// credentials it may read, and - because a loader that handed back a live Store
// would leave every handler one method call away from mutating the control
// plane - which store methods may appear anywhere in it at all.
//
// Scope: everything that ships in the app's server bundle. `e2e/` is a test
// driver that runs as its own process and never inside the app, so it is
// excluded here and asserted to be unimported.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const WEB = path.join(import.meta.dir, "web");
const FACADE = path.join(WEB, "lib", "services.server.ts");

function appFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      if (entry.name === "e2e") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // Declaration files carry no code: a type reference is not the app
      // opening a database.
      else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts"))
        out.push(full);
    }
  };
  walk(WEB);
  return out;
}

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

const FILES = appFiles();

test("the app has files to check", async () => {
  expect(FILES.length).toBeGreaterThan(5);
  expect(FILES).toContain(FACADE);
});

describe("only one file reaches the store", () => {
  test("nothing else names the store, its engine, or opens one", async () => {
    for (const file of FILES) {
      if (file === FACADE) continue;
      const source = read(file);
      // The rule is STRUCTURAL: not "does this file mention a driver by name",
      // which is a list somebody has to keep and which a rename makes
      // meaningless, but "can this file reach a database at all". It may not
      // import the store, it may not construct one, and it may not import a
      // driver of its own to go around the store with.
      expect(source).not.toMatch(/from\s+"\.\.\/[^"]*store"/);
      expect(source).not.toMatch(/new Store\b/);
      expect(source).not.toMatch(/from\s+"(pg|postgres|node-postgres)(\/|")/);
    }
  });

  test("the facade's exports are a fixed list", async () => {
    const source = read(FACADE);
    const exported = [...source.matchAll(/export (?:async )?function (\w+)/g)]
      .map((m) => m[1])
      .sort();
    // Adding an entry here is a deliberate act, which is the point: a new way
    // into the control plane cannot appear as a side effect of writing a page.
    expect(exported).toEqual([
      "acknowledgeOpsInstance",
      "checkTrustedOrigin",
      "confirmHandoff",
      "continueSignup",
      "identityForSignIn",
      "officeForAccount",
      "officeRouteForAccount",
      "opsFloor",
      "opsInstance",
      "plans",
      "progressForAccount",
      "reinstateOffice",
      "requestCancel",
      "requestInvite",
      "requestRestart",
      "requestUncancel",
      "revealInvite",
      "signUpOffice",
      "signupPageState",
    ]);
    // And nothing exports a store, a database or a transaction.
    expect(source).not.toMatch(/export .*\bStore\b/);
  });

  test("every control-plane import in the facade is request-time", async () => {
    const source = read(FACADE);
    for (const line of source.split("\n")) {
      if (!/from\s+"\.\.\/\.\./.test(line)) continue;
      // A static import would put the whole control-plane runtime - keys, ssh,
      // handlers, the webhook path - into the storefront's module graph. The
      // build used to enforce this on its own, because the store spoke
      // bun:sqlite and `next build` runs under Node; with a driver that loads
      // under both, THIS ASSERTION IS THE ONLY ENFORCEMENT LEFT.
      expect(line).toMatch(/^import type /);
    }
  });

  test("the facade imports only the typed services it is allowed to", async () => {
    const source = read(FACADE);
    const specifiers = [
      ...source.matchAll(/(?:import\(|from )"(\.\.\/\.\.[^"]*)"/g),
    ].map((m) => m[1]);
    const allowed = new Set([
      "../../plans",
      "../../signup",
      "../../progress",
      "../../store",
      "../../stripe/client",
      "../../stripe/checkout",
      "../../stripe/reader",
      "../../stripe/billing-store",
      // Slice 4b. `requests` is the customer's three verbs over the store;
      // `mint-client` is fetch plus a bearer credential and imports nothing
      // from the control plane except a type. The graph walk below is what
      // proves neither drags the driver in behind it.
      "../../requests",
      "../../mint-client",
      // Slice 5. `cancel` is the customer's two billing verbs and reaches
      // Stripe the same way signup does; `ops` is the operator's verb surface,
      // and its authority check lives INSIDE it rather than in a page. The
      // graph walk below is what proves neither drags the driver in behind it -
      // and, for ops, that it reaches acknowledgement without reaching raise or
      // clear.
      "../../cancel",
      "../../ops",
      "../../reinstatement",
      "../../stripe/mode",
    ]);
    for (const specifier of specifiers) {
      expect([specifier, allowed.has(specifier)]).toEqual([specifier, true]);
    }
  });
});

describe("the privileged half of the control plane is unreachable", () => {
  const FORBIDDEN_MODULES = [
    "keys",
    "ssh",
    "driver",
    "handlers",
    "tick",
    "intents",
    "create-latch",
    "create-coordinator",
    "provider",
    "contabo",
    "remote",
    "run-record",
    "attention",
    "operations",
    "cli",
    "billing-cli",
    "stripe/webhook",
    "stripe/reconcile",
    "stripe/dunning",
    "stripe/suspension",
    "stripe/signature",
    // Slice 4b, the provisioner's half of the invite path. `mint-seam` serves
    // the fetch verb and can read the hold; `invite-hold` IS the plaintext
    // invite in memory; `liveness-watch` and `reboot` drive probes and a
    // provider power action. None of them may be reachable from a page - the
    // app's side of this is mint-client.ts and nothing else.
    "mint-seam",
    "invite-hold",
    "liveness-watch",
    "reboot",
    // Slice 5. `attention` STAYS FORBIDDEN WITH NO EXCEPTION - it exports raise
    // and clear, and an app that can raise attention can manufacture an
    // incident while one that can clear it can hide a real failure. The ops
    // floor needs only acknowledgement, which is why that one function lives in
    // attention-ack.ts. The rest is the lifecycle machinery and the operator
    // flag's WRITER: an app that could grant its own session the flag would
    // have no ops authorization at all, only the appearance of it.
    "attention",
    "lifecycle-tick",
    "deprovision",
    "resume",
    "operator-admin",
  ];

  test("no app file imports the driver, the provider or the webhook path", async () => {
    for (const file of FILES) {
      const source = read(file);
      for (const module of FORBIDDEN_MODULES) {
        const pattern = new RegExp(
          `["']\\.\\.[^"']*/${module.replace("/", "\\/")}(\\.ts)?["']`,
        );
        expect([path.basename(file), module, pattern.test(source)]).toEqual([
          path.basename(file),
          module,
          false,
        ]);
      }
    }
  });

  /**
   * The dev sign-in cannot exist in a production build, and that is structural.
   *
   * It matters because the production transcript's `/api/auth/providers` came
   * back `{}` - which is the gate working, not a gap in the app. A behavioural
   * test cannot pin this: the second condition is settled when Next compiles,
   * so a test process could never observe the production answer. So the source
   * is what is asserted, exactly as the boundary rules above are.
   *
   * Both halves are named. The flag alone would let a deployment that sets it
   * ship a password-free sign-in; the build check alone would make the provider
   * appear in every developer's tree.
   */
  test("the dev sign-in is gated on the flag AND a non-production build", async () => {
    const source = read(path.join(WEB, "auth.ts"));
    const gate = source.match(/const devAuthEnabled\s*=([\s\S]*?);\n/)?.[1];
    expect(gate).toBeDefined();
    expect(gate).toContain('process.env.CONTROL_PLANE_DEV_AUTH === "1"');
    expect(gate).toContain('process.env.NODE_ENV !== "production"');
    // And the provider is reached only through that gate, rather than being
    // registered beside it and filtered somewhere else later.
    expect(source).toMatch(
      /if \(devAuthEnabled\) \{\s*providers\.push\(\s*Credentials\(/,
    );
  });

  test("no app file reads provider credentials or the webhook secret", async () => {
    for (const file of FILES) {
      const source = read(file);
      expect(source).not.toContain("CONTABO_");
      expect(source).not.toContain("STRIPE_WEBHOOK_SECRET");
      expect(source).not.toContain(".isomux-control-plane");
      if (file.endsWith("server-administrator-key.ts")) {
        expect(source.startsWith('"use client"')).toBe(true);
        expect(source).toContain("openssh-key-v1");
      } else {
        expect(source).not.toContain("PRIVATE KEY");
      }
    }
  });

  test("no app file calls a raw store, transaction or mutation method", async () => {
    // `new Store` and `close()` are the facade's business; everything below
    // would be a handler reaching past the typed services.
    const FORBIDDEN = [
      /\.db\b/,
      // The raw-SQL escape hatch on the store. Named to be greppable, and
      // forbidden here for the same reason `.db` is: a page one method call
      // away from arbitrary SQL has no boundary at all.
      /\bsql[A-Z]/,
      /\.tx\(/,
      /\.enqueue\(/,
      /\bcas[A-Z]/,
      /createInstance\(/,
      /createAsset\(/,
      /raiseAttention/,
      /clearAttention/,
      /acknowledgeAttention/,
      /openReasons\(/,
      /operationsFor\(/,
      /dueOperations\(/,
      /tryLease\(/,
      /appendAudit\(/,
      /nextSeq\(/,
    ];
    for (const file of FILES) {
      const source = read(file);
      for (const pattern of FORBIDDEN) {
        expect([
          path.basename(file),
          String(pattern),
          pattern.test(source),
        ]).toEqual([path.basename(file), String(pattern), false]);
      }
    }
  });

  test("no app file names an operation kind, so none can be routed in", async () => {
    const KINDS = [
      "create_instance",
      "wait_for_ssh",
      "wait_for_package_manager",
      "first_contact",
      "arm_revocation",
      "run_installer",
      "verify_https",
      "mint_invite",
      "revoke_access",
      "power_off",
      // Added in 4b, and the reason the customer-facing vocabulary is RESTART:
      // the app asks for one through a named verb, and cannot spell the kind.
      "reboot",
      // Added in 5. The lifecycle's kinds are opened by a tick, never by a
      // page, and the app cannot name one to ask for it.
      "power_on",
      "expire_checkout",
      "cancel_asset",
      "remove_dns",
    ];
    for (const file of FILES) {
      const source = read(file);
      for (const kind of KINDS) {
        expect([path.basename(file), kind, source.includes(kind)]).toEqual([
          path.basename(file),
          kind,
          false,
        ]);
      }
    }
  });

  test("the browser-driver harness is not part of the app", async () => {
    for (const file of FILES) {
      expect(read(file)).not.toMatch(/["'][^"']*e2e\//);
    }
  });

  /**
   * The direct-import rules above are not enough on their own, and this test
   * exists because they were not: the facade may import stripe/checkout.ts, and
   * checkout.ts imported four metadata constants from stripe/reconcile.ts - so
   * the whole webhook path arrived in the app's bundle through a module the
   * boundary explicitly allows. The constants moved to their own module; this
   * walks the graph so the next such edge fails here rather than shipping.
   *
   * Type-only imports are followed by the compiler but erased by the bundler,
   * so they are excluded: what is being asserted is what the app RUNS.
   */
  test("nothing forbidden is reachable from the facade, however indirectly", async () => {
    const CONTROL_PLANE = import.meta.dir;
    const seen = new Set<string>();
    const forbidden: string[] = [];

    const resolve = (from: string, specifier: string): string | null => {
      if (!specifier.startsWith(".")) return null;
      const base = path.resolve(path.dirname(from), specifier);
      for (const candidate of [
        base,
        `${base}.ts`,
        path.join(base, "index.ts"),
      ]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile())
          return candidate;
      }
      return null;
    };

    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const name = path.relative(CONTROL_PLANE, file).replace(/\.ts$/, "");
      // operations.ts is the one module on the direct list that legitimately
      // appears in the graph: it is a pure table of kinds, deadlines and the
      // chain function, and the projection derives its ladder from it. It
      // performs no I/O and reaches nothing that does. Everything else on the
      // list stays forbidden however indirectly it arrives.
      // operations.ts is the one module on the direct list that legitimately
      // appears in the graph, and the exception is narrow BY NAME. Nothing else
      // is excused - in particular attention.ts, which the ops floor reaches
      // around by depending on attention-ack.ts instead.
      if (FORBIDDEN_MODULES.includes(name) && name !== "operations")
        forbidden.push(name);
      const source = read(file);
      for (const match of source.matchAll(
        /(?:^|\n)\s*(?:export|import)\s+(type\s+)?[^;]*?from\s+"([^"]+)"|import\(\s*"([^"]+)"\s*\)/g,
      )) {
        if (match[1]) continue; // `import type` / `export type`: erased.
        const specifier = match[2] ?? match[3];
        const next = specifier ? resolve(file, specifier) : null;
        if (next) walk(next);
      }
    };

    walk(FACADE);
    expect(forbidden).toEqual([]);
    // A sanity check on the walk itself: if it stopped at the facade it would
    // trivially pass, so it must have reached the services it is allowed to -
    // including the three 4b added, or this would pass by not looking.
    expect(seen.has(path.join(CONTROL_PLANE, "signup.ts"))).toBe(true);
    expect(seen.has(path.join(CONTROL_PLANE, "progress.ts"))).toBe(true);
    expect(seen.has(path.join(CONTROL_PLANE, "store.ts"))).toBe(true);
    expect(seen.has(path.join(CONTROL_PLANE, "requests.ts"))).toBe(true);
    expect(seen.has(path.join(CONTROL_PLANE, "mint-client.ts"))).toBe(true);
    expect(seen.has(path.join(CONTROL_PLANE, "liveness.ts"))).toBe(true);
    // Slice 5's three, including the one that proves the split worked: the app
    // reaches attention-ack.ts and NOT attention.ts.
    expect(seen.has(path.join(CONTROL_PLANE, "cancel.ts"))).toBe(true);
    expect(seen.has(path.join(CONTROL_PLANE, "ops.ts"))).toBe(true);
    expect(seen.has(path.join(CONTROL_PLANE, "attention-ack.ts"))).toBe(true);
    expect(seen.has(path.join(CONTROL_PLANE, "attention.ts"))).toBe(false);
  });

  /**
   * The least-privilege split, asserted at the module that has to stay small.
   *
   * attention-ack.ts exists so the ops floor can acknowledge without the app's
   * graph reaching raise or clear. If it ever imported attention.ts - "just to
   * reuse summarise" - the graph walk above would light up, and this says the
   * same thing one layer earlier, where the fix is obvious.
   */
  test("acknowledgement cannot reach raise or clear", async () => {
    const source = read(path.join(import.meta.dir, "attention-ack.ts"));
    expect(source).not.toMatch(/from\s+"\.\/attention/);
    expect(source).not.toContain("raiseAttention");
    expect(source).not.toContain("clearAttention");
  });

  /**
   * The ops surface is a LISTED set of verbs, like the customer's three.
   *
   * Pinned for the same reason the facade's export list is: the operator side
   * of the product must not grow as a side effect of writing a page.
   */
  test("the ops verb surface is a fixed list", async () => {
    const source = read(path.join(import.meta.dir, "ops.ts"));
    const exported = [...source.matchAll(/export (?:async )?function (\w+)/g)]
      .map((m) => m[1])
      .sort();
    expect(exported).toEqual([
      "acknowledgeInstance",
      "opsFloor",
      "opsInstance",
    ]);
  });

  /**
   * The operator flag is a COLUMN, and authority comes from nowhere else.
   *
   * Two halves. The app may not spell the column, so a page cannot read or
   * write it directly and has to go through a service that gates on it. And no
   * email address gates the ops floor: an address is display data that Google
   * can change under a stable account, so an address-gated floor would silently
   * follow the address.
   */
  test("no app file spells the operator column, and no email gates ops", async () => {
    for (const file of FILES) {
      expect([path.basename(file), read(file).includes("is_operator")]).toEqual(
        [path.basename(file), false],
      );
    }
    const EMAIL = /["'][^"'\s]+@[^"'\s]+\.[a-z]{2,}["']/i;
    for (const file of [
      path.join(import.meta.dir, "ops.ts"),
      path.join(import.meta.dir, "operator.ts"),
      FACADE,
    ]) {
      expect([path.basename(file), EMAIL.test(read(file))]).toEqual([
        path.basename(file),
        false,
      ]);
    }
  });

  /**
   * The seam's client half must stay a client.
   *
   * mint-client.ts is the one module in the app's bundle that talks to the
   * provisioner, so if it ever grew a store import - "just to check ownership
   * first" - the app would be back inside the control plane through the one
   * door the boundary opens. It is allowed node's fetch and a type, and
   * nothing else.
   */
  test("the seam client reaches no control-plane runtime module", async () => {
    const source = read(path.join(import.meta.dir, "mint-client.ts"));
    for (const line of source.split("\n")) {
      if (!/^\s*(?:import|export)\s[^;]*\sfrom\s/.test(line)) continue;
      // A type import is erased by the bundler: what is asserted is what runs.
      expect([line, /^\s*(?:import|export) type /.test(line)]).toEqual([
        line,
        true,
      ]);
    }
  });

  /**
   * The invite never becomes a stored thing.
   *
   * R-2026-08-10-1-AMENDED: the plaintext URL lives ONLY in provisioner process
   * memory. This asserts the shape of that rule at the two places a future edit
   * would break it - the hold must not import a store or a filesystem, and the
   * handler must put the URL in exactly one place.
   */
  test("the invite hold cannot persist anything", async () => {
    const source = read(path.join(import.meta.dir, "invite-hold.ts"));
    expect(source).not.toMatch(/from\s+"\.\/store/);
    expect(source).not.toMatch(/from\s+"(pg|postgres|node-postgres)(\/|")/);
    expect(source).not.toMatch(/from\s+"node:fs"/);
    expect(source).not.toMatch(/console\./);
  });
});
