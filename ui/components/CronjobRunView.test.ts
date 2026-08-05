// A run view left open across a WS reconnect used to go blank and stay blank
// (task 461fe250): full_state drops every log stream but the focused agent's,
// the server's replay is agent-only, and the backfill guard was once-per-mount
// so nothing refetched. The guard is now once-per-HYDRATION - the store's
// hydrationEpoch is folded into the key. Only the decision is covered here; the
// UI has no React render harness (see EditAgentDialog.test.ts). The epoch bump
// itself is covered in store.test.ts.
import { describe, it, expect } from "bun:test";
import { transcriptFetchAction } from "./CronjobRunView.tsx";

// Stand-ins for the component's real keys, which join the parts on a NUL. The
// decision only compares them for equality, so the separator is irrelevant.
const key = (epoch: number) => `job1/run1/${epoch}`;

describe("transcriptFetchAction", () => {
  it("fetches once per hydration and not again while it holds", () => {
    expect(transcriptFetchAction(1, null, key(1))).toBe("fetch");
    expect(transcriptFetchAction(1, key(1), key(1))).toBe("skip");
  });

  it("refetches on the next hydration", () => {
    // What a reconnect looks like: same run, new epoch, so the key moves.
    expect(transcriptFetchAction(2, key(1), key(2))).toBe("fetch");
  });

  it("waits for the first hydration instead of fetching into the wipe", () => {
    // Epoch 0 means no full_state has landed yet, and the one that is coming
    // would drop whatever this fetch returned.
    expect(transcriptFetchAction(0, null, key(0))).toBe("skip");
  });

  it("fetches for a different run without waiting for a hydration", () => {
    expect(transcriptFetchAction(1, "job1/run0/1", key(1))).toBe("fetch");
  });
});
