// The boot proof: what a deployed provisioner establishes before it serves.
//
// The local container reports no `neon.branch_id`, which is exactly the case
// that has to refuse when a pin is configured - a target that cannot say which
// branch it is has not proved it is the right one. The matching case for the
// managed engine is covered live, on the deployed machine, because a branch id
// only exists there.

import { afterEach, describe, expect, test } from "bun:test";
import { BRANCH_PIN_ENV, liveBranchId, provePinnedBranch } from "./boot.ts";
import {
  TARGET_IS_LOCAL,
  openTestStore,
  releaseTestStores,
} from "./testing/pg.ts";

afterEach(async () => {
  await releaseTestStores();
});

/** The refusal's message, or a sentence saying there was not one. */
async function refusalOf(work: Promise<unknown>): Promise<string> {
  return work.then(
    () => "IT DID NOT REFUSE",
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
}

describe("the branch pin", () => {
  test("no pin means no claim, and no claim means not proved", async () => {
    const store = await openTestStore();
    expect(await provePinnedBranch(store, undefined)).toBe(false);
    expect(await provePinnedBranch(store, "")).toBe(false);
  });

  test.skipIf(!TARGET_IS_LOCAL)(
    "a pin against an engine with no branch id REFUSES",
    async () => {
      const store = await openTestStore();
      const failure = await refusalOf(provePinnedBranch(store, "br-something"));
      expect(failure).toContain("refusing to start");
      expect(failure).toContain("does not report a branch id");
    },
  );

  test("the refusal names neither the pin nor any connection detail", async () => {
    const store = await openTestStore();
    const message = await provePinnedBranch(store, "br-a-secret-looking-id")
      .then(() => "")
      .catch((err: unknown) => (err instanceof Error ? err.message : ""));
    expect(message).not.toContain("br-a-secret-looking-id");
    expect(message).not.toContain("isomux");
    expect(message).not.toContain("5433");
  });

  test("a branch that is not the pinned one REFUSES", async () => {
    const store = await openTestStore();
    // The engine's answer is the seam under test here, and the local container
    // cannot produce a branch id of its own, so the seam is what gets replaced
    // - not the check that reads it.
    store.sqlGet = (async () => ({ v: "br-a-different-branch" })) as never;
    const failure = await refusalOf(
      provePinnedBranch(store, "br-the-pinned-one"),
    );
    expect(failure).toContain("not the one this deployment pins");
  });

  test("the branch the deployment pins is proved", async () => {
    const store = await openTestStore();
    store.sqlGet = (async () => ({ v: "br-the-pinned-one" })) as never;
    expect(await provePinnedBranch(store, "br-the-pinned-one")).toBe(true);
  });

  // LOCAL ENGINE ONLY: a managed branch reports a branch id on every session,
  // so "no branch id" is not a state that can be staged there. The case is
  // real - a non-Neon engine is what a contributor runs against - and it is
  // skipped rather than rewritten into something that always passes.
  test.skipIf(!TARGET_IS_LOCAL)(
    "an engine with no branch id answers null rather than throwing",
    async () => {
      const store = await openTestStore();
      expect(await liveBranchId(store)).toBeNull();
    },
  );

  test("the environment variable name is the product's, not a second one", () => {
    expect(BRANCH_PIN_ENV).toBe("CONTROL_PLANE_DB_BRANCH");
  });
});
