import { expect, it } from "bun:test";
import {
  coalesceCodexDiagnostics,
  filterMissingToolOutputRepeats,
} from "./codex-diagnostics.ts";
import type { LogEntry } from "./types.ts";

const warning = (id: string, time = "2026-09-17T23:28:09Z") =>
  `${time} ERROR codex_core::util: Custom tool call output is missing for call id: ${id}`;

it("keeps distinct diagnostics and coalesces the same missing result across timestamps and chunks", () => {
  const seen = new Set<string>();
  expect(filterMissingToolOutputRepeats(warning("call_a"), seen)).toBe(
    warning("call_a"),
  );
  expect(
    filterMissingToolOutputRepeats(
      warning("call_a", "2026-09-18T00:00:00Z"),
      seen,
    ),
  ).toBe("");
  const other = "ERROR codex_core::util: a different failure";
  expect(
    filterMissingToolOutputRepeats(
      `${warning("call_a")}\n${other}\n${warning("call_b")}`,
      seen,
    ),
  ).toBe(`${other}\n${warning("call_b")}`);
  expect(filterMissingToolOutputRepeats(other, seen)).toBe(other);
});

it("coalesces saved stderr without changing user messages, other errors, or the stored entries", () => {
  const entry = (
    id: string,
    kind: LogEntry["kind"],
    content: string,
  ): LogEntry => ({ id, agentId: "a", timestamp: 1, kind, content });
  const repeated = `[codex stderr] ${warning("call_a")}`;
  const entries = [
    entry("first", "system", repeated),
    entry("user", "user_message", repeated),
    entry("repeat", "system", repeated),
    entry("error", "system", "[codex stderr] another error"),
    entry("new", "system", `[codex stderr] ${warning("call_b")}`),
  ];
  expect(coalesceCodexDiagnostics(entries).map((e) => e.id)).toEqual([
    "first",
    "user",
    "error",
    "new",
  ]);
  expect(entries).toHaveLength(5);
  expect(coalesceCodexDiagnostics([entries[2]])).toEqual([entries[2]]);
});
