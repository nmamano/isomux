// Pure unit tests for the client-side user-record merge core (Phase 3b.5).
// Covers the full-wins-over-public precedence (order-independent), the rename
// key migration carrying sensitive fields, and the authoritative bulk rebuild
// (drop absent users, preserve survivors' sensitive fields).

import { describe, it, expect } from "bun:test";
import type { UserPublicWire, UserRecord } from "../shared/types.ts";
import {
  type UserView,
  isFullUserView,
  upsertUserView,
  rebuildUserViews,
} from "./user-merge.ts";

function full(name: string, over: Partial<UserRecord> = {}): UserRecord {
  return {
    id: `id-${name.toLowerCase()}`,
    name,
    role: "member",
    avatarColor: "#abcdef",
    avatarVariant: "classic",
    createdAt: 1,
    notifRooms: [],
    envFile: null,
    allowedRooms: [],
    hidden: [],
    order: [],
    memberPrompt: null,
    language: null,
    ...over,
  };
}

function pub(name: string, over: Partial<UserPublicWire> = {}): UserPublicWire {
  return {
    id: `id-${name.toLowerCase()}`,
    name,
    role: "member",
    avatarColor: "#abcdef",
    avatarVariant: "classic",
    createdAt: 1,
    ...over,
  };
}

const mapOf = (...views: UserView[]): Map<string, UserView> =>
  new Map(views.map((v) => [v.name.toLowerCase(), v]));

describe("isFullUserView", () => {
  it("is true for a complete record, false for a public-only view", () => {
    expect(isFullUserView(full("Alice"))).toBe(true);
    expect(isFullUserView(pub("Alice"))).toBe(false);
  });
  it("is shape-based, not role-based (an owner's PUBLIC view is still not full)", () => {
    expect(isFullUserView(pub("Boss", { role: "owner" }))).toBe(false);
  });
  it("is false when ANY single sensitive field is missing", () => {
    const sensitive = [
      "allowedRooms",
      "notifRooms",
      "hidden",
      "order",
      "envFile",
      "memberPrompt",
    ];
    for (const f of sensitive) {
      const partial = { ...full("Alice") } as Record<string, unknown>;
      delete partial[f];
      expect(isFullUserView(partial as UserView)).toBe(false);
    }
  });
});

describe("upsertUserView - full-wins-over-public (order-independent)", () => {
  it("a public update after a full self record does NOT clobber sensitive fields", () => {
    const m0 = mapOf(
      full("Alice", { allowedRooms: ["r1"], notifRooms: ["r1"] }),
    );
    const m1 = upsertUserView(m0, pub("Alice", { avatarColor: "#111111" }));
    const a = m1.get("alice")!;
    expect(isFullUserView(a)).toBe(true);
    expect(a.allowedRooms).toEqual(["r1"]);
    expect(a.notifRooms).toEqual(["r1"]);
    expect(a.avatarColor).toBe("#111111"); // public field refreshed
  });
  it("a full (admin/self) update after a public view produces a full record", () => {
    const m0 = mapOf(pub("Alice"));
    const m1 = upsertUserView(m0, full("Alice", { allowedRooms: ["r2"] }));
    expect(isFullUserView(m1.get("alice")!)).toBe(true);
    expect(m1.get("alice")!.allowedRooms).toEqual(["r2"]);
  });
  it("either application order converges to the same full record", () => {
    const pubThenAdmin = upsertUserView(
      upsertUserView(new Map<string, UserView>(), pub("Alice")),
      full("Alice", { allowedRooms: ["r3"] }),
    ).get("alice")!;
    const adminThenPub = upsertUserView(
      upsertUserView(
        new Map<string, UserView>(),
        full("Alice", { allowedRooms: ["r3"] }),
      ),
      pub("Alice"),
    ).get("alice")!;
    expect(pubThenAdmin.allowedRooms).toEqual(["r3"]);
    expect(adminThenPub.allowedRooms).toEqual(["r3"]);
  });
  it("does not mutate the previous map (pure)", () => {
    const m0 = mapOf(full("Alice"));
    const m1 = upsertUserView(m0, pub("Alice", { avatarColor: "#222222" }));
    expect(m0.get("alice")!.avatarColor).toBe("#abcdef");
    expect(m1).not.toBe(m0);
  });
  it("a public update for an UNKNOWN user creates a public-only entry (never fabricates a full record)", () => {
    const m = upsertUserView(new Map<string, UserView>(), pub("New"));
    expect(isFullUserView(m.get("new")!)).toBe(false);
  });
});

describe("upsertUserView - rename carries sensitive fields across the key", () => {
  it("a PUBLIC-only rename carries grants/notif to the new key", () => {
    const m0 = mapOf(
      full("Alice", {
        allowedRooms: ["r1"],
        notifRooms: ["r1"],
      }),
    );
    const m1 = upsertUserView(m0, pub("Alicia"), "Alice");
    expect(m1.has("alice")).toBe(false);
    const a = m1.get("alicia")!;
    expect(a.name).toBe("Alicia");
    expect(a.allowedRooms).toEqual(["r1"]);
    expect(a.notifRooms).toEqual(["r1"]);
  });
  it("a FULL rename migrates the key and carries the fresh record", () => {
    const m0 = mapOf(full("Alice", { allowedRooms: ["r1"] }));
    const m1 = upsertUserView(
      m0,
      full("Alicia", { allowedRooms: ["r1", "r2"] }),
      "Alice",
    );
    expect(m1.has("alice")).toBe(false);
    expect(m1.get("alicia")!.allowedRooms).toEqual(["r1", "r2"]);
  });
});

describe("rebuildUserViews - authoritative membership, preserve survivors", () => {
  it("drops users absent from the list", () => {
    const prev = mapOf(full("Alice"), full("Bob"));
    const next = rebuildUserViews(prev, [pub("Alice")]);
    expect(next.has("alice")).toBe(true);
    expect(next.has("bob")).toBe(false);
  });
  it("a public bulk list after full records keeps a survivor's sensitive fields, drops the absent one", () => {
    const prev = mapOf(
      full("Alice", { allowedRooms: ["r1"], notifRooms: ["r1"] }),
      full("Bob", { allowedRooms: ["r9"] }),
    );
    const next = rebuildUserViews(prev, [
      pub("Alice", { avatarColor: "#333333" }),
    ]);
    const a = next.get("alice")!;
    expect(isFullUserView(a)).toBe(true);
    expect(a.allowedRooms).toEqual(["r1"]);
    expect(a.avatarColor).toBe("#333333");
    expect(next.has("bob")).toBe(false);
  });
  it("an admin (full) bulk list yields full records for everyone", () => {
    const prev = mapOf(pub("Alice"), pub("Bob"));
    const next = rebuildUserViews(prev, [
      full("Alice", { allowedRooms: ["r1"] }),
      full("Bob", { allowedRooms: ["r2"] }),
    ]);
    expect(isFullUserView(next.get("alice")!)).toBe(true);
    expect(isFullUserView(next.get("bob")!)).toBe(true);
  });
  it("does not mutate the previous map (pure)", () => {
    const prev = mapOf(full("Alice", { allowedRooms: ["r1"] }));
    const next = rebuildUserViews(prev, [
      pub("Alice", { avatarColor: "#444444" }),
    ]);
    expect(prev.get("alice")!.avatarColor).toBe("#abcdef");
    expect(prev.get("alice")!.allowedRooms).toEqual(["r1"]);
    expect(next).not.toBe(prev);
  });
});
