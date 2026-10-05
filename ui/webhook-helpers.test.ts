import { describe, expect, it } from "bun:test";
import {
  canHandleWebhookSecret,
  isLoopbackUrl,
  lastRunAt,
  ruleEvents,
  webhookNeedsAttention,
} from "./webhook-helpers.ts";
import type { SessionContext } from "../shared/types.ts";

const session = (userId: string, role: "owner" | "member"): SessionContext => ({
  userId,
  username: userId,
  role,
  currentSessionPrefix: "00000000",
  connectionId: "c1",
});

describe("canHandleWebhookSecret", () => {
  it("allows the hook owner and an office owner, and nobody else", () => {
    const hook = { userId: "u1" };
    expect(canHandleWebhookSecret(hook, session("u1", "member"))).toBe(true);
    expect(canHandleWebhookSecret(hook, session("u2", "owner"))).toBe(true);
    expect(canHandleWebhookSecret(hook, session("u2", "member"))).toBe(false);
    expect(canHandleWebhookSecret(hook, null)).toBe(false);
  });
});

describe("ruleEvents", () => {
  it("lists distinct named events in rule order and flags a * rule", () => {
    expect(
      ruleEvents([
        { event: "pull_request" },
        { event: "issues" },
        { event: "pull_request" },
      ]),
    ).toEqual({ events: ["pull_request", "issues"], everything: false });
    expect(ruleEvents([{ event: "*" }, { event: "push" }])).toEqual({
      events: ["push"],
      everything: true,
    });
  });
});

describe("isLoopbackUrl", () => {
  it("is true only for an address of this machine", () => {
    for (const url of [
      "http://localhost:4000/hooks/x",
      "http://office.localhost/hooks/x",
      "http://127.0.0.1:4000/hooks/x",
      "http://127.8.9.10/hooks/x",
      "http://[::1]:4000/hooks/x",
      "http://0.0.0.0:4000/hooks/x",
    ]) {
      expect(isLoopbackUrl(url)).toBe(true);
    }
    for (const url of [
      "https://office.example/hooks/x",
      "https://box.tail1234.ts.net/hooks/x",
      "http://192.168.1.2/hooks/x",
      "not a url",
    ]) {
      expect(isLoopbackUrl(url)).toBe(false);
    }
  });
});

describe("webhookNeedsAttention", () => {
  it("marks a missing secret or a nonzero counter", () => {
    expect(webhookNeedsAttention({ secretState: "set", counters: {} })).toBe(
      false,
    );
    expect(
      webhookNeedsAttention({ secretState: "missing", counters: {} }),
    ).toBe(true);
    expect(
      webhookNeedsAttention({
        secretState: "set",
        counters: { bad_signature: { count: 1, lastAt: 5 } },
      }),
    ).toBe(true);
    expect(
      webhookNeedsAttention({
        secretState: "set",
        counters: { bad_signature: { count: 0, lastAt: 5 } },
      }),
    ).toBe(false);
  });
});

describe("lastRunAt", () => {
  it("is the newest of lastFireAt and every run, of any trigger", () => {
    expect(lastRunAt({ lastFireAt: null }, [])).toBe(null);
    expect(lastRunAt({ lastFireAt: null }, [{ startedAt: 7 }])).toBe(7);
    expect(lastRunAt({ lastFireAt: 10 }, [{ startedAt: 7 }])).toBe(10);
    expect(
      lastRunAt({ lastFireAt: 10 }, [{ startedAt: 12 }, { startedAt: 11 }]),
    ).toBe(12);
  });
});
