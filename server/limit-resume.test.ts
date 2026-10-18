import { describe, expect, it } from "bun:test";
import { DEFAULT_AGENT_CAPABILITIES } from "../shared/types.ts";
import {
  LIMIT_RESUME_DELAY_MS,
  LIMIT_RESUME_MAX_WAIT_MS,
  limitResumeDueAt,
  limitResumeOn,
  limitResumeWaitMs,
} from "./limit-resume.ts";

const NOW = 1_792_000_000_000;

describe("limitResumeDueAt", () => {
  it("fires a minute after a reset in the future", () => {
    expect(limitResumeDueAt(NOW + 1, NOW)).toBe(
      NOW + 1 + LIMIT_RESUME_DELAY_MS,
    );
  });
  it("a reset now or in the past arms nothing", () => {
    expect(limitResumeDueAt(NOW, NOW)).toBeNull();
    expect(limitResumeDueAt(NOW - 1, NOW)).toBeNull();
    expect(limitResumeDueAt(Number.NaN, NOW)).toBeNull();
  });
});

describe("limitResumeWaitMs", () => {
  it("waits until the due time, at most a day per timer", () => {
    expect(limitResumeWaitMs(NOW + 5000, NOW)).toBe(5000);
    expect(limitResumeWaitMs(NOW + 7 * LIMIT_RESUME_MAX_WAIT_MS, NOW)).toBe(
      LIMIT_RESUME_MAX_WAIT_MS,
    );
  });
  it("a past due time waits the minimum", () => {
    expect(limitResumeWaitMs(NOW - 5000, NOW)).toBe(0);
    expect(limitResumeWaitMs(NOW - 5000, NOW, 30_000)).toBe(30_000);
  });
});

describe("limitResumeOn", () => {
  const caps = DEFAULT_AGENT_CAPABILITIES;
  it("absent reads as on", () => {
    expect(limitResumeOn({ capabilities: caps })).toBe(true);
  });
  it("off, or an engine without the signal, is off", () => {
    expect(limitResumeOn({ capabilities: caps, limitResume: false })).toBe(
      false,
    );
    expect(
      limitResumeOn({ capabilities: { ...caps, limitResume: false } }),
    ).toBe(false);
  });
});
