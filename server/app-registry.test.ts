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
  allocatePort,
  checkAppName,
  AppRegistryError,
  APP_PORT_MIN,
  MAX_REGISTERED_APPS,
  MAX_APP_NAME_LENGTH,
  MAX_NEW_APP_NAME_LENGTH,
  MAX_APP_COMMAND_LENGTH,
  labelFor,
  allocateLabel,
  RESERVED_APP_NAMES,
  type AppRegistry,
} from "./app-registry.ts";
import type { AppErrorCode } from "../shared/contract-shapes.ts";

let dir: string;
let cwdDir: string;

// Every port reads as free unless a case says otherwise, so allocation is
// deterministic and no test binds a real socket.
const allFree = () => true;

function make(
  overrides: { now?: () => number; probePort?: (p: number) => boolean } = {},
): AppRegistry {
  return createAppRegistry({
    dir,
    now: overrides.now ?? (() => 1_700_000_000_000),
    probePort: overrides.probePort ?? allFree,
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
      "x".repeat(MAX_NEW_APP_NAME_LENGTH),
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
      // A new name stops SHORT of the DNS ceiling, so there is room to append a
      // generation suffix later without outgrowing a hostname label.
      ["x".repeat(MAX_NEW_APP_NAME_LENGTH + 1), "invalid_name"],
      ["x".repeat(MAX_APP_NAME_LENGTH), "invalid_name"],
      ["../etc", "invalid_name"],
      ["www", "reserved_name"],
      ["api", "reserved_name"],
    ];
    for (const [name, code] of bad) {
      expect(checkAppName(name)?.code).toBe(code);
    }
  });

  it("reserves at least the names the design requires", () => {
    for (const n of [
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
    ]) {
      expect(RESERVED_APP_NAMES.has(n)).toBe(true);
    }
  });

  it("register refuses an invalid name before touching disk", () => {
    const reg = make();
    expect(() => reg.register(registerInput("Bad_Name"))).toThrow(
      AppRegistryError,
    );
    expect(existsSync(join(dir, "apps.json"))).toBe(false);
  });
});

describe("app-registry: port allocation", () => {
  it("hands out the lowest free port in the window", () => {
    expect(allocatePort(new Set(), allFree)).toBe(APP_PORT_MIN);
    expect(allocatePort(new Set([APP_PORT_MIN]), allFree)).toBe(
      APP_PORT_MIN + 1,
    );
    expect(
      allocatePort(new Set([APP_PORT_MIN, APP_PORT_MIN + 1]), allFree),
    ).toBe(APP_PORT_MIN + 2);
  });

  it("skips a port that is occupied on the box but unknown to the registry", () => {
    const busy = APP_PORT_MIN;
    expect(allocatePort(new Set(), (p) => p !== busy)).toBe(APP_PORT_MIN + 1);
  });

  it("propagates an unexpected probe error instead of reading it as 'busy'", () => {
    // A probe that fails for a reason other than EADDRINUSE/EACCES is a bug or
    // a broken box. Treating it as "port taken" would silently scan the whole
    // range and report it exhausted - a wrong answer dressed as a real one.
    const boom = new Error("probe exploded");
    expect(() =>
      allocatePort(new Set(), () => {
        throw boom;
      }),
    ).toThrow("probe exploded");
  });

  it("exhaustion raises no_port_available", () => {
    expect(() => allocatePort(new Set(), () => false)).toThrow(
      expect.objectContaining({ code: "no_port_available" }),
    );
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

  it("stores the command VERBATIM, whitespace and all", () => {
    // Whitespace can be load-bearing inside a shell command, and the pickup
    // locks "stored verbatim" - so the registry must not helpfully tidy it.
    const command = '  bun run serve.ts --flag="a  b" \t';
    const reg = make();
    const app = reg.register(registerInput("verbatim", { command }));
    expect(app.command).toBe(command);
    // Through disk, not just in the return value.
    expect(make().get("verbatim")!.command).toBe(command);
  });

  it("applies the command length limit to what was SUBMITTED, not to a trimmed copy", () => {
    // A command that only fits after trimming is still over the limit: the
    // limit exists to bound what gets persisted, and what gets persisted is the
    // raw string.
    const reg = make();
    const padded = " ".repeat(50) + "x".repeat(MAX_APP_COMMAND_LENGTH) + " ";
    expect(() =>
      reg.register(registerInput("padded", { command: padded })),
    ).toThrow(expect.objectContaining({ code: "invalid_command" }));
  });

  it("preserves an empty description rather than normalizing it away", () => {
    const reg = make();
    expect(
      reg.register(registerInput("blank", { description: "" })).description,
    ).toBe("");
    expect(make().get("blank")!.description).toBe("");
    // An ABSENT description stays absent - not coerced to "".
    reg.register(registerInput("absent"));
    expect(make().get("absent")!.description).toBeUndefined();
  });

  it("refuses an empty command, an over-long command, and a relative cwd", () => {
    const reg = make();
    expect(() => reg.register(registerInput("a", { command: "   " }))).toThrow(
      expect.objectContaining({ code: "invalid_command" }),
    );
    expect(() =>
      reg.register(registerInput("a", { command: "x".repeat(5000) })),
    ).toThrow(expect.objectContaining({ code: "invalid_command" }));
    expect(() =>
      reg.register(registerInput("a", { cwd: "relative/path" })),
    ).toThrow(expect.objectContaining({ code: "invalid_cwd" }));
    expect(() =>
      reg.register(registerInput("a", { description: "d".repeat(500) })),
    ).toThrow(expect.objectContaining({ code: "invalid_description" }));
  });

  it("enforces the sanity cap", () => {
    const reg = make();
    for (let i = 0; i < MAX_REGISTERED_APPS; i++)
      reg.register(registerInput(`app-${i}`));
    expect(() => reg.register(registerInput("one-too-many"))).toThrow(
      expect.objectContaining({ code: "app_limit_reached" }),
    );
    expect(reg.list()).toHaveLength(MAX_REGISTERED_APPS);
  });
});

describe("app-registry: delete frees the name and the port", () => {
  it("the name is registerable again, across a cold reload", () => {
    const first = make().register(registerInput("hello"));
    expect(make().remove("hello")?.name).toBe("hello");
    expect(make().list()).toEqual([]);

    // Not just in memory: a registry that has never seen the delete happen
    // accepts the name, and the port comes back with it (it is the lowest
    // free one again).
    const second = make().register(registerInput("hello"));
    expect(second.name).toBe("hello");
    expect(second.port).toBe(first.port);
    expect(
      make()
        .list()
        .map((a) => a.name),
    ).toEqual(["hello"]);
  });

  it("a deleted app's port is re-issued - the gap closes", () => {
    const reg = make();
    reg.register(registerInput("alpha")); // 21000
    reg.register(registerInput("beta")); // 21001
    reg.remove("alpha");

    // Lowest free, and 21000 is free again. This is the half of the ruling the
    // name test cannot see: allocation reads LIVE ports only.
    expect(reg.register(registerInput("gamma")).port).toBe(APP_PORT_MIN);
  });

  it("removing an unknown name is a no-op", () => {
    const reg = make();
    reg.register(registerInput("hello"));
    expect(reg.remove("ghost")).toBeNull();
    expect(reg.list().map((a) => a.name)).toEqual(["hello"]);
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

// The slice-1 subject: a name is what a human types, a LABEL is what a browser
// keys security state to, and those two have to come apart the moment a name is
// reused. Every test below is written against the consequence - the successor
// never lands on the predecessor's address - rather than against the mechanism.
describe("app-registry: hostname labels and the issuance ledger", () => {
  // The ledger as it sits on disk. Read directly rather than through the
  // registry, because "what a future process will believe" is the actual claim.
  const ledgerOnDisk = () =>
    JSON.parse(readFileSync(join(dir, "apps.json"), "utf-8")).issuedLabels;

  it("derives generation labels: gen 1 is the bare name, later ones are suffixed", () => {
    expect(labelFor("hello", 1)).toBe("hello");
    expect(labelFor("hello", 2)).toBe("hello-g2");
    expect(labelFor("hello", 17)).toBe("hello-g17");
  });

  it("walks to the first label the ledger has never issued", () => {
    expect(allocateLabel("hello", new Set())).toEqual({
      label: "hello",
      gen: 1,
    });
    expect(allocateLabel("hello", new Set(["hello"]))).toEqual({
      label: "hello-g2",
      gen: 2,
    });
    // A candidate can be taken for an unrelated reason - here `hello-g2` was
    // issued to an app literally NAMED that - and the walk simply steps over it.
    expect(allocateLabel("hello", new Set(["hello", "hello-g2"]))).toEqual({
      label: "hello-g3",
      gen: 3,
    });
  });

  it("refuses rather than emitting a label too long to be a hostname", () => {
    // A name at the registration limit survives 98 recycles; the 99th has
    // nowhere left to go inside one DNS label, and the honest answer is to say
    // so rather than hand out an address that cannot resolve.
    const name = "x".repeat(MAX_NEW_APP_NAME_LENGTH);
    const issued = new Set<string>([name]);
    for (let gen = 2; gen <= 99; gen++) issued.add(labelFor(name, gen));
    expect(labelFor(name, 99).length).toBe(MAX_APP_NAME_LENGTH);
    expect(() => allocateLabel(name, issued)).toThrow(
      expect.objectContaining({ code: "no_label_available" }),
    );
  });

  it("stamps a first registration with its own name and generation 1", () => {
    const app = make().register(registerInput("hello"));
    expect([app.hostLabel, app.hostGen]).toEqual(["hello", 1]);
    // Through disk, and dated the same instant as the record itself rather than
    // a clock reading of its own.
    expect(ledgerOnDisk()).toEqual([
      { label: "hello", name: "hello", gen: 1, issuedAt: app.createdAt },
    ]);
    expect(make().get("hello")!.hostLabel).toBe("hello");
  });

  it("a re-registered name gets a DIFFERENT address, and the old one stays spoken for", () => {
    // The whole point of the slice. A browser that talked to the first `hello`
    // can still be holding its service worker and storage for that origin; the
    // second `hello` must not be served there.
    const reg = make();
    const first = reg.register(registerInput("hello"));
    reg.remove("hello");
    const second = reg.register(registerInput("hello"));

    expect(second.name).toBe("hello"); // the NAME came back...
    expect(second.hostLabel).toBe("hello-g2"); // ...the ADDRESS did not
    expect(second.hostGen).toBe(2);
    expect(second.hostLabel).not.toBe(first.hostLabel);
    // And a third generation keeps walking rather than reusing either.
    reg.remove("hello");
    expect(reg.register(registerInput("hello")).hostLabel).toBe("hello-g3");

    // Both retired addresses are still on record, so no future registration -
    // in this process or any later one - can be handed them.
    expect(ledgerOnDisk().map((e: { label: string }) => e.label)).toEqual([
      "hello",
      "hello-g2",
      "hello-g3",
    ]);
  });

  it("the ledger outlives the process, not just the registry object", () => {
    make().register(registerInput("hello"));
    make().remove("hello");
    // A COLD registry over the same directory: the label walk is answered from
    // the file, so it cannot depend on anything held in memory.
    expect(make().register(registerInput("hello")).hostLabel).toBe("hello-g2");
  });

  it("deleting an app never prunes its issuance, and an update never touches the ledger", () => {
    const reg = make();
    reg.register(registerInput("hello"));
    const before = ledgerOnDisk();
    reg.update("hello", { command: "bun run other.ts" });
    expect(ledgerOnDisk()).toEqual(before);
    reg.remove("hello");
    expect(ledgerOnDisk()).toEqual(before);
  });

  it("refuses a name that is some OTHER app's retired address", () => {
    const reg = make();
    reg.register(registerInput("hello"));
    reg.remove("hello");
    reg.register(registerInput("hello")); // now `hello-g2` is issued, to `hello`

    expect(() => reg.register(registerInput("hello-g2"))).toThrow(
      expect.objectContaining({ code: "origin_retired" }),
    );
    // Nothing was written by the refusal.
    expect(reg.list().map((a) => a.name)).toEqual(["hello"]);
    expect(existsSync(join(dir, "data", "hello-g2"))).toBe(false);
  });

  it("a name colliding with its OWN earlier generations is the ordinary recycle path", () => {
    // The refusal above must be narrow: `hello`'s gen-1 label IS `hello`, so a
    // rule phrased as "any previously issued label" would make a name
    // unusable after its first delete - the exact case this feature is for.
    const reg = make();
    reg.register(registerInput("hello"));
    reg.remove("hello");
    expect(() => reg.register(registerInput("hello"))).not.toThrow();
  });

  it("a live app's name is still refused as name_taken, not origin_retired", () => {
    const reg = make();
    reg.register(registerInput("hello"));
    expect(() => reg.register(registerInput("hello"))).toThrow(
      expect.objectContaining({ code: "name_taken" }),
    );
  });

  it("a name at the registration limit still fits a suffix at the DNS ceiling", () => {
    const name = "x".repeat(MAX_NEW_APP_NAME_LENGTH);
    const reg = make();
    reg.register(registerInput(name));
    reg.remove(name);
    const second = reg.register(registerInput(name));
    expect(second.hostLabel).toBe(`${name}-g2`);
    expect(second.hostLabel.length).toBeLessThanOrEqual(MAX_APP_NAME_LENGTH);
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
      },
    ]);
    // ...and the legacy app kept its address across the rewrite.
    expect(make().get("old")!.hostLabel).toBe("old");
  });

  it("a grandfathered over-long name loads, runs, and cannot be re-registered", () => {
    // 63 characters was legal before this slice. Such a record must keep
    // working; what it cannot do is come back after a delete, because a new
    // registration has to leave room for a generation suffix.
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
    expect(() => reg.register(registerInput(name))).toThrow(
      expect.objectContaining({ code: "invalid_name" }),
    );
  });
});

describe("app-registry: a legacy app-history.json is ignored", () => {
  // Deletes used to write tombstones there. The file is never read, never
  // written and never deleted, so an office that upgrades into this ruling just
  // gets its old names and ports back.
  for (const [why, contents] of [
    ["a well-formed tombstone", '{"hello":{"port":21000,"retiredAt":1}}'],
    // The load-bearing case: anything that PARSED it - even to reject it -
    // would fail here rather than register.
    ["bytes that are not JSON at all", "{not json"],
  ] as const) {
    it(`${why}: the name and the port are both available`, () => {
      writeFileSync(join(dir, "app-history.json"), contents);
      const app = make().register(registerInput("hello"));
      expect(app.name).toBe("hello");
      expect(app.port).toBe(APP_PORT_MIN);
      // And it is left exactly as it was found.
      expect(readFileSync(join(dir, "app-history.json"), "utf-8")).toBe(
        contents,
      );
    });
  }
});

describe("app-registry: corruption fails LOUD, never empty", () => {
  // A well-formed record, as a base for the per-field damage cases below.
  const good = (over: Record<string, unknown> = {}) =>
    JSON.stringify([
      {
        name: "hello",
        port: APP_PORT_MIN,
        command: "bun run serve.ts",
        cwd: "/tmp",
        userId: "u-owner",
        username: "Nil",
        createdBy: "Isomuxer2",
        createdAt: 1,
        ...over,
      },
    ]);

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
    ["apps.json", "record missing everything but a name", '[{"name":"hello"}]'],
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
      expect(() => reg.remove("hello")).toThrow(corruptCode);

      // And nothing was rewritten: the damaged bytes are still there for a
      // human to look at, rather than replaced by a truncated worldview.
      expect(readFileSync(join(dir, file), "utf-8")).toBe(contents);
    });
  }

  it("the corruption error never advises moving the file aside", () => {
    // The message is recovery INSTRUCTIONS, so its content is load-bearing:
    // "move it aside" is the reflex for a corrupt state file and is exactly
    // wrong here, because a missing file reads as a fresh registry - it would
    // hand out names and ports that live apps are still serving on. Pinned so a
    // later tidy-up of the wording cannot quietly reintroduce the advice.
    writeFileSync(join(dir, "apps.json"), "{not json");
    let message = "";
    try {
      make().list();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("Do not delete it or move it aside");
    // ...and not the shape that RECOMMENDS it (the round-2 review finding).
    expect(message).not.toMatch(/repair or move/i);
  });

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

  it("a MISSING file is legitimately empty (a fresh office is not corrupt)", () => {
    const reg = make();
    expect(reg.list()).toEqual([]);
    expect(reg.get("hello")).toBeNull();
  });

  it("rejects an impossible SET of individually well-formed records", () => {
    // Each record below is fine on its own; together they describe a world that
    // cannot exist, which is exactly the state in which a name or a port gets
    // handed out twice.
    const rec = (name: string, port: number) => ({
      name,
      port,
      command: "x",
      cwd: "/tmp",
      userId: "u",
      username: "Nil",
      createdBy: "Isomuxer2",
      createdAt: 1,
    });
    const corruptCode = expect.objectContaining({ code: "registry_corrupt" });

    // Two live apps with the same name.
    writeFileSync(
      join(dir, "apps.json"),
      JSON.stringify([rec("hello", 21000), rec("hello", 21001)]),
    );
    expect(() => make().list()).toThrow(corruptCode);

    // Two live apps on the same port.
    writeFileSync(
      join(dir, "apps.json"),
      JSON.stringify([rec("one", 21000), rec("two", 21000)]),
    );
    expect(() => make().list()).toThrow(corruptCode);
  });
});

// The write failure is injected by making the registry directory READ-ONLY, so
// the real atomicWriteFileSync path fails the way it would on a full or
// unwritable disk. Deliberately not by planting a directory where the JSON file
// belongs: that breaks the READ first and proves nothing about writes.
//
// Root ignores the mode bits, so the injection cannot be expressed there. It is
// checked rather than assumed - a silently-passing test is worse than a skipped
// one.
function readOnlyIsEnforced(target: string): boolean {
  chmodSync(target, 0o500);
  try {
    writeFileSync(join(target, ".probe"), "x");
    rmSync(join(target, ".probe"), { force: true });
    return false; // the write went through (root) - cannot inject here
  } catch {
    return true;
  } finally {
    chmodSync(target, 0o700);
  }
}

describe("app-registry: persistence failures are never reported as success", () => {
  it("register raises persist_failed, and the app is NOT registered", () => {
    if (!readOnlyIsEnforced(dir)) return; // running as root; see above
    const reg = make();
    // Pre-create the data dir so the failure lands on the RECORD write rather
    // than on the mkdir - this is the "we said yes but wrote nothing" case.
    mkdirSync(join(dir, "data", "hello"), { recursive: true });
    chmodSync(dir, 0o500);
    try {
      expect(() => reg.register(registerInput("hello"))).toThrow(
        expect.objectContaining({ code: "persist_failed" }),
      );
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(make().list()).toEqual([]);
  });

  it("delete raises persist_failed rather than reporting a delete that did not happen, and the retry converges", () => {
    if (!readOnlyIsEnforced(dir)) return; // running as root; see above
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
    if (!readOnlyIsEnforced(dir)) return; // running as root; see above
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
});

// --- update -----------------------------------------------------------------

// PATCH exists because the alternative to fixing a mistyped command was
// deleting the app, which costs it its port and sets its data directory aside.
// So the tests below care about two things above all: that the patchable fields
// really change and persist, and that NOTHING ELSE does - the name, the port,
// the data directory and the creation attribution are the app's identity.
describe("app-registry: update", () => {
  it("changes command, cwd and description, and persists them", () => {
    const reg = make();
    reg.register(registerInput("hello", { description: "before" }));

    const updated = reg.update("hello", {
      command: "bun run other.ts",
      cwd: "/srv/elsewhere",
      description: "after",
    });
    expect(updated).toMatchObject({
      command: "bun run other.ts",
      cwd: "/srv/elsewhere",
      description: "after",
    });
    // Through a SECOND registry over the same directory: the return value could
    // be right while the file was not.
    expect(make().get("hello")).toMatchObject({
      command: "bun run other.ts",
      cwd: "/srv/elsewhere",
      description: "after",
    });
  });

  it("leaves every field the patch does not name alone", () => {
    const reg = make();
    const original = reg.register(
      registerInput("hello", { description: "keep me" }),
    );

    reg.update("hello", { command: "bun run other.ts" });

    const after = make().get("hello")!;
    // Identity, ownership, attribution, and the derived data directory: all of
    // it survives, because all of it is what the app IS.
    expect(after).toEqual({ ...original, command: "bun run other.ts" });
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

  it("answers null for a name nobody registered, and writes nothing", () => {
    const reg = make();
    reg.register(registerInput("hello"));

    expect(reg.update("nope", { command: "x" })).toBeNull();
    expect(make().get("hello")!.command).toBe("bun run serve.ts");
  });

  it("does not resurrect a deleted app", () => {
    const reg = make();
    reg.register(registerInput("hello"));
    reg.remove("hello");

    // Update is not a way back in: re-registering is.
    expect(reg.update("hello", { command: "x" })).toBeNull();
    expect(make().list()).toEqual([]);
  });

  it("applies the same refusals register does", () => {
    const reg = make();
    reg.register(registerInput("hello"));

    const refusals: [Record<string, unknown>, AppErrorCode][] = [
      [{ command: "   " }, "invalid_command"],
      [{ command: "x".repeat(MAX_APP_COMMAND_LENGTH + 1) }, "invalid_command"],
      [{ cwd: "relative/path" }, "invalid_cwd"],
      [{ description: "d".repeat(201) }, "invalid_description"],
    ];
    for (const [patch, code] of refusals) {
      expect(() => reg.update("hello", patch)).toThrow(
        expect.objectContaining({ code }),
      );
    }
    // Every one of them was refused BEFORE anything was written.
    expect(make().get("hello")!.command).toBe("bun run serve.ts");
  });

  it("treats absent, empty and null description as three different answers", () => {
    const reg = make();
    reg.register(registerInput("hello", { description: "original" }));

    // Absent: untouched.
    expect(reg.update("hello", { command: "a" })!.description).toBe("original");
    // Empty string: a present, empty value - not the same as having none.
    const emptied = reg.update("hello", { description: "" })!;
    expect(emptied.description).toBe("");
    expect("description" in emptied).toBe(true);
    expect("description" in make().get("hello")!).toBe(true);
    // Null: the field is gone, on the record and on disk.
    const cleared = reg.update("hello", { description: null })!;
    expect("description" in cleared).toBe(false);
    expect("description" in make().get("hello")!).toBe(false);
  });

  it("refuses to update on a corrupt registry rather than writing over it", () => {
    const reg = make();
    reg.register(registerInput("hello"));
    const damaged = "{ this is not json";
    writeFileSync(join(dir, "apps.json"), damaged);

    expect(() => reg.update("hello", { command: "x" })).toThrow(
      expect.objectContaining({ code: "registry_corrupt" }),
    );
    // The damaged bytes are still there for a human to look at, rather than
    // replaced by a one-record file built from a worldview that never loaded.
    expect(readFileSync(join(dir, "apps.json"), "utf-8")).toBe(damaged);
  });

  it("raises persist_failed rather than reporting a change that was not written", () => {
    if (!readOnlyIsEnforced(dir)) return; // running as root; see above
    const reg = make();
    reg.register(registerInput("hello"));
    chmodSync(dir, 0o500);
    try {
      expect(() =>
        reg.update("hello", { command: "bun run other.ts" }),
      ).toThrow(expect.objectContaining({ code: "persist_failed" }));
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(make().get("hello")!.command).toBe("bun run serve.ts");
  });
});
