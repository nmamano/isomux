// The visible part of the window, from the visual viewport (task f134b222).
// The keyboard shrinks the visual viewport and iOS can move it down; WebKit
// in the iPhone Home Screen app can report an offsetTop the window cannot
// hold. The area always stays inside the window.
import { describe, expect, it } from "bun:test";
import { visibleArea } from "./visible-area.ts";

describe("visibleArea", () => {
  it("is the whole window when the keyboard is closed", () => {
    expect(visibleArea(844, { height: 844, offsetTop: 0 })).toEqual({
      top: 0,
      height: 844,
    });
  });

  it("is the part above the keyboard, where iOS scrolled it", () => {
    expect(visibleArea(844, { height: 400, offsetTop: 0 })).toEqual({
      top: 0,
      height: 400,
    });
    expect(visibleArea(844, { height: 400, offsetTop: 150 })).toEqual({
      top: 150,
      height: 400,
    });
  });

  it("stays inside the window when the offset reported is past its end", () => {
    // The Home Screen app: the window shrank to 400 with the keyboard, and
    // WebKit still reports the visual viewport 380px down.
    expect(visibleArea(400, { height: 400, offsetTop: 380 })).toEqual({
      top: 0,
      height: 400,
    });
    expect(visibleArea(844, { height: 400, offsetTop: 600 })).toEqual({
      top: 444,
      height: 400,
    });
    // An overscroll bounce reports a negative offset.
    expect(visibleArea(844, { height: 400, offsetTop: -30 })).toEqual({
      top: 0,
      height: 400,
    });
  });

  it("is never taller than the window", () => {
    expect(visibleArea(400, { height: 844, offsetTop: 0 })).toEqual({
      top: 0,
      height: 400,
    });
  });
});
