// App registry unit tests (T0/T1) - the leaf behind /api/apps.
//
// Every case runs against an INJECTED temp directory, so nothing here can reach
// the real state root even though the preload has already redirected it.
//
// The load-bearing group is "corruption": the registry's whole reason for
// refusing to fail open is that a name or a port it cannot see is one it could
// hand out twice, and the tests below are written to fail if anyone later
// "simplifies" that back to the cronjob-style catch-and-return-[].
//
// Zero LLM.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  rmSync,
  realpathSync,
} from "fs";
import { isAbsolute, join } from "path";
import { tmpdir } from "os";
import { removeStateDir } from "./test-support/temp-state.ts";
import {
  createAppRegistry,
  parseTestAppPortRange,
  checkAppName,
  APP_PORT_MIN,
  MAX_REGISTERED_APPS,
  MAX_APP_NAME_LENGTH,
  MAX_APP_COMMAND_LENGTH,
  appRegistrationGeneration,
  type AppRegistry,
} from "./app-registry.ts";
import type { AppErrorCode } from "../shared/contract-shapes.ts";

let dir: string;
let cwdDir: string;

// Every port reads as free unless a case says otherwise, so allocation is
// deterministic and no test binds a real socket.
const allFree = () => true;

function make(
  overrides: {
    now?: () => number;
    probePort?: (p: number) => boolean;
    portMin?: number;
    portMax?: number;
  } = {},
): AppRegistry {
  return createAppRegistry({
    dir,
    now: overrides.now ?? (() => 1_700_000_000_000),
    probePort: overrides.probePort ?? allFree,
    portMin: overrides.portMin,
    portMax: overrides.portMax,
  });
}

function registerInput(name: string, over: Record<string, unknown> = {}) {
  return {
    name,
    command: "bun run serve.ts",
    cwd: cwdDir,
    userId: "u-owner",
    username: "Nil",
    createdBy: "Isomuxer2",
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), "isomux-apps-test-"));
  // A real, existing directory for the cwd field (the registry only asserts
  // absoluteness; the route handler is what verifies existence).
  cwdDir = dir;
});
afterEach(() => {
  removeStateDir(dir);
});

describe("app-registry: name validation", () => {
  it("accepts hostname labels and rejects everything else, by rule", () => {
    for (const good of [
      "a",
      "hello",
      "my-app",
      "app2",
      "a-b-c",
      "x".repeat(MAX_APP_NAME_LENGTH),
    ]) {
      expect(checkAppName(good)).toBeNull();
    }
    const bad: [string, AppErrorCode][] = [
      ["", "invalid_name"],
      ["My-App", "invalid_name"], // uppercase
      ["my_app", "invalid_name"], // underscore
      ["-lead", "invalid_name"],
      ["trail-", "invalid_name"],
      ["has space", "invalid_name"],
      ["dot.name", "invalid_name"], // one LABEL, not a hostname
      ["x".repeat(MAX_APP_NAME_LENGTH + 1), "invalid_name"],
      ["../etc", "invalid_name"],
      // The names the design reserves.
      ...[
        "www",
        "api",
        "apps",
        "office",
        "isomux",
        "admin",
        "mail",
        "smtp",
        "ns1",
        "ns2",
      ].map((n): [string, AppErrorCode] => [n, "reserved_name"]),
    ];
    for (const [name, code] of bad) {
      expect(checkAppName(name)?.code).toBe(code);
    }
  });
});

describe("app-registry: port allocation", () => {
  it("skips a port that is occupied on the box but unknown to the registry", () => {
    const busy = APP_PORT_MIN;
    const reg = make({ probePort: (p) => p !== busy });
    expect(reg.register(registerInput("hello")).port).toBe(APP_PORT_MIN + 1);
  });

  it("an injected range controls allocation and names exhaustion", () => {
    const reg = make({ portMin: 24_001, portMax: 24_002 });
    expect(reg.register(registerInput("alpha")).port).toBe(24_001);
    expect(reg.register(registerInput("beta")).port).toBe(24_002);
    expect(() => reg.register(registerInput("gamma"))).toThrow(
      expect.objectContaining({ code: "no_port_available" }),
    );
  });
});

describe("app-registry: test singleton port seam", () => {
  it("accepts a complete numeric range only under the test preload", () => {
    expect(parseTestAppPortRange(undefined, undefined, false)).toEqual({});
    expect(parseTestAppPortRange("24001", "24100", true)).toEqual({
      portMin: 24_001,
      portMax: 24_100,
    });
    for (const [min, max, preload] of [
      ["24001", "24100", false],
      ["24001", undefined, true],
      ["twenty-four", "24100", true],
    ] as const) {
      expect(() => parseTestAppPortRange(min, max, preload)).toThrow();
    }
  });
});

describe("app-registry: registration", () => {
  it("persists the record, creates the data dir, and reloads identically", () => {
    const reg = make();
    const app = reg.register(registerInput("hello", { description: "a demo" }));

    expect(app.port).toBe(APP_PORT_MIN);
    expect(app.name).toBe("hello");
    expect(app.description).toBe("a demo");
    expect(isAbsolute(app.dataDir)).toBe(true);
    expect(app.dataDir).toBe(join(dir, "data", "hello"));
    expect(existsSync(app.dataDir)).toBe(true);
    // Ownership is whatever the caller passed (the route derives it from the
    // token); attribution is separate from it.
    expect(app.userId).toBe("u-owner");
    expect(app.createdBy).toBe("Isomuxer2");

    // A COLD registry over the same dir sees the same app - the round trip is
    // through disk, not through an in-memory cache.
    expect(make().list()).toEqual([app]);
    expect(make().get("hello")).toEqual(app);
    expect(make().get("nope")).toBeNull();
  });

  it("allocates the next port per app and refuses a duplicate name", () => {
    const reg = make();
    const a = reg.register(registerInput("alpha"));
    const b = reg.register(registerInput("beta"));
    expect([a.port, b.port]).toEqual([APP_PORT_MIN, APP_PORT_MIN + 1]);

    expect(() => reg.register(registerInput("alpha"))).toThrow(
      expect.objectContaining({ code: "name_taken" }),
    );
    // The refusal changed nothing.
    expect(reg.list().map((x) => x.name)).toEqual(["alpha", "beta"]);
  });

  it("stores the command and the description VERBATIM, through disk", () => {
    // Whitespace can be load-bearing inside a shell command, and the pickup
    // locks "stored verbatim" - so the registry must not helpfully tidy it.
    const command = '  bun run serve.ts --flag="a  b" \t';
    const reg = make();
    expect(reg.register(registerInput("verbatim", { command })).command).toBe(
      command,
    );
    expect(make().get("verbatim")!.command).toBe(command);
    // An empty description is kept, and an ABSENT one stays absent.
    reg.register(registerInput("blank", { description: "" }));
    expect(make().get("blank")!.description).toBe("");
    reg.register(registerInput("absent"));
    expect("description" in make().get("absent")!).toBe(false);
  });

  it("register and update refuse the same bad fields, before writing anything", () => {
    // One rule set for both: a rule that held at registration and not at
    // update could be walked around with a PATCH.
    const reg = make();
    reg.register(registerInput("hello"));
    const before = readFileSync(join(dir, "apps.json"), "utf-8");
    const refusals: [Record<string, unknown>, AppErrorCode][] = [
      [{ command: "   " }, "invalid_command"],
      [{ command: "x".repeat(MAX_APP_COMMAND_LENGTH + 1) }, "invalid_command"],
      // The limit applies to what was SUBMITTED, not to a trimmed copy.
      [
        { command: " ".repeat(50) + "x".repeat(MAX_APP_COMMAND_LENGTH) + " " },
        "invalid_command",
      ],
      [{ cwd: "relative/path" }, "invalid_cwd"],
      [{ description: "d".repeat(201) }, "invalid_description"],
    ];
    for (const [patch, code] of refusals) {
      const refusal = expect.objectContaining({ code });
      expect(() => reg.register(registerInput("other", patch))).toThrow(
        refusal,
      );
      expect(() => reg.update("hello", patch)).toThrow(refusal);
    }
    expect(readFileSync(join(dir, "apps.json"), "utf-8")).toBe(before);
    expect(existsSync(join(dir, "data", "other"))).toBe(false);
  });

  it("enforces the sanity cap", () => {
    // Seeded on disk rather than registered one by one: each register
    // re-validates the whole file, so a loop of 100 is quadratic.
    writeFileSync(
      join(dir, "apps.json"),
      JSON.stringify(
        Array.from({ length: MAX_REGISTERED_APPS }, (_, i) => ({
          name: `app-${i}`,
          port: APP_PORT_MIN + i,
          command: "bun run serve.ts",
          cwd: "/tmp",
          userId: "u-owner",
          username: "Nil",
          createdBy: "Isomuxer2",
          createdAt: 1,
        })),
      ),
    );
    const reg = make();
    expect(() => reg.register(registerInput("one-too-many"))).toThrow(
      expect.objectContaining({ code: "app_limit_reached" }),
    );
    expect(reg.list()).toHaveLength(MAX_REGISTERED_APPS);
  });
});

describe("app-registry: delete frees the name and the port", () => {
  it("the name and the lowest port are registerable again, across a cold reload", () => {
    const first = make().register(registerInput("hello"));
    const other = make().register(registerInput("other"));
    expect(make().remove("hello")?.name).toBe("hello");
    expect(make().list()).toEqual([other]);

    // Not just in memory: a registry that has never seen the delete happen
    // accepts the name, and the port comes back with it. Allocation reads LIVE
    // ports only, so the gap below `other` is the lowest free one again.
    const second = make().register(registerInput("hello"));
    expect(second.name).toBe("hello");
    expect(second.port).toBe(first.port);
    expect(
      make()
        .list()
        .map((a) => a.name),
    ).toEqual(["other", "hello"]);
  });

  it("remove and update answer null for a name not registered, and change nothing", () => {
    // The route turns null into a 404 when the app goes between its read and
    // its write. A deleted app is not registered: update is no way back in.
    const reg = make();
    reg.register(registerInput("hello"));
    reg.register(registerInput("gone"));
    reg.remove("gone");
    const before = readFileSync(join(dir, "apps.json"), "utf-8");
    expect(reg.remove("ghost")).toBeNull();
    expect(reg.update("ghost", { command: "x" })).toBeNull();
    expect(reg.update("gone", { command: "x" })).toBeNull();
    expect(readFileSync(join(dir, "apps.json"), "utf-8")).toBe(before);
  });

  it("keeps the data directory, and the next app of the same name does NOT inherit it", () => {
    // The data is kept because a delete that silently destroys what the app
    // wrote is unrecoverable. It is MOVED because dataDir is derived from the
    // name and names are claimable by anyone, so leaving it in place would hand
    // one user's files to the next user's app.
    const reg = make();
    const app = reg.register(registerInput("hello"));
    writeFileSync(join(app.dataDir, "state.json"), '{"kept":true}');
    reg.remove("hello");

    const archived = join(
      dir,
      "data",
      ".retired",
      `hello-${1_700_000_000_000}`,
      "state.json",
    );
    expect(readFileSync(archived, "utf-8")).toBe('{"kept":true}');
    expect(existsSync(join(app.dataDir, "state.json"))).toBe(false);

    const reborn = reg.register(registerInput("hello"));
    expect(reborn.dataDir).toBe(app.dataDir); // same derived path...
    expect(existsSync(reborn.dataDir)).toBe(true);
    expect(existsSync(join(reborn.dataDir, "state.json"))).toBe(false); // ...empty
  });

  it("a second delete of the same name never lands on the first archive", () => {
    // The clock is injected and does not move here, which is exactly the case
    // the unique-suffix walk exists for: renaming onto a non-empty directory
    // throws, and onto an empty one it silently replaces kept data.
    const reg = make();
    const app = reg.register(registerInput("hello"));
    writeFileSync(join(app.dataDir, "state.json"), '{"gen":1}');
    reg.remove("hello");

    const again = reg.register(registerInput("hello"));
    writeFileSync(join(again.dataDir, "state.json"), '{"gen":2}');
    reg.remove("hello");

    const retiredRoot = join(dir, "data", ".retired");
    const stamp = 1_700_000_000_000;
    expect(
      readFileSync(join(retiredRoot, `hello-${stamp}`, "state.json"), "utf-8"),
    ).toBe('{"gen":1}');
    expect(
      readFileSync(
        join(retiredRoot, `hello-${stamp}-2`, "state.json"),
        "utf-8",
      ),
    ).toBe('{"gen":2}');
  });

  it("removing an app that never wrote anything is not an error", () => {
    // The archive step has to tolerate a missing directory: it is also the
    // state a retried delete finds after the first attempt moved it.
    const reg = make();
    const app = reg.register(registerInput("hello"));
    rmSync(app.dataDir, { recursive: true, force: true });
    expect(reg.remove("hello")?.name).toBe("hello");
    expect(make().list()).toEqual([]);
  });
});

// A lineage keeps the last address that was issued for its name. A changing
// server-held registration generation separates successive apps at that stable
// origin.
describe("app-registry: hostname labels and the issuance ledger", () => {
  // The ledger as it sits on disk. Read directly rather than through the
  // registry, because "what a future process will believe" is the actual claim.
  const ledgerOnDisk = () =>
    JSON.parse(readFileSync(join(dir, "apps.json"), "utf-8")).issuedLabels;

  it("stamps a first registration with its own name and generation 1", () => {
    const app = make().register(registerInput("hello"));
    expect([app.hostLabel, app.hostGen]).toEqual(["hello", 1]);
    // Through disk, and dated the same instant as the record itself rather than
    // a clock reading of its own.
    expect(ledgerOnDisk()).toEqual([
      {
        label: "hello",
        name: "hello",
        gen: 1,
        issuedAt: app.createdAt,
        certAdmittedAt: app.createdAt,
        registrationGen: 1,
      },
    ]);
    expect(make().get("hello")!.hostLabel).toBe("hello");
  });

  it("a re-registered name keeps its wanted address and changes registration identity", () => {
    const reg = make();
    const first = reg.register(registerInput("hello"));
    reg.remove("hello");
    const second = reg.register(registerInput("hello"));

    expect(second.name).toBe("hello"); // the NAME came back...
    expect(second.hostLabel).toBe("hello");
    expect(second.hostGen).toBe(1);
    expect(second.hostLabel).toBe(first.hostLabel);
    expect(appRegistrationGeneration(second)).toBe(2);
    reg.remove("hello");
    const third = reg.register(registerInput("hello"));
    expect(third.hostLabel).toBe("hello");
    expect(appRegistrationGeneration(third)).toBe(3);

    // The stable address remains on record with the newest server-held
    // registration generation.
    expect(ledgerOnDisk().map((e: { label: string }) => e.label)).toEqual([
      "hello",
    ]);
  });

  it("keeps and reuses the last label a rollback issued, in issuance order", () => {
    const reg = make();
    reg.register(registerInput("hello"));
    reg.remove("hello");
    const raw = JSON.parse(readFileSync(join(dir, "apps.json"), "utf8"));
    // Ten generations, so issuance order (hello-g9 before hello-g10) is not
    // the lexical order of the labels. The lineage address is the LAST row
    // issued, which only the order of the ledger records.
    for (let gen = 2; gen <= 10; gen++) {
      raw.issuedLabels.push({
        label: `hello-g${gen}`,
        name: "hello",
        gen,
        issuedAt: gen,
      });
    }
    writeFileSync(join(dir, "apps.json"), JSON.stringify(raw));
    const issued = raw.issuedLabels.map((row: { label: string }) => row.label);

    const adopted = make().register(registerInput("hello"));
    expect([adopted.hostLabel, adopted.hostGen]).toEqual(["hello-g10", 10]);
    expect(appRegistrationGeneration(adopted)).toBe(11);
    expect(ledgerOnDisk().map((row: { label: string }) => row.label)).toEqual(
      issued,
    );
    make().remove("hello");
    expect(make().register(registerInput("hello")).hostLabel).toBe("hello-g10");
    expect(ledgerOnDisk().map((row: { label: string }) => row.label)).toEqual(
      issued,
    );
  });

  it("refuses to give an identity to a record the registry did not make", () => {
    const reg = make();
    reg.register(registerInput("hello"));
    reg.remove("hello");
    const live = reg.register(registerInput("hello"));
    expect(appRegistrationGeneration(live)).toBe(2);
    // A copy has the same label and generation as the live app, but not its
    // registration. Falling back to hostGen would give it identity 1: the
    // deleted app's, so the deleted app's sessions would match it.
    const copy = { ...live };
    expect(copy.hostGen).toBe(1);
    expect(() => appRegistrationGeneration(copy)).toThrow(/hello/);
    expect(appRegistrationGeneration(reg.get("hello")!)).toBe(2);
  });

  it("never lowers identity when a rollback adds a later public label", () => {
    const app = make().register(registerInput("hello"));
    const raw = JSON.parse(readFileSync(join(dir, "apps.json"), "utf8"));
    raw.apps[0] = {
      ...raw.apps[0],
      hostLabel: "hello-g2",
      hostGen: 2,
    };
    delete raw.apps[0].registrationGen;
    raw.issuedLabels[0].registrationGen = 5;
    raw.issuedLabels.push({
      label: "hello-g2",
      name: "hello",
      gen: 2,
      issuedAt: app.createdAt + 1,
    });
    writeFileSync(join(dir, "apps.json"), JSON.stringify(raw));

    const afterRollback = make().get("hello")!;
    expect([afterRollback.hostLabel, afterRollback.hostGen]).toEqual([
      "hello-g2",
      2,
    ]);
    expect(appRegistrationGeneration(afterRollback)).toBe(5);
    make().remove("hello");
    expect(
      appRegistrationGeneration(make().register(registerInput("hello"))),
    ).toBe(6);
  });

  it("refuses a name that is some OTHER app's retired address", () => {
    const reg = make();
    reg.register(registerInput("hello"));
    reg.remove("hello");
    const raw = JSON.parse(readFileSync(join(dir, "apps.json"), "utf8"));
    raw.issuedLabels.push({
      label: "hello-g2",
      name: "hello",
      gen: 2,
      issuedAt: 2,
    });
    writeFileSync(join(dir, "apps.json"), JSON.stringify(raw));
    make().register(registerInput("hello"));

    expect(() => reg.register(registerInput("hello-g2"))).toThrow(
      expect.objectContaining({ code: "origin_retired" }),
    );
    // Nothing was written by the refusal.
    expect(reg.list().map((a) => a.name)).toEqual(["hello"]);
    expect(existsSync(join(dir, "data", "hello-g2"))).toBe(false);
  });

  it("hydrates a label-less apps.json without writing to it", () => {
    // What every office out there has: an array of records, no labels, no
    // ledger. It loads as generation 1, seeded from what is still live - the
    // most a file that never recorded a deletion can know.
    const legacy = JSON.stringify([
      {
        name: "old",
        port: APP_PORT_MIN,
        command: "bun run serve.ts",
        cwd: "/tmp",
        userId: "u-owner",
        username: "Nil",
        createdBy: "Isomuxer2",
        createdAt: 4242,
      },
    ]);
    writeFileSync(join(dir, "apps.json"), legacy);

    const app = make().get("old")!;
    expect([app.hostLabel, app.hostGen]).toEqual(["old", 1]);
    // A READ wrote nothing: this has to work on a read-only state directory,
    // and reading twice has to give the same answer.
    expect(readFileSync(join(dir, "apps.json"), "utf-8")).toBe(legacy);
    expect(make().get("old")).toEqual(app);

    // The first WRITE persists the envelope, and the hydrated issuance is dated
    // from the app's own creation - the best surviving evidence of when that
    // address started being used.
    make().register(registerInput("new"));
    expect(ledgerOnDisk()).toEqual([
      { label: "old", name: "old", gen: 1, issuedAt: 4242 },
      {
        label: "new",
        name: "new",
        gen: 1,
        issuedAt: make().get("new")!.createdAt,
        certAdmittedAt: make().get("new")!.createdAt,
        registrationGen: 1,
      },
    ]);
    // ...and the legacy app kept its address across the rewrite.
    expect(make().get("old")!.hostLabel).toBe("old");
  });

  it("a name at the DNS limit loads, runs, and can be re-registered", () => {
    const name = "y".repeat(MAX_APP_NAME_LENGTH);
    writeFileSync(
      join(dir, "apps.json"),
      JSON.stringify([
        {
          name,
          port: APP_PORT_MIN,
          command: "bun run serve.ts",
          cwd: "/tmp",
          userId: "u-owner",
          username: "Nil",
          createdBy: "Isomuxer2",
          createdAt: 1,
        },
      ]),
    );
    const reg = make();
    expect(reg.get(name)!.hostLabel).toBe(name);
    expect(reg.remove(name)?.name).toBe(name);
    expect(reg.register(registerInput(name)).hostLabel).toBe(name);
  });
});

describe("app-registry: thumbnail version and archive flag", () => {
  it("persists both, keeps the registration, and removes archived on false", () => {
    const reg = make();
    const app = reg.register(registerInput("hello"));
    const gen = appRegistrationGeneration(app);
    const set = reg.update("hello", { thumbnailUpdatedAt: 5, archived: true });
    expect(set).toMatchObject({ thumbnailUpdatedAt: 5, archived: true });
    expect(appRegistrationGeneration(set!)).toBe(gen);
    const reloaded = make().get("hello")!;
    expect(reloaded).toMatchObject({ thumbnailUpdatedAt: 5, archived: true });
    expect(appRegistrationGeneration(reloaded)).toBe(gen);
    make().update("hello", { archived: false });
    const raw = JSON.parse(readFileSync(join(dir, "apps.json"), "utf8"));
    expect(raw.apps[0]).not.toHaveProperty("archived");
    expect(raw.apps[0].thumbnailUpdatedAt).toBe(5);
  });
});

describe("app-registry: corruption fails LOUD, never empty", () => {
  // A well-formed record, as a base for the per-field damage cases below.
  // Each argument is one record's overrides.
  const legacy = (...overs: Record<string, unknown>[]) =>
    JSON.stringify(
      overs.map((over) => ({
        name: "hello",
        port: APP_PORT_MIN,
        command: "bun run serve.ts",
        cwd: "/tmp",
        userId: "u-owner",
        username: "Nil",
        createdBy: "Isomuxer2",
        createdAt: 1,
        ...over,
      })),
    );
  const good = (over: Record<string, unknown> = {}) => legacy(over);

  // The same record in the CURRENT shape, with the ledger alongside it, so the
  // envelope-only damage cases can be written as one-field mutations too.
  const envelope = (over: Record<string, unknown> = {}, ledger?: unknown) =>
    JSON.stringify({
      apps: [
        {
          name: "hello",
          hostLabel: "hello",
          hostGen: 1,
          port: APP_PORT_MIN,
          command: "bun run serve.ts",
          cwd: "/tmp",
          userId: "u-owner",
          username: "Nil",
          createdBy: "Isomuxer2",
          createdAt: 1,
          ...over,
        },
      ],
      issuedLabels:
        ledger === undefined
          ? [{ label: "hello", name: "hello", gen: 1, issuedAt: 1 }]
          : ledger,
    });

  const cases: [string, string, string][] = [
    ["apps.json", "not JSON at all", "{not json"],
    ["apps.json", "neither an array nor an object", "42"],
    // An envelope with no ledger is DAMAGE, not an old file to be helpfully
    // seeded: no released version ever wrote one, and inventing a ledger for it
    // would forget every origin a deleted app used to hold.
    ["apps.json", "an envelope with no ledger", '{"apps":[]}'],
    ["apps.json", "an envelope with no apps key", '{"issuedLabels":[]}'],
    [
      "apps.json",
      "an envelope whose ledger is not an array",
      envelope({}, { hello: 1 }),
    ],
    // Inside an envelope the host fields are REQUIRED - absence there is not an
    // old file, it is a record something wrote without understanding labels.
    [
      "apps.json",
      "an envelope record with no hostLabel",
      envelope({ hostLabel: undefined }),
    ],
    [
      "apps.json",
      "an envelope record with no hostGen",
      envelope({ hostGen: undefined }),
    ],
    [
      "apps.json",
      "a generation that is not a whole number",
      envelope({ hostGen: 1.5 }),
    ],
    ["apps.json", "a generation of zero", envelope({ hostGen: 0 })],
    // The label has to be the one the name and generation DERIVE, or the record
    // is claiming an address that belongs to some other app's lineage.
    [
      "apps.json",
      "a label that is not the one the name and generation derive",
      envelope({ hostLabel: "elsewhere" }),
    ],
    [
      "apps.json",
      "a ledger row whose label contradicts its own name and generation",
      envelope({}, [{ label: "wat", name: "hello", gen: 1, issuedAt: 1 }]),
    ],
    [
      "apps.json",
      "a ledger row with a non-integer generation",
      envelope({}, [{ label: "hello", name: "hello", gen: 1.5, issuedAt: 1 }]),
    ],
    [
      "apps.json",
      "a ledger row with no issuedAt",
      envelope({}, [{ label: "hello", name: "hello", gen: 1 }]),
    ],
    // A certificate admission is what lets a hostname be served, so a row that
    // does not say plainly when it was admitted is refused rather than read
    // past. Validation, not a trust boundary: anyone who can edit this file can
    // write a plausible admission instead of a malformed one.
    [
      "apps.json",
      "a ledger row whose admission timestamp is not a number",
      envelope({}, [
        {
          label: "hello",
          name: "hello",
          gen: 1,
          issuedAt: 1,
          certAdmittedAt: "soon",
        },
      ]),
    ],
    [
      "apps.json",
      "a ledger row whose admission timestamp is not a whole number",
      envelope({}, [
        {
          label: "hello",
          name: "hello",
          gen: 1,
          issuedAt: 1,
          certAdmittedAt: 1.5,
        },
      ]),
    ],
    [
      "apps.json",
      "a ledger row admitted at a negative time",
      envelope({}, [
        {
          label: "hello",
          name: "hello",
          gen: 1,
          issuedAt: 1,
          certAdmittedAt: -1,
        },
      ]),
    ],
    [
      "apps.json",
      "the same label recorded as issued twice",
      envelope({}, [
        { label: "hello", name: "hello", gen: 1, issuedAt: 1 },
        { label: "hello", name: "hello", gen: 1, issuedAt: 2 },
      ]),
    ],
    // A live app whose issuance is missing: the ledger has lost track of an
    // address that is in use, and the next registration could hand it out.
    [
      "apps.json",
      "a live app that was never issued its label",
      envelope({}, []),
    ],
    // The ambiguity the ledger tuple exists to resolve: `foo-g2` is BOTH what
    // `foo` generation 2 is called and what an app literally named `foo-g2`
    // would be called. Matching a live app on the label alone would accept this
    // file, and it describes an app serving on another lineage's address.
    [
      "apps.json",
      "a live app matching an issued LABEL but not its issuance",
      envelope({ name: "foo-g2", hostLabel: "foo-g2", hostGen: 1 }, [
        { label: "foo-g2", name: "foo", gen: 2, issuedAt: 1 },
      ]),
    ],
    ["apps.json", "truncated write (NOT the same as absent)", ""],
    ["apps.json", "a name that is a path traversal", good({ name: "../etc" })],
    ["apps.json", "a port below the window", good({ port: 22 })],
    ["apps.json", "a port above the window", good({ port: 65000 })],
    ["apps.json", "a non-integer port", good({ port: 21000.5 })],
    ["apps.json", "a relative cwd", good({ cwd: "relative/path" })],
    ["apps.json", "a blank command", good({ command: "   " })],
    ["apps.json", "an over-long command", good({ command: "x".repeat(5000) })],
    ["apps.json", "a missing userId key", good({ userId: undefined })],
    ["apps.json", "a numeric userId", good({ userId: 7 })],
    ["apps.json", "a missing createdBy", good({ createdBy: undefined })],
    ["apps.json", "a NaN createdAt", good({ createdAt: null })],
    ["apps.json", "a non-string description", good({ description: 7 })],
    [
      "apps.json",
      "a non-integer thumbnail version",
      envelope({ thumbnailUpdatedAt: 1.5 }),
    ],
    [
      "apps.json",
      "a string thumbnail version",
      envelope({ thumbnailUpdatedAt: "1" }),
    ],
    ["apps.json", "a non-boolean archived", envelope({ archived: "yes" })],
    // Each record is fine on its own; together they describe a world in which a
    // name or a port gets handed out twice.
    [
      "apps.json",
      "two live apps with the same name",
      legacy({}, { port: APP_PORT_MIN + 1 }),
    ],
    [
      "apps.json",
      "two live apps on the same port",
      legacy({ name: "one" }, { name: "two" }),
    ],
  ];

  for (const [file, why, contents] of cases) {
    it(`${file}: ${why} → registry_corrupt on EVERY op`, () => {
      writeFileSync(join(dir, file), contents);
      const reg = make();
      const corruptCode = expect.objectContaining({ code: "registry_corrupt" });

      // EVERY public operation, reads included. Answering a read off a file the
      // registry cannot vouch for is the subtle version of failing open, and
      // "you have no apps" is the most convincing wrong answer it can give.
      expect(() => reg.list()).toThrow(corruptCode);
      expect(() => reg.get("hello")).toThrow(corruptCode);
      expect(() => reg.register(registerInput("hello"))).toThrow(corruptCode);
      expect(() => reg.update("hello", { command: "x" })).toThrow(corruptCode);
      expect(() => reg.remove("hello")).toThrow(corruptCode);
      // The TLS gate fails closed: no certificate off a file it cannot read.
      expect(() => reg.isLiveHostLabel("hello")).toThrow(corruptCode);

      // And nothing was rewritten: the damaged bytes are still there for a
      // human to look at, rather than replaced by a truncated worldview.
      expect(readFileSync(join(dir, file), "utf-8")).toBe(contents);
    });
  }

  it("a stored dataDir is IGNORED, not trusted - the path is always derived", () => {
    // The strongest form of "never trust a filesystem path from disk": there is
    // no persisted dataDir to tamper with. A hand-edited one (here `/etc`) is
    // simply an unknown extra field, and the app's directory is recomputed from
    // the registry dir and the app's permanent name.
    writeFileSync(join(dir, "apps.json"), good({ dataDir: "/etc" }));
    expect(make().get("hello")!.dataDir).toBe(join(dir, "data", "hello"));
  });

  it("an unknown extra field is forward-compatible, not corruption", () => {
    writeFileSync(join(dir, "apps.json"), good({ futureFieldFromS2: "x" }));
    expect(make().get("hello")!.name).toBe("hello");
  });
});

// The write failure is injected by making the registry directory READ-ONLY, so
// the real atomicWriteFileSync path fails the way it would on a full or
// unwritable disk. Deliberately not by planting a directory where the JSON file
// belongs: that breaks the READ first and proves nothing about writes.
//
// Root ignores the mode bits, so the injection cannot be expressed there. It is
// probed once rather than assumed, and the cases SKIP visibly under root.
const readOnlyIsEnforced = (() => {
  const probe = mkdtempSync(join(realpathSync(tmpdir()), "isomux-apps-ro-"));
  chmodSync(probe, 0o500);
  try {
    writeFileSync(join(probe, ".probe"), "x");
    return false; // the write went through (root) - cannot inject here
  } catch {
    return true;
  } finally {
    chmodSync(probe, 0o700);
    removeStateDir(probe);
  }
})();

describe.skipIf(!readOnlyIsEnforced)(
  "app-registry: persistence failures are never reported as success",
  () => {
    it("register and update raise persist_failed, and nothing changes", () => {
      const reg = make();
      reg.register(registerInput("hello"));
      // Pre-create the data dir so the failure lands on the RECORD write rather
      // than on the mkdir - this is the "we said yes but wrote nothing" case.
      mkdirSync(join(dir, "data", "new"), { recursive: true });
      chmodSync(dir, 0o500);
      try {
        const failed = expect.objectContaining({ code: "persist_failed" });
        expect(() => reg.register(registerInput("new"))).toThrow(failed);
        expect(() =>
          reg.update("hello", { command: "bun run other.ts" }),
        ).toThrow(failed);
      } finally {
        chmodSync(dir, 0o700);
      }
      expect(make().list()).toEqual([
        expect.objectContaining({ name: "hello", command: "bun run serve.ts" }),
      ]);
    });

    it("delete raises persist_failed rather than reporting a delete that did not happen, and the retry converges", () => {
      const reg = make();
      const app = reg.register(registerInput("hello"));
      writeFileSync(join(app.dataDir, "state.json"), '{"kept":true}');
      // Locking the registry dir fails the apps.json write while leaving data/
      // writable, which lands us in the ONE window delete-side archiving creates:
      // the directory has already moved and the record has not gone.
      chmodSync(dir, 0o500);
      try {
        expect(() => reg.remove("hello")).toThrow(
          expect.objectContaining({ code: "persist_failed" }),
        );
      } finally {
        chmodSync(dir, 0o700);
      }
      // Fail CLOSED: the app is still registered, its name and port still
      // accounted for, and the delete is retryable.
      expect(
        make()
          .list()
          .map((a) => a.name),
      ).toEqual(["hello"]);
      // The archive DID happen, and nothing was lost with it - this is the state
      // the window is defended on, so it is asserted rather than assumed.
      const archived = join(
        dir,
        "data",
        ".retired",
        `hello-${1_700_000_000_000}`,
        "state.json",
      );
      expect(readFileSync(archived, "utf-8")).toBe('{"kept":true}');
      expect(existsSync(join(app.dataDir, "state.json"))).toBe(false);

      // And the retry gets all the way out: archiveDataDir returns early now that
      // the source is gone, so the second attempt reaches the record write
      // instead of tripping over its own first attempt. That early return is the
      // whole recovery mechanism.
      expect(reg.remove("hello")?.name).toBe("hello");
      expect(make().list()).toEqual([]);
      // Not re-archived into a second directory, and not overwritten: the one
      // copy still holds the data.
      expect(readFileSync(archived, "utf-8")).toBe('{"kept":true}');
      expect(readdirSync(join(dir, "data", ".retired"))).toEqual([
        `hello-${1_700_000_000_000}`,
      ]);
    });

    it("a delete whose archive step fails does not remove the record", () => {
      const reg = make();
      const app = reg.register(registerInput("hello"));
      writeFileSync(join(app.dataDir, "state.json"), '{"kept":true}');
      // The data ROOT is what the rename needs to write to (both the source entry
      // and the new .retired parent live in it), so locking it fails the archive
      // while apps.json itself is still writable - the ordering case: everything
      // that can fail happens while the app is still registered.
      const dataRoot = join(dir, "data");
      chmodSync(dataRoot, 0o500);
      try {
        expect(() => reg.remove("hello")).toThrow(
          expect.objectContaining({ code: "persist_failed" }),
        );
      } finally {
        chmodSync(dataRoot, 0o700);
      }
      expect(
        make()
          .list()
          .map((a) => a.name),
      ).toEqual(["hello"]);
      // Nothing was lost, and the retry converges.
      expect(readFileSync(join(app.dataDir, "state.json"), "utf-8")).toBe(
        '{"kept":true}',
      );
      expect(reg.remove("hello")?.name).toBe("hello");
      expect(make().list()).toEqual([]);
    });
  },
);

// --- update -----------------------------------------------------------------

// PATCH exists because the alternative to fixing a mistyped command was
// deleting the app, which costs it its port and sets its data directory aside.
// So the tests below care about two things above all: that the patchable fields
// really change and persist, and that NOTHING ELSE does - the name, the port,
// the data directory are fixed for the app's lifetime.
describe("app-registry: update", () => {
  it("changes what the patch names, persists it, and leaves every other field alone", () => {
    const reg = make();
    const original = reg.register(
      registerInput("hello", { description: "before" }),
    );
    const patch = {
      command: "bun run other.ts",
      cwd: "/srv/elsewhere",
      description: "after",
    };

    expect(reg.update("hello", patch)).toEqual({ ...original, ...patch });
    // Through a SECOND registry over the same directory: the return value could
    // be right while the file was not. Identity, ownership, attribution and the
    // derived data directory all survive, because all of it is what the app IS.
    expect(make().get("hello")).toEqual({ ...original, ...patch });
  });

  it("keeps the app's position in the file, so registration order still reads as registration order", () => {
    const reg = make();
    reg.register(registerInput("one"));
    reg.register(registerInput("two"));
    reg.register(registerInput("three"));

    reg.update("two", { command: "bun run two.ts" });

    expect(
      make()
        .list()
        .map((a) => a.name),
    ).toEqual(["one", "two", "three"]);
  });
});

// The TLS ask route issues a certificate only for a label isLiveHostLabel
// accepts. Registration still writes certAdmittedAt, so a rollback to a server
// with the older admission gate finds every live label already admitted.
describe("app-registry: TLS request gate", () => {
  const ledgerOnDisk = () =>
    JSON.parse(readFileSync(join(dir, "apps.json"), "utf-8")).issuedLabels;

  it("old state with no rollback stamp remains live, and a read writes nothing", () => {
    make().register(registerInput("hello"));
    const raw = JSON.parse(readFileSync(join(dir, "apps.json"), "utf8"));
    delete raw.issuedLabels[0].certAdmittedAt;
    writeFileSync(join(dir, "apps.json"), JSON.stringify(raw));
    expect(make().isLiveHostLabel("hello")).toBe(true);
    expect(ledgerOnDisk()[0].certAdmittedAt).toBeUndefined();
  });

  it("refuses a deleted app's label and accepts it again once the name is re-registered", () => {
    const reg = make();
    reg.register(registerInput("app0"));
    reg.register(registerInput("app1"));
    reg.remove("app0");
    // The rollback stamp stays with the retired row.
    expect(ledgerOnDisk()[0].certAdmittedAt).toBe(1_700_000_000_000);
    expect(reg.isLiveHostLabel("app0")).toBe(false);
    expect(reg.isLiveHostLabel("app1")).toBe(true);
    expect(reg.isLiveHostLabel("unknown")).toBe(false);
    // No negative cache: the label is live again with its app.
    expect(reg.register(registerInput("app0")).hostLabel).toBe("app0");
    expect(reg.isLiveHostLabel("app0")).toBe(true);
  });

  it("refuses a label the live app has moved off, even with its ledger row intact", () => {
    make().register(registerInput("hello"));
    // The app is moved onto a later generation by hand - the shape a
    // rollback leaves. `hello` still has a ledger row, and it still gets
    // nothing: the gate follows the LIVE app's label, not any label the ledger
    // remembers.
    const raw = JSON.parse(readFileSync(join(dir, "apps.json"), "utf-8"));
    raw.apps[0].hostGen = 2;
    raw.apps[0].hostLabel = "hello-g2";
    raw.apps[0].registrationGen = 2;
    raw.issuedLabels.push({
      label: "hello-g2",
      name: "hello",
      gen: 2,
      issuedAt: 2,
    });
    writeFileSync(join(dir, "apps.json"), JSON.stringify(raw));
    expect(make().isLiveHostLabel("hello")).toBe(false);
    expect(make().isLiveHostLabel("hello-g2")).toBe(true);
  });
});
