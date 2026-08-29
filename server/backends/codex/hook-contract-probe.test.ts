import { describe, expect, it } from "bun:test";
import { extractApplyPatchPaths } from "./hook-contract-probe.ts";

describe("Codex apply_patch path extraction candidate", () => {
  it("extracts add, delete, update, and both sides of a move", () => {
    expect(
      extractApplyPatchPaths(`*** Begin Patch
*** Add File: added.ts
+added
*** Delete File: deleted.ts
*** Update File: source.ts
*** Move to: destination.ts
@@
-old
+new
*** End Patch`),
    ).toEqual(["added.ts", "deleted.ts", "source.ts", "destination.ts"]);
  });

  it("keeps relative and traversal paths for the path policy to resolve", () => {
    expect(
      extractApplyPatchPaths(`*** Begin Patch
*** Update File: ../.isomux/bin/isomux-codex-safety-hook
@@
-old
+new
*** End Patch`),
    ).toEqual(["../.isomux/bin/isomux-codex-safety-hook"]);
  });

  it("does not read a content line that looks like a header as a path", () => {
    expect(
      extractApplyPatchPaths(`*** Begin Patch
*** Add File: notes.txt
+*** Add File: not-a-header.ts
*** End Patch`),
    ).toEqual(["notes.txt"]);
  });

  it("keeps protected move sources and destinations in both directions", () => {
    const protectedPath = "/home/probe/.isomux/bin/isomux-codex-safety-hook";
    expect(
      extractApplyPatchPaths(`*** Begin Patch
*** Update File: safe.ts
*** Move to: ${protectedPath}
*** End Patch`),
    ).toEqual(["safe.ts", protectedPath]);
    expect(
      extractApplyPatchPaths(`*** Begin Patch
*** Update File: ${protectedPath}
*** Move to: safe.ts
*** End Patch`),
    ).toEqual([protectedPath, "safe.ts"]);
  });

  for (const [name, patch] of [
    ["non-string", null],
    ["missing envelope", "*** Add File: a.ts\n+x"],
    ["no paths", "*** Begin Patch\n*** End Patch"],
    [
      "move without update",
      "*** Begin Patch\n*** Move to: b.ts\n*** End Patch",
    ],
    ["unknown header", "*** Begin Patch\n*** Copy File: a.ts\n*** End Patch"],
    [
      "wrong-case header",
      "*** Begin Patch\n*** update File: a.ts\n*** End Patch",
    ],
  ] as const) {
    it(`returns null for ${name}`, () => {
      expect(extractApplyPatchPaths(patch)).toBeNull();
    });
  }
});
