import { test, expect, spyOn } from "bun:test";
import type { Frame } from "playwright-core";
import { readBrowserFrames, resolveBrowserFrame } from "./browser-frames";

function frame(text: string, children: Frame[] = [], detached = false): Frame {
  return {
    getByRole: () => ({}),
    childFrames: () => children,
    isDetached: () => detached,
    locator: () => ({
      innerText: async () => text,
      ariaSnapshot: async () => `- text: ${text}`,
      locator: () => ({ and: () => ({ and: () => ({ filter: () => ({ count: async () => 0 }) }) }) }),
    }),
  } as unknown as Frame;
}

test("frame reads preserve root and label nested paths in depth-first order", async () => {
  const leaf = frame("Nested content");
  const root = frame("Shell", [
    frame("Same origin", [leaf]),
    frame("Cross origin"),
  ]);
  expect(resolveBrowserFrame(root, [0, 0])).toBe(leaf);
  expect(resolveBrowserFrame(root, [])).toBe(root);
  for (const action of ["text", "snapshot"] as const) {
    const read = await readBrowserFrames(root, action, 20_000, 1000);
    expect(read.indexOf("Shell")).toBeLessThan(read.indexOf("Same origin"));
    expect(read.indexOf("Same origin")).toBeLessThan(
      read.indexOf("Nested content"),
    );
    expect(read.indexOf("Nested content")).toBeLessThan(
      read.indexOf("Cross origin"),
    );
    for (const path of [[0], [0, 0], [1]])
      expect(read).toContain(`framePath=${JSON.stringify(path)}`);
  }
});

test("missing or detached paths fail before an element action", () => {
  const root = frame("Shell", [frame("Detached", [], true)]);
  expect(() => resolveBrowserFrame(root, [1])).toThrow();
  expect(() => resolveBrowserFrame(root, [0])).toThrow();
});

test("unavailable frames keep readable siblings and hide exception content", async () => {
  const bad = frame("unused");
  bad.locator = () => {
    throw new Error("private exception content");
  };
  const root = frame("Shell", [
    frame("Detached", [], true),
    bad,
    frame("Readable sibling"),
  ]);
  const read = await readBrowserFrames(root, "text", 20_000, 1000);
  expect(read).toContain("Readable sibling");
  expect(read).toContain("framePath=[2]");
  expect(read).not.toContain("private exception content");
  expect(read).not.toContain("Detached");
});

test("one output budget covers root, frame boundaries and child content", async () => {
  const root = frame("root", [
    frame("x".repeat(500)),
    frame("omitted sibling"),
  ]);
  for (const action of ["text", "snapshot"] as const) {
    const read = await readBrowserFrames(root, action, 100, 1000);
    expect(read.length).toBe(100);
    expect(read).toContain("root");
    expect(read).toContain("framePath=[0]");
    expect(read).not.toContain("omitted sibling");
  }
  expect(
    (
      await readBrowserFrames(
        frame(
          "Shell",
          Array.from({ length: 100 }, () => frame("child")),
        ),
        "text",
        20_000,
        1000,
      )
    ).match(/framePath=/g),
  ).toHaveLength(63);
});

test("scoped reads select one frame and one locator without child traversal", async () => {
  const child = frame("Child", [frame("Outside scope")]);
  const root = frame("Root", [child]);
  const selectors: string[] = [];
  const original = child.locator.bind(child);
  child.locator = (selector: string) => {
    selectors.push(selector);
    return original(selector);
  };
  for (const action of ["text", "snapshot"] as const) {
    const read = await readBrowserFrames(root, action, 20_000, 1000, { framePath: [0], selector: "#entry" });
    expect(read).toContain("Child");
    expect(read).not.toContain("Root");
    expect(read).not.toContain("Outside scope");
    expect(read).not.toContain("framePath=");
  }
  expect(selectors.filter((selector) => selector === "#entry")).toHaveLength(2);
  expect(selectors).not.toContain("body");
  expect(await readBrowserFrames(root, "text", 20_000, 1000, { framePath: [9] }).then(() => false, () => true)).toBe(true);
});

function editableFrame(
  snapshot: (timeout: number) => string,
  count: () => number,
  read: (index: number, timeout: number) => string,
): Frame {
  const boxes = {
    count: async () => count(),
    nth: (index: number) => ({ innerText: async ({ timeout }: { timeout: number }) => read(index, timeout) }),
  };
  return {
    childFrames: () => [],
    isDetached: () => false,
    getByRole: () => ({}),
    locator: () => ({
      ariaSnapshot: async ({ timeout }: { timeout: number }) => snapshot(timeout),
      locator: () => ({ and: () => ({ and: () => ({ filter: () => boxes }) }) }),
    }),
  } as unknown as Frame;
}

test("editable scan shares the snapshot deadline and stops after empty candidates", async () => {
  let now = 1000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const calls: { at: number; timeout: number }[] = [];
  try {
    const root = editableFrame((timeout) => {
      expect(timeout).toBe(10);
      now += 4;
      return "- textbox";
    }, () => 1000, (_index, timeout) => {
      calls.push({ at: now, timeout });
      now += 2;
      return "";
    });
    const read = await readBrowserFrames(root, "snapshot", 20_000, 10);
    expect(read).toContain("textbox");
    expect(calls).toEqual([
      { at: 1004, timeout: 6 },
      { at: 1006, timeout: 4 },
      { at: 1008, timeout: 2 },
    ]);
    expect(now).toBe(1010);
  } finally {
    clock.mockRestore();
  }
});

test("expired snapshot or candidate count does not start editable reads", async () => {
  let now = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    for (const snapshotMs of [6, 10]) {
      now = 1000;
      let counts = 0;
      let reads = 0;
      const root = editableFrame(() => {
        now += snapshotMs;
        return "- textbox";
      }, () => {
        counts++;
        now += 4;
        return 1000;
      }, () => {
        reads++;
        return "";
      });
      const read = await readBrowserFrames(root, "snapshot", 20_000, 10);
      expect(read).toContain("textbox");
      expect(counts).toBe(snapshotMs === 10 ? 0 : 1);
      expect(reads).toBe(0);
    }
  } finally {
    clock.mockRestore();
  }
});

test("deadline keeps collected editable text and propagates locator timeouts", async () => {
  let now = 1000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    let reads = 0;
    const root = editableFrame(() => {
      now += 2;
      return "- textbox";
    }, () => 1000, (index) => {
      reads++;
      now += 4;
      return index === 0 ? "Collected draft" : "";
    });
    expect(await readBrowserFrames(root, "snapshot", 20_000, 10)).toContain("Collected draft");
    expect(reads).toBe(2);
    const timeout = new Error("private locator diagnostic");
    timeout.name = "TimeoutError";
    const stalled = editableFrame(() => "- textbox", () => 1, () => { throw timeout; });
    expect(await readBrowserFrames(stalled, "snapshot", 20_000, 10).then(() => false, (error) => error === timeout)).toBe(true);
  } finally {
    clock.mockRestore();
  }
});
