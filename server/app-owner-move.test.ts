// The apps an agent made when its manager changes (task cf032293). The
// properties:
// - each app the agent made that the old manager owns moves, except those a
//   host move keeps; apps of other agents and of a third member stay;
// - only an app whose record names the new manager afterwards loses its
//   grants, in the old manager's secrets only, so an update that fails or
//   does nothing leaves that app with the old manager and its secrets;
// - each moved app and each secret it lost is a target of the manager
//   change's audit row;
// - an agent with no manager has no member secrets to release.
import { describe, expect, it } from "bun:test";

import { moveAgentApps, type AppOwnerMoveDeps } from "./app-owner-move.ts";
import type { AppRecord } from "../shared/types.ts";
import type { AppGrant } from "./secret-store.ts";

const AGENT = "agent-maker";
const ALICE = "u-alice";
const BEA = { id: "u-bea", name: "Bea" };

const record = (
  name: string,
  createdAt: number,
  over: Partial<AppRecord> = {},
): AppRecord => ({
  name,
  hostLabel: name,
  hostGen: 1,
  port: 21000 + createdAt,
  command: "bun run serve.ts",
  cwd: "/srv/app",
  dataDir: `/srv/data/${name}`,
  userId: ALICE,
  username: "Alice",
  createdBy: "Maker",
  createdAt,
  createdByAgentId: AGENT,
  ...over,
});

// A registry and a secret store in memory. `fail` names apps whose update
// throws; `ignore` names apps whose update returns without a change.
function world(
  apps: AppRecord[],
  secretsOf: Record<string, string[]> = {},
  opts: {
    fail?: string[];
    ignore?: string[];
    releaseThrows?: boolean;
  } = {},
) {
  const live = apps.map((a) => ({ ...a }));
  const released: { userId: string; grant: AppGrant }[] = [];
  const targets: string[] = [];
  const logs: string[] = [];
  const deps: AppOwnerMoveDeps = {
    listApps: () => live.map((a) => ({ ...a })),
    updateOwner: (name, owner) => {
      if (opts.fail?.includes(name)) throw new Error(`disk full at ${name}`);
      if (opts.ignore?.includes(name)) return;
      const app = live.find((a) => a.name === name);
      if (!app) throw new Error(`no app ${name}`);
      app.userId = owner.userId;
      app.username = owner.username;
    },
    releaseApp: (userId, grant) => {
      if (opts.releaseThrows) throw new Error("unreadable");
      released.push({ userId, grant });
      return secretsOf[grant.name] ?? [];
    },
    noteTarget: (id) => targets.push(id),
    log: (line) => logs.push(line),
  };
  const ownerOf = (name: string) =>
    live.find((a) => a.name === name)?.userId ?? "missing";
  return { deps, released, targets, logs, ownerOf };
}

const names = (apps: { name: string }[]) => apps.map((a) => a.name).sort();

describe("moveAgentApps", () => {
  it("moves the agent's apps the old manager owns, except kept ones, and releases only the moved apps' grants in the old manager's secrets", () => {
    const w = world(
      [
        record("feed", 1),
        record("hook", 2),
        record("kept", 3),
        // Another agent's app, and the agent's app a third member owns.
        record("theirs", 4, { createdByAgentId: "agent-other" }),
        record("cleos", 5, { userId: "u-cleo", username: "Cleo" }),
        // Alice's own app.
        record("mine", 6, { createdByAgentId: undefined }),
      ],
      { feed: ["FEED_KEY", "FEED_HOSTED"], hook: [], kept: ["KEPT_KEY"] },
    );
    const result = moveAgentApps(w.deps, {
      agentId: AGENT,
      from: ALICE,
      to: BEA,
      keepApps: new Set(["kept"]),
    });

    expect(names(result.moved)).toEqual(["feed", "hook"]);
    expect(
      ["feed", "hook", "kept", "theirs", "cleos", "mine"].map(w.ownerOf),
    ).toEqual(["u-bea", "u-bea", ALICE, ALICE, "u-cleo", ALICE]);
    expect(
      [...w.released].sort((a, b) => a.grant.name.localeCompare(b.grant.name)),
    ).toEqual([
      { userId: ALICE, grant: { name: "feed", createdAt: 1 } },
      { userId: ALICE, grant: { name: "hook", createdAt: 2 } },
    ]);
    expect(
      [...result.released].sort((a, b) => a.app.localeCompare(b.app)),
    ).toEqual([
      { app: "feed", names: ["FEED_KEY", "FEED_HOSTED"] },
      { app: "hook", names: [] },
    ]);
    expect([...w.targets].sort()).toEqual(
      ["FEED_HOSTED", "FEED_KEY", "feed", "hook"].sort(),
    );
  });

  it("releases nothing for an app whose update threw or changed nothing; the others still move and release", () => {
    const w = world(
      [record("first", 1), record("broken", 2), record("idle", 3)],
      { first: ["FIRST_KEY"], broken: ["BROKEN_KEY"], idle: ["IDLE_KEY"] },
      { fail: ["broken"], ignore: ["idle"] },
    );
    // A throw from the update does not escape.
    const result = moveAgentApps(w.deps, {
      agentId: AGENT,
      from: ALICE,
      to: BEA,
      keepApps: new Set(),
    });

    // The move reached the first app, and not the other two.
    expect(["first", "broken", "idle"].map(w.ownerOf)).toEqual([
      "u-bea",
      ALICE,
      ALICE,
    ]);
    expect(names(result.moved)).toEqual(["first"]);
    expect(w.released).toEqual([
      { userId: ALICE, grant: { name: "first", createdAt: 1 } },
    ]);
    expect(result.released).toEqual([{ app: "first", names: ["FIRST_KEY"] }]);
    expect(w.targets).not.toContain("broken");
    expect(w.targets).not.toContain("BROKEN_KEY");
    expect(w.targets).not.toContain("IDLE_KEY");
    // The failure is logged with the app it stopped.
    expect(w.logs.some((line) => line.includes("broken"))).toBe(true);
  });

  it("an agent with no manager: its unowned apps move, and no member's secrets are touched", () => {
    const w = world([
      record("loose", 1, { userId: null, username: null }),
      record("alices", 2),
    ]);
    const result = moveAgentApps(w.deps, {
      agentId: AGENT,
      from: null,
      to: BEA,
      keepApps: new Set(),
    });
    expect(names(result.moved)).toEqual(["loose"]);
    expect(["loose", "alices"].map(w.ownerOf)).toEqual(["u-bea", ALICE]);
    expect(w.released).toEqual([]);
    expect(result.released).toEqual([]);
  });

  it("a secret store that cannot be read: the apps still move, no names are claimed, and it is logged", () => {
    const w = world([record("feed", 1)], {}, { releaseThrows: true });
    const result = moveAgentApps(w.deps, {
      agentId: AGENT,
      from: ALICE,
      to: BEA,
      keepApps: new Set(),
    });
    expect(names(result.moved)).toEqual(["feed"]);
    expect(w.ownerOf("feed")).toBe("u-bea");
    expect(result.released.flatMap((r) => r.names)).toEqual([]);
    expect(w.logs.length).toBeGreaterThan(0);
  });
});
