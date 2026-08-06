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
  MAX_APP_COMMAND_LENGTH,
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

describe("app-registry: tombstones (the permanent-retirement invariant)", () => {
  it("delete retires the name for good, across a cold reload", () => {
    make().register(registerInput("hello"));
    const removed = make().remove("hello");
    expect(removed?.name).toBe("hello");
    expect(make().list()).toEqual([]);

    // Not just in memory: a registry that has never seen the delete happen
    // still refuses the name.
    expect(() => make().register(registerInput("hello"))).toThrow(
      expect.objectContaining({ code: "name_retired" }),
    );
    expect(make().retired()).toEqual([
      { name: "hello", port: APP_PORT_MIN, retiredAt: 1_700_000_000_000 },
    ]);
  });

  it("a retired port is never re-issued - the gap stays a gap", () => {
    const reg = make();
    reg.register(registerInput("alpha")); // 21000
    reg.register(registerInput("beta")); // 21001
    reg.remove("alpha"); // frees nothing

    // The naive "lowest free" would hand 21000 straight back to gamma, pointing
    // a stale bookmark for alpha at somebody else's app.
    const gamma = reg.register(registerInput("gamma"));
    expect(gamma.port).toBe(APP_PORT_MIN + 2);
  });

  it("removing an unknown name is a no-op, and tombstones nothing", () => {
    const reg = make();
    expect(reg.remove("ghost")).toBeNull();
    expect(reg.retired()).toEqual([]);
  });

  it("the tombstone is derived from the stored record, not the caller's string", () => {
    // The stored record is the only authority for what gets retired: a lookup
    // that ever matched loosely (case, whitespace) must still burn exactly the
    // name and port that were registered.
    const reg = make();
    const app = reg.register(registerInput("hello"));
    reg.remove("hello");
    expect(reg.retired()).toEqual([
      { name: app.name, port: app.port, retiredAt: 1_700_000_000_000 },
    ]);
  });

  it("delete leaves the app's data directory on disk", () => {
    const reg = make();
    const app = reg.register(registerInput("hello"));
    writeFileSync(join(app.dataDir, "state.json"), '{"kept":true}');
    reg.remove("hello");
    // Deleting a registration must not destroy what the app wrote; the name is
    // never reused, so nothing can land on top of it.
    expect(existsSync(join(app.dataDir, "state.json"))).toBe(true);
  });
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

  const cases: [string, string, string][] = [
    ["apps.json", "not JSON at all", "{not json"],
    ["apps.json", "an object where an array belongs", '{"apps":[]}'],
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
    ["app-history.json", "not JSON at all", "{not json"],
    ["app-history.json", "an array where an object belongs", "[]"],
    [
      "app-history.json",
      "a non-numeric port",
      '{"hello":{"port":"nope","retiredAt":1}}',
    ],
    [
      "app-history.json",
      "a port outside the window",
      '{"hello":{"port":80,"retiredAt":1}}',
    ],
    [
      "app-history.json",
      "a traversal name",
      '{"../etc":{"port":21000,"retiredAt":1}}',
    ],
    ["app-history.json", "a missing retiredAt", '{"hello":{"port":21000}}'],
  ];

  for (const [file, why, contents] of cases) {
    it(`${file}: ${why} → registry_corrupt on EVERY op`, () => {
      writeFileSync(join(dir, file), contents);
      const reg = make();
      const corruptCode = expect.objectContaining({ code: "registry_corrupt" });

      // EVERY public operation, for EITHER file - no conditional on which file
      // this case damaged. Reading one file per operation is the subtle version
      // of failing open: a list() answered off a valid apps.json while the
      // history is unreadable is a worldview the registry cannot vouch for, and
      // "you have no apps" is the most convincing wrong answer it can give.
      expect(() => reg.list()).toThrow(corruptCode);
      expect(() => reg.get("hello")).toThrow(corruptCode);
      expect(() => reg.retired()).toThrow(corruptCode);
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
    // free every retired name and port at once. Pinned so a later tidy-up of
    // the wording cannot quietly reintroduce the advice.
    writeFileSync(join(dir, "app-history.json"), "{not json");
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
    expect(reg.retired()).toEqual([]);
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

    // Two retired names holding the same port.
    writeFileSync(join(dir, "apps.json"), "[]");
    writeFileSync(
      join(dir, "app-history.json"),
      JSON.stringify({
        gone: { port: 21000, retiredAt: 1 },
        alsogone: { port: 21000, retiredAt: 2 },
      }),
    );
    expect(() => make().retired()).toThrow(corruptCode);

    // A live app sitting on a port retired under a DIFFERENT name - the exact
    // recycling this registry exists to prevent.
    writeFileSync(join(dir, "apps.json"), JSON.stringify([rec("live", 21000)]));
    writeFileSync(
      join(dir, "app-history.json"),
      JSON.stringify({ gone: { port: 21000, retiredAt: 1 } }),
    );
    expect(() => make().list()).toThrow(corruptCode);

    // The same name live on one port and retired on another.
    writeFileSync(
      join(dir, "apps.json"),
      JSON.stringify([rec("hello", 21000)]),
    );
    writeFileSync(
      join(dir, "app-history.json"),
      JSON.stringify({ hello: { port: 21001, retiredAt: 1 } }),
    );
    expect(() => make().list()).toThrow(corruptCode);
  });

  it("the partial-delete state (same name, same port, both files) LOADS, and a retry finishes it", () => {
    // This is the state a delete leaves behind when the tombstone write lands
    // and the record removal does not. It is the deliberate fail-closed
    // outcome, so it must stay loadable - otherwise the recovery path (just
    // delete again) would itself be blocked by a corruption error.
    writeFileSync(
      join(dir, "apps.json"),
      JSON.stringify([
        {
          name: "hello",
          port: 21000,
          command: "x",
          cwd: "/tmp",
          userId: "u",
          username: "Nil",
          createdBy: "Isomuxer2",
          createdAt: 1,
        },
      ]),
    );
    writeFileSync(
      join(dir, "app-history.json"),
      JSON.stringify({ hello: { port: 21000, retiredAt: 1 } }),
    );

    const reg = make();
    expect(reg.list().map((a) => a.name)).toEqual(["hello"]);
    // The name is refused while the half-deleted app sits there - as
    // name_taken, because the live record is still there and that check runs
    // first. Which of the two refusals fires is incidental; that the name
    // cannot be re-registered in this state is the property.
    expect(() => reg.register(registerInput("hello"))).toThrow(
      expect.objectContaining({ code: "name_taken" }),
    );
    // And the retry completes the delete.
    expect(reg.remove("hello")?.name).toBe("hello");
    expect(make().list()).toEqual([]);
    // Now the refusal is the permanent one.
    expect(() => make().register(registerInput("hello"))).toThrow(
      expect.objectContaining({ code: "name_retired" }),
    );
    expect(make().retired()).toEqual([
      { name: "hello", port: 21000, retiredAt: 1_700_000_000_000 },
    ]);
  });

  it("a corrupt history cannot let a retired name be re-registered", () => {
    // The scenario the whole posture exists for, end to end.
    const reg = make();
    reg.register(registerInput("hello"));
    reg.remove("hello");
    writeFileSync(join(dir, "app-history.json"), "{corrupted");
    expect(() => make().register(registerInput("hello"))).toThrow(
      expect.objectContaining({ code: "registry_corrupt" }),
    );
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

  it("delete raises persist_failed rather than dropping a record with no tombstone", () => {
    if (!readOnlyIsEnforced(dir)) return; // running as root; see above
    const reg = make();
    reg.register(registerInput("hello"));
    chmodSync(dir, 0o500);
    try {
      expect(() => reg.remove("hello")).toThrow(
        expect.objectContaining({ code: "persist_failed" }),
      );
    } finally {
      chmodSync(dir, 0o700);
    }
    // Fail CLOSED. The tombstone is written FIRST, so a write failure leaves
    // the app still registered - its name and port still accounted for. The
    // reverse order would have dropped the record and freed both forever.
    expect(
      make()
        .list()
        .map((a) => a.name),
    ).toEqual(["hello"]);
    expect(make().retired()).toEqual([]);
  });
});
