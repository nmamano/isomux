// Phase 2.3 - Guard combinator contract tests (TDD red→green for NEW code).
//
// and()/or() let the route table compose compound guards (agents.move/revive,
// the validate.env owner/self branch) as machine-checkable values rather than
// free-form strings. Pins: first-deny-wins / first-allow-wins, the verbatim
// outcome passthrough (status/code survive for the non-leak envelope), and
// short-circuit (a later guard is not evaluated once the result is decided).
//
// Pure T0: no server, no FS, no LLM.

import { describe, it, expect } from "bun:test";
import { and, or, ALLOW, FORBIDDEN, type Guard } from "../identity/guards.ts";
import type { Identity } from "../identity/index.ts";
import type { GuardDeps } from "../identity/guards.ts";

const deps: GuardDeps = {
  hasRoomAccess: () => true,
  roomIdForAgent: () => "r1",
  userIdForUsername: () => null,
  cronjobCreatorUserId: () => null,
  appOwnerUserId: () => null,
  isOfficeOwnerUserId: () => false,
  agentManagerUserId: () => null,
  killedAgentManagerUserId: () => null,
};
const identity: Identity = {
  scope: "user",
  userId: "u1",
  role: "owner",
  capabilities: [],
};
const ctx = { identity, params: {}, body: undefined, deps };

const allow: Guard = () => ALLOW;
const deny403: Guard = () => FORBIDDEN;
const deny404: Guard = () => ({ ok: false, status: 404, code: "not_found" });
const boom: Guard = () => {
  throw new Error("must not be evaluated");
};

describe("and(): all must allow (first-deny-wins)", () => {
  it("all allow ⇒ ALLOW", () => {
    expect(and(allow, allow)(ctx)).toEqual({ ok: true });
  });
  it("first denial returned verbatim (status/code preserved)", () => {
    expect(and(allow, deny404)(ctx)).toEqual({
      ok: false,
      status: 404,
      code: "not_found",
    });
  });
  it("short-circuits - guards after the first deny are not evaluated", () => {
    expect(() => and(deny403, boom)(ctx)).not.toThrow();
    expect(and(deny403, boom)(ctx)).toEqual(FORBIDDEN);
  });
  it("empty composition allows (vacuous truth)", () => {
    expect(and()(ctx)).toEqual({ ok: true });
  });
});

describe("or(): any may allow (first-allow-wins)", () => {
  it("any allow ⇒ ALLOW", () => {
    expect(or(deny403, allow)(ctx)).toEqual({ ok: true });
  });
  it("all deny ⇒ the LAST denial verbatim", () => {
    expect(or(deny403, deny404)(ctx)).toEqual({
      ok: false,
      status: 404,
      code: "not_found",
    });
  });
  it("short-circuits - guards after the first allow are not evaluated", () => {
    expect(() => or(allow, boom)(ctx)).not.toThrow();
    expect(or(allow, boom)(ctx)).toEqual({ ok: true });
  });
  it("empty composition denies with FORBIDDEN", () => {
    expect(or()(ctx)).toEqual(FORBIDDEN);
  });
});
