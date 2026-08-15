import { describe, expect, test } from "bun:test";
import {
  accessWindowDurationMs,
  ACCESS_WINDOW_MS,
} from "./access-window-policy.ts";

describe("setup-access window policy", () => {
  test("the maximum is exactly seven days", () => {
    expect(ACCESS_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(accessWindowDurationMs("7d")).toBe(ACCESS_WINDOW_MS);
  });

  test("operators can shorten the window but cannot extend it", () => {
    expect(accessWindowDurationMs("45m")).toBe(45 * 60 * 1000);
    expect(accessWindowDurationMs("2h")).toBe(2 * 60 * 60 * 1000);
    expect(() => accessWindowDurationMs("8d")).toThrow(/cannot exceed/);
    expect(() => accessWindowDurationMs("169h")).toThrow(/cannot exceed/);
  });

  test("zero and malformed windows fail closed", () => {
    expect(() => accessWindowDurationMs("0m")).toThrow(/greater than zero/);
    expect(() => accessWindowDurationMs("7 days")).toThrow(/must look like/);
  });
});
