// The guard that stops a deploy shipping a stale artifact, and the freeze that
// used to trip it.
//
// The property is real: `git archive HEAD` cannot carry an uncommitted change,
// so a runtime file with one means the artifact is not what the operator is
// looking at. The old classifier tested for it by dropping `??` lines and
// treating everything else as a modified tracked file - which is true right up
// until somebody runs `git add --intent-to-add .`, the convention this repo
// freezes a tree with, and every untracked file becomes an ` A` index entry.
// Measured on a real freeze, 2026-08-11: 27 paths reported as dirty runtime
// paths and not one of them tracked.

import { describe, expect, test } from "bun:test";
import {
  classifyAgainstHead,
  headPathsFrom,
  parsePorcelain,
} from "./tree-state.ts";

const HEAD = headPathsFrom(
  [
    "control-plane/store.ts",
    "control-plane/README.md",
    "control-plane/web/lib/services.server.ts",
  ].join("\n"),
);

describe("what the porcelain line says, and what it means", () => {
  test("reads the prefix and the path apart", () => {
    const entries = parsePorcelain(
      " M control-plane/store.ts\n?? scratch.ts\n",
    );
    expect(entries).toEqual([
      { prefix: " M", path: "control-plane/store.ts" },
      { prefix: "??", path: "scratch.ts" },
    ]);
  });

  test("a rename keeps BOTH halves, because HEAD still carries the origin", () => {
    const entries = parsePorcelain(
      "R  old/path.ts -> control-plane/store.ts\n",
    );
    expect(entries[0].path).toBe("control-plane/store.ts");
    expect(entries[0].from).toBe("old/path.ts");
  });

  test("blank and truncated lines are not entries", () => {
    expect(parsePorcelain("\n\n  \nM\n")).toEqual([]);
  });
});

describe("an intent-to-add freeze is not a dirty runtime path", () => {
  // THE REGRESSION. Every one of these prefixes says something different about
  // the index and nothing at all about whether HEAD carries the file.
  test("` A` on an untracked file reads as not-in-HEAD", () => {
    const verdict = classifyAgainstHead(
      parsePorcelain(" A control-plane/deploy/scratch-probe.ts\n"),
      HEAD,
    );
    expect(verdict.runtimeDirty).toEqual([]);
    expect(verdict.notInHead).toEqual([
      "control-plane/deploy/scratch-probe.ts",
    ]);
  });

  test("so does `??`, `AM` and anything else on a path HEAD does not carry", () => {
    const verdict = classifyAgainstHead(
      parsePorcelain(
        "?? a.ts\nAM b.ts\nA  c.ts\n M d.ts\n".replace(
          /(\w)\.ts/g,
          "control-plane/$1.ts",
        ),
      ),
      HEAD,
    );
    expect(verdict.runtimeDirty).toEqual([]);
    expect(verdict.notInHead.length).toBe(4);
  });

  test("a tracked file that really changed is still caught, staged or not", () => {
    const verdict = classifyAgainstHead(
      parsePorcelain(
        " M control-plane/store.ts\nM  control-plane/web/lib/services.server.ts\n",
      ),
      HEAD,
    );
    expect(verdict.runtimeDirty).toEqual([
      "control-plane/store.ts",
      "control-plane/web/lib/services.server.ts",
    ]);
    expect(verdict.notInHead).toEqual([]);
  });

  // THE RENAME HOLE. Moving a tracked runtime file to a new name leaves the
  // destination absent from HEAD, so a classifier that looked only at the
  // destination called it untracked and allowed the deploy - while
  // `git archive HEAD` went on shipping the ORIGIN. The artifact would have been
  // stale in exactly the way this guard exists to prevent.
  test("a tracked runtime file renamed away is still a dirty runtime path", () => {
    const verdict = classifyAgainstHead(
      parsePorcelain(
        "R  control-plane/store.ts -> control-plane/store-new.ts\n",
      ),
      HEAD,
    );
    expect(verdict.runtimeDirty).toEqual(["control-plane/store.ts"]);
    expect(verdict.notInHead).toEqual([]);
  });

  test("a rename of a path HEAD never carried is still not a finding", () => {
    const verdict = classifyAgainstHead(
      parsePorcelain("R  scratch/a.ts -> scratch/b.ts\n"),
      HEAD,
    );
    expect(verdict.runtimeDirty).toEqual([]);
    expect(verdict.notInHead).toEqual(["scratch/b.ts"]);
  });

  test("a tracked documentation change is separated rather than ignored", () => {
    const verdict = classifyAgainstHead(
      parsePorcelain(" M control-plane/README.md\n"),
      HEAD,
    );
    expect(verdict.runtimeDirty).toEqual([]);
    expect(verdict.docOnly).toEqual(["control-plane/README.md"]);
  });

  // The freeze as it actually looks: one real edit under a pile of
  // intent-to-add scratch files. The old classifier answered 4; the property
  // only ever justified answering 1.
  test("a real change is found inside a freeze that stages everything", () => {
    const verdict = classifyAgainstHead(
      parsePorcelain(
        [
          " A control-plane/exercises/d35-probe.ts",
          " A control-plane/exercises/d35-probe2.ts",
          " A control-plane/deploy/tree-state.ts",
          " M control-plane/store.ts",
          " M control-plane/README.md",
        ].join("\n"),
      ),
      HEAD,
    );
    expect(verdict.runtimeDirty).toEqual(["control-plane/store.ts"]);
    expect(verdict.docOnly).toEqual(["control-plane/README.md"]);
    expect(verdict.notInHead.length).toBe(3);
  });
});
