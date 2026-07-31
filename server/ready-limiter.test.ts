// server/ready-limiter.ts - fixed-window per-IP limit for /readyz. Pure T0:
// injected clock, no server. Zero LLM.

import { describe, it, expect, beforeEach } from "bun:test";
import {
  allowReadyRequest,
  _resetReadyLimiterForTests,
} from "./ready-limiter.ts";

beforeEach(() => _resetReadyLimiterForTests());

describe("allowReadyRequest", () => {
  it("allows up to 30 per window, then denies", () => {
    for (let i = 0; i < 30; i++) {
      expect(allowReadyRequest("1.2.3.4", 1000)).toBe(true);
    }
    expect(allowReadyRequest("1.2.3.4", 1000)).toBe(false);
  });

  it("a new window resets the count", () => {
    for (let i = 0; i < 31; i++) allowReadyRequest("1.2.3.4", 1000);
    expect(allowReadyRequest("1.2.3.4", 1000)).toBe(false);
    expect(allowReadyRequest("1.2.3.4", 1000 + 60_000)).toBe(true);
  });

  it("IPs are limited independently", () => {
    for (let i = 0; i < 31; i++) allowReadyRequest("1.2.3.4", 1000);
    expect(allowReadyRequest("1.2.3.4", 1000)).toBe(false);
    expect(allowReadyRequest("5.6.7.8", 1000)).toBe(true);
  });

  it("map cap: expired windows are evicted to admit new IPs", () => {
    for (let i = 0; i < 1024; i++)
      allowReadyRequest(`10.0.${i >> 8}.${i & 255}`, 1000);
    // All 1024 slots hold expired windows now; a new IP sweeps and is tracked.
    const later = 1000 + 60_000;
    expect(allowReadyRequest("9.9.9.9", later)).toBe(true);
    for (let i = 0; i < 29; i++) allowReadyRequest("9.9.9.9", later);
    expect(allowReadyRequest("9.9.9.9", later)).toBe(false);
  });

  it("map cap with live windows: unknown IP fails open (allowed, untracked)", () => {
    for (let i = 0; i < 1024; i++)
      allowReadyRequest(`10.0.${i >> 8}.${i & 255}`, 1000);
    // Same instant, so nothing is expired; the newcomer must still be allowed.
    for (let i = 0; i < 40; i++) {
      expect(allowReadyRequest("9.9.9.9", 1000)).toBe(true);
    }
  });
});
