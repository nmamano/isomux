// The per-recipient app delta rule (server/events/app-delta.ts) - the full
// truth table, pure, no server.
//
// What this pins is an AUDIENCE boundary, so the negative rows matter as much
// as the positive ones: a third user must get `null`, not an app_deleted
// carrying a name they were never entitled to learn.
//
// Pure T0: no server, no FS, no LLM.

import { describe, it, expect } from "bun:test";
import { appDeltaFor, type AppViewer } from "./app-delta.ts";
import type { AppWire } from "../../shared/types.ts";

const OWNER: AppViewer = { userId: "u-owner", isOfficeOwner: true };
const ALICE: AppViewer = { userId: "u-alice", isOfficeOwner: false };
const BOB: AppViewer = { userId: "u-bob", isOfficeOwner: false };
const ANON: AppViewer = { userId: null, isOfficeOwner: false };

function app(overrides: Partial<AppWire> = {}): AppWire {
  return {
    name: "hello",
    port: 21000,
    command: "bun run start",
    cwd: "/home/alice/hello",
    dataDir: "/state/apps/data/hello",
    userId: "u-alice",
    username: "alice",
    createdBy: "Agent1",
    createdAt: 1,
    state: "running",
    restartCount: 0,
    ...overrides,
  };
}

describe("appDeltaFor: upserts", () => {
  it("tells the owning user about their own app", () => {
    expect(appDeltaFor({ kind: "upserted", app: app() }, ALICE)).toEqual({
      type: "app_upserted",
      app: app(),
    });
  });

  it("tells an office owner about somebody else's app", () => {
    expect(appDeltaFor({ kind: "upserted", app: app() }, OWNER)).toEqual({
      type: "app_upserted",
      app: app(),
    });
  });

  it("tells another member NOTHING about an app they do not own", () => {
    expect(appDeltaFor({ kind: "upserted", app: app() }, BOB)).toBeNull();
  });

  it("passes the wire object through by reference, not a copy", () => {
    // The handler announces the SAME object it returns, and this is the step
    // that could quietly clone it and let the two drift.
    const wire = app();
    const delta = appDeltaFor({ kind: "upserted", app: wire }, ALICE);
    expect(delta).not.toBeNull();
    expect((delta as { app: AppWire }).app).toBe(wire);
  });
});

describe("appDeltaFor: deletes", () => {
  it("tells the owning user, carrying only the name", () => {
    expect(
      appDeltaFor({ kind: "deleted", name: "hello", userId: "u-alice" }, ALICE),
    ).toEqual({ type: "app_deleted", name: "hello" });
  });

  it("tells an office owner", () => {
    expect(
      appDeltaFor({ kind: "deleted", name: "hello", userId: "u-alice" }, OWNER),
    ).toEqual({ type: "app_deleted", name: "hello" });
  });

  it("tells another member NOTHING - not even that the name existed", () => {
    expect(
      appDeltaFor({ kind: "deleted", name: "hello", userId: "u-alice" }, BOB),
    ).toBeNull();
  });
});

describe("appDeltaFor: ownerless apps belong to owners alone", () => {
  // A record can carry userId null (a pre-guard registration, or a hand-edited
  // registry). `null === null` must not make it every session's app - the
  // sessions most at risk are exactly the ones with no user resolved.
  it("reaches office owners", () => {
    const orphan = app({ userId: null });
    expect(appDeltaFor({ kind: "upserted", app: orphan }, OWNER)).toEqual({
      type: "app_upserted",
      app: orphan,
    });
  });

  it("does NOT reach a session whose own userId is null", () => {
    expect(
      appDeltaFor({ kind: "upserted", app: app({ userId: null }) }, ANON),
    ).toBeNull();
  });

  it("does not reach an ordinary member", () => {
    expect(
      appDeltaFor({ kind: "upserted", app: app({ userId: null }) }, ALICE),
    ).toBeNull();
  });

  it("keeps the same rule on delete", () => {
    expect(
      appDeltaFor({ kind: "deleted", name: "hello", userId: null }, ANON),
    ).toBeNull();
    expect(
      appDeltaFor({ kind: "deleted", name: "hello", userId: null }, OWNER),
    ).toEqual({ type: "app_deleted", name: "hello" });
  });
});
