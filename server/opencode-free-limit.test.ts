// OpenCode's office-wide free usage limit record (server/opencode-free-limit.ts,
// task a1e5ea01). Seam: the record's own API with a clock the test moves. The
// sites that record a refusal are pinned where they run: agent turns and the
// topic in server/test-support/provider-fallback.test.ts, the boot check in
// server/test-support/receptionist.test.ts.

import { expect, it } from "bun:test";
import { createOpenCodeFreeLimit } from "./opencode-free-limit.ts";
import { OPENCODE_FALLBACK_RETRY_MS } from "./provider-fallback.ts";

function recordAt(start = 1_800_000_000_000) {
  const clock = { now: start };
  const limit = createOpenCodeFreeLimit({ now: () => clock.now });
  return { clock, limit };
}

it("is null until a refusal, then names it until OPENCODE_FALLBACK_RETRY_MS has passed", () => {
  const { clock, limit } = recordAt();
  expect(limit.since()).toBeNull();
  const at = clock.now;
  limit.record();
  expect(limit.since()).toBe(at);
  clock.now = at + OPENCODE_FALLBACK_RETRY_MS - 1;
  expect(limit.since()).toBe(at);
  clock.now = at + OPENCODE_FALLBACK_RETRY_MS;
  expect(limit.since()).toBeNull();
});

it("names the latest refusal, and a later one opens a new window", () => {
  const { clock, limit } = recordAt();
  const first = clock.now;
  limit.record();
  clock.now = first + 10 * 60 * 1000;
  const second = clock.now;
  limit.record();
  expect(limit.since()).toBe(second);
  // Past the first refusal's window, inside the second's.
  clock.now = first + OPENCODE_FALLBACK_RETRY_MS + 1;
  expect(limit.since()).toBe(second);
});

// A clock that steps back (an injected test clock, a host clock change) must
// not let an older refusal replace the newer one.
it("keeps the newer refusal when the clock reads an earlier time", () => {
  const { clock, limit } = recordAt();
  const newer = clock.now;
  limit.record();
  clock.now = newer - 5 * 60 * 1000;
  limit.record();
  clock.now = newer;
  expect(limit.since()).toBe(newer);
});
