import { test, expect } from "bun:test";
import type { Frame } from "playwright-core";
import { readBrowserFrames, resolveBrowserFrame } from "./browser-frames";

function frame(text: string, children: Frame[] = [], detached = false): Frame {
  return {
    childFrames: () => children,
    isDetached: () => detached,
    locator: () => ({ innerText: async () => text, ariaSnapshot: async () => `- text: ${text}` }),
  } as unknown as Frame;
}

test("frame reads preserve root and label nested paths in depth-first order", async () => {
  const leaf = frame("Nested content");
  const root = frame("Shell", [frame("Same origin", [leaf]), frame("Cross origin")]);
  expect(resolveBrowserFrame(root, [0, 0])).toBe(leaf);
  expect(resolveBrowserFrame(root, [])).toBe(root);
  for (const action of ["text", "snapshot"] as const) {
    const read = await readBrowserFrames(root, action, 20_000, 1000);
    expect(read.indexOf("Shell")).toBeLessThan(read.indexOf("Same origin"));
    expect(read.indexOf("Same origin")).toBeLessThan(read.indexOf("Nested content"));
    expect(read.indexOf("Nested content")).toBeLessThan(read.indexOf("Cross origin"));
    for (const path of [[0], [0, 0], [1]]) expect(read).toContain(`framePath=${JSON.stringify(path)}`);
  }
});

test("missing or detached paths fail before an element action", () => {
  const root = frame("Shell", [frame("Detached", [], true)]);
  expect(() => resolveBrowserFrame(root, [1])).toThrow();
  expect(() => resolveBrowserFrame(root, [0])).toThrow();
});

test("unavailable frames keep readable siblings and hide exception content", async () => {
  const bad = frame("unused");
  bad.locator = () => { throw new Error("private exception content"); };
  const root = frame("Shell", [frame("Detached", [], true), bad, frame("Readable sibling")]);
  const read = await readBrowserFrames(root, "text", 20_000, 1000);
  expect(read).toContain("Readable sibling");
  expect(read).toContain("framePath=[2]");
  expect(read).not.toContain("private exception content");
  expect(read).not.toContain("Detached");
});

test("one output budget covers root, frame boundaries and child content", async () => {
  const root = frame("root", [frame("x".repeat(500)), frame("omitted sibling")]);
  for (const action of ["text", "snapshot"] as const) {
    const read = await readBrowserFrames(root, action, 100, 1000);
    expect(read.length).toBe(100);
    expect(read).toContain("root");
    expect(read).toContain("framePath=[0]");
    expect(read).not.toContain("omitted sibling");
  }
  expect((await readBrowserFrames(frame("Shell", Array.from({ length: 100 }, () => frame("child"))), "text", 20_000, 1000)).match(/framePath=/g)).toHaveLength(63);
});
