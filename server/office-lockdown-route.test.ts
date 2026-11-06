// The lockdown route's steps (task cdd7883d, slice 4), through
// lockOfficeFromRoute on a temp state root. The route test
// (server/test-support/office-rescue-routes.test.ts) owns who may call it and
// what the office answers afterwards; this file owns the order of the steps,
// the reason rules, and the stop that comes after the answer.

import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AuditActor } from "../shared/audit.ts";
import { LOCK_MARKER_FILE } from "./lockdown.ts";
import { officeLockedNow, resetOfficeLockGate } from "./office-lock-gate.ts";
import {
  LOCKDOWN_REASON_MAX,
  lockOfficeFromRoute,
  type OfficeLockdownDeps,
} from "./office-lockdown-route.ts";

const NOW = new Date("2026-11-06T10:00:00.000Z");
const ACTOR: AuditActor = { kind: "member", id: "u1", name: "Ann" };
// The stop comes "a short delay after the response"; this is the most the
// tests wait for it, and the window in which a refused call must not stop.
const STOP_BUDGET_MS = 1_500;

let dir = "";
afterEach(() => {
  resetOfficeLockGate();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

interface Bed {
  stateRoot: string;
  deps: OfficeLockdownDeps;
  // What the deps saw, in order.
  events: string[];
  audits: { actor: AuditActor; reason: string }[];
  stops: () => number;
}

function bed(overrides: Partial<OfficeLockdownDeps> = {}): Bed {
  dir = mkdtempSync(join(tmpdir(), "office-lockdown-route-"));
  const stateRoot = join(dir, ".isomux");
  mkdirSync(stateRoot, { mode: 0o700 });
  const events: string[] = [];
  const audits: { actor: AuditActor; reason: string }[] = [];
  let stops = 0;
  const marker = join(stateRoot, LOCK_MARKER_FILE);
  const deps: OfficeLockdownDeps = {
    stateRoot,
    closeSockets: () => {
      // The marker is on disk and the gate is set before a socket closes:
      // a client that reconnects at once must meet the lock.
      events.push(
        `sockets marker=${existsSync(marker)} locked=${officeLockedNow()}`,
      );
    },
    audit: (input) => {
      events.push("audit");
      audits.push(input);
    },
    requestStop: () => {
      events.push("stop");
      stops++;
    },
    now: () => NOW,
    ...overrides,
  };
  return { stateRoot, deps, events, audits, stops: () => stops };
}

async function waitForStops(b: Bed, count: number): Promise<void> {
  const deadline = performance.now() + STOP_BUDGET_MS;
  while (b.stops() < count && performance.now() < deadline) await Bun.sleep(10);
}

test("a lock writes the marker, sets the gate, closes the sockets, audits, and stops the process once, after it returns", async () => {
  const b = bed();
  const result = lockOfficeFromRoute(b.deps, {
    reason: "  leaked token in a chat  ",
    by: "Ann",
    actor: ACTOR,
  });

  expect(result).toEqual({ ok: true });
  // The stop waits for the answer to go out: nothing stopped yet.
  expect(b.events).toEqual(["sockets marker=true locked=true", "audit"]);
  expect(officeLockedNow()).toBe(true);
  // The marker as the host command writes it (lockMarkerBody), reason
  // trimmed, so `rescue status` and the boot gate read it the same way.
  expect(
    JSON.parse(readFileSync(join(b.stateRoot, LOCK_MARKER_FILE), "utf8")),
  ).toEqual({
    since: NOW.toISOString(),
    reason: "leaked token in a chat",
    by: "Ann",
    stateRoot: resolve(b.stateRoot),
  });
  expect(b.audits).toEqual([
    { actor: ACTOR, reason: "leaked token in a chat" },
  ]);

  await waitForStops(b, 1);
  expect(b.events).toEqual([
    "sockets marker=true locked=true",
    "audit",
    "stop",
  ]);
  // Once: a second timer or a retry would SIGTERM the process twice, and a
  // second signal skips the stop hooks (server-stop.ts).
  await Bun.sleep(200);
  expect(b.stops()).toBe(1);
});

test("an audit write that throws does not undo or hold the lock: the answer is ok and the process still stops", async () => {
  const b = bed({
    audit: () => {
      throw new Error("database is locked");
    },
  });
  const result = lockOfficeFromRoute(b.deps, {
    reason: "intrusion",
    by: "Ann",
    actor: ACTOR,
  });

  expect(result).toEqual({ ok: true });
  expect(officeLockedNow()).toBe(true);
  expect(existsSync(join(b.stateRoot, LOCK_MARKER_FILE))).toBe(true);
  await waitForStops(b, 1);
  expect(b.stops()).toBe(1);
});

test("the reason: trimmed, 1 to LOCKDOWN_REASON_MAX characters, a string; anything else is 422 and changes nothing", async () => {
  // The longest reason passes, with spaces around it.
  const longest = bed();
  const ok = lockOfficeFromRoute(longest.deps, {
    reason: `  ${"r".repeat(LOCKDOWN_REASON_MAX)}  `,
    by: "Ann",
    actor: ACTOR,
  });
  expect(ok).toEqual({ ok: true });
  expect(
    JSON.parse(readFileSync(join(longest.stateRoot, LOCK_MARKER_FILE), "utf8"))
      .reason,
  ).toBe("r".repeat(LOCKDOWN_REASON_MAX));
  await waitForStops(longest, 1);
  expect(longest.stops()).toBe(1);
  rmSync(dir, { recursive: true, force: true });
  resetOfficeLockGate();

  const b = bed();
  const refused = [
    undefined,
    null,
    42,
    ["intrusion"],
    "",
    "   \n\t ",
    "r".repeat(LOCKDOWN_REASON_MAX + 1),
  ].map((reason) => {
    const result = lockOfficeFromRoute(b.deps, {
      reason,
      by: "Ann",
      actor: ACTOR,
    });
    return result.ok ? "ok" : result.status;
  });
  expect(refused).toEqual([422, 422, 422, 422, 422, 422, 422]);
  await Bun.sleep(STOP_BUDGET_MS);
  expect({
    marker: existsSync(join(b.stateRoot, LOCK_MARKER_FILE)),
    locked: officeLockedNow(),
    events: b.events,
  }).toEqual({ marker: false, locked: false, events: [] });
});

test("a marker that cannot be written is 500, with no gate, no closed socket, no audit and no stop: the office must not stop and come back unlocked", async () => {
  const b = bed();
  // Not a file the route can write: writeFileSync fails with EISDIR.
  mkdirSync(join(b.stateRoot, LOCK_MARKER_FILE));
  const result = lockOfficeFromRoute(b.deps, {
    reason: "intrusion",
    by: "Ann",
    actor: ACTOR,
  });

  expect(result.ok).toBe(false);
  expect(result.ok ? null : result.status).toBe(500);
  await Bun.sleep(STOP_BUDGET_MS);
  expect({ locked: officeLockedNow(), events: b.events }).toEqual({
    locked: false,
    events: [],
  });
});
