// The PTY resize policy (task 15cb8cf7): a burst of requests while a window is
// dragged reaches the PTY as one resize with the settled size; a size the PTY
// already has is not sent again; now() is for a PTY whose size is unknown
// (a new or restarted shell) and always sends.

import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { PTY_RESIZE_SETTLE_MS, createPtyResizer } from "./terminal-resize.ts";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function resizer() {
  const sent: string[] = [];
  const r = createPtyResizer((cols, rows) => sent.push(`${cols}x${rows}`));
  return { r, sent };
}

describe("createPtyResizer", () => {
  it("sends a burst once, with the last size, a settle period after the last request", () => {
    const { r, sent } = resizer();
    r.request(100, 30);
    jest.advanceTimersByTime(PTY_RESIZE_SETTLE_MS - 1);
    r.request(90, 28);
    jest.advanceTimersByTime(PTY_RESIZE_SETTLE_MS - 1);
    r.request(80, 26);
    expect(sent).toEqual([]);
    jest.advanceTimersByTime(PTY_RESIZE_SETTLE_MS - 1);
    expect(sent).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(sent).toEqual(["80x26"]);
    jest.advanceTimersByTime(PTY_RESIZE_SETTLE_MS * 10);
    expect(sent).toEqual(["80x26"]);
  });

  it("skips a settled size equal to the last one sent, in cols and in rows", () => {
    const { r, sent } = resizer();
    r.now(80, 24);
    r.request(100, 24);
    r.request(80, 24);
    jest.advanceTimersByTime(PTY_RESIZE_SETTLE_MS);
    expect(sent).toEqual(["80x24"]);
    // Only the rows change: that is a new size.
    r.request(80, 30);
    jest.advanceTimersByTime(PTY_RESIZE_SETTLE_MS);
    expect(sent).toEqual(["80x24", "80x30"]);
    // The comparison is with the last size sent, not the last requested.
    r.request(80, 30);
    jest.advanceTimersByTime(PTY_RESIZE_SETTLE_MS);
    expect(sent).toEqual(["80x24", "80x30"]);
  });

  it("now() sends at once, even an unchanged size, and replaces a pending request", () => {
    const { r, sent } = resizer();
    r.now(80, 24);
    r.request(120, 40);
    r.now(80, 24);
    expect(sent).toEqual(["80x24", "80x24"]);
    jest.advanceTimersByTime(PTY_RESIZE_SETTLE_MS * 10);
    expect(sent).toEqual(["80x24", "80x24"]);
    // now() records what it sent: a settled request for that size is skipped.
    r.request(100, 30);
    r.now(100, 30);
    r.request(100, 30);
    jest.advanceTimersByTime(PTY_RESIZE_SETTLE_MS);
    expect(sent).toEqual(["80x24", "80x24", "100x30"]);
  });

  it("sends nothing after dispose(), a pending request included", () => {
    const { r, sent } = resizer();
    r.request(100, 30);
    r.dispose();
    r.request(90, 30);
    r.now(80, 24);
    jest.advanceTimersByTime(PTY_RESIZE_SETTLE_MS * 10);
    expect(sent).toEqual([]);
  });
});
