import { describe, expect, it } from "bun:test";
import { createPreviewQueue } from "./app-preview-queue.ts";

describe("app preview queue", () => {
  it("runs one capture at a time in view order", async () => {
    const queue = createPreviewQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => (releaseFirst = resolve));
    queue.enqueue(async () => {
      events.push("a:start");
      await first;
      events.push("a:end");
    });
    queue.enqueue(async () => {
      events.push("b:start");
      events.push("b:end");
    });
    await Promise.resolve();
    expect(events).toEqual(["a:start"]);
    releaseFirst();
    await first;
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("drops an offscreen row before its turn", async () => {
    const queue = createPreviewQueue();
    let release!: () => void;
    const first = new Promise<void>((resolve) => (release = resolve));
    queue.enqueue(async () => first);
    let ran = false;
    const cancel = queue.enqueue(async () => {
      ran = true;
    });
    cancel();
    release();
    await first;
    await Promise.resolve();
    await Promise.resolve();
    expect(ran).toBe(false);
  });

  it("continues after a row rejects", async () => {
    const queue = createPreviewQueue();
    let ran = false;
    queue.enqueue(async () => {
      throw new Error("capture failed outside its error boundary");
    });
    queue.enqueue(async () => {
      ran = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(ran).toBe(true);
  });
});
