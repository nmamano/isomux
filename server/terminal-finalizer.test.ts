import { describe, expect, it } from "bun:test";
import { createTerminalFinalizer } from "./terminal-finalizer.ts";

describe("createTerminalFinalizer", () => {
  it("detaches and emits once across both exit paths", () => {
    const events: number[] = [];
    let detached = 0;
    const finalize = createTerminalFinalizer({
      isCurrent: () => true,
      detach: () => detached++,
      emitExit: (code) => events.push(code),
    });

    finalize(7);
    finalize(0);

    expect(detached).toBe(1);
    expect(events).toEqual([7]);
  });

  it("does not detach a replacement sidecar or emit its old exit", () => {
    const events: number[] = [];
    let detached = 0;
    const finalize = createTerminalFinalizer({
      isCurrent: () => false,
      detach: () => detached++,
      emitExit: (code) => events.push(code),
    });

    finalize(9);

    expect(detached).toBe(0);
    expect(events).toEqual([]);
  });
});
