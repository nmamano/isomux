import { describe, expect, it } from "bun:test";
import { registerCompactDomMatchers, setUpDomTestFile } from "./dom.ts";

setUpDomTestFile();

function failure(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected matcher to fail");
}

describe("compact DOM matcher replacements", () => {
  it("keeps Bun pass, fail, and not semantics", () => {
    const same = {};
    const cases = [
      ["toBe", NaN, NaN, true],
      ["toBe", 0, -0, false],
      ["toBe", same, same, true],
      ["toBe", {}, {}, false],
      ["toBeNull", null, undefined, true],
      ["toBeNull", undefined, undefined, false],
      ["toBeUndefined", undefined, undefined, true],
      ["toBeUndefined", null, undefined, false],
      ["toBeFalsy", 0, undefined, true],
      ["toBeFalsy", "", undefined, true],
      ["toBeFalsy", false, undefined, true],
      ["toBeFalsy", 1, undefined, false],
    ] as const;

    for (const [matcher, actual, wanted, passes] of cases) {
      const positive = () => {
        if (matcher === "toBe") expect(actual).toBe(wanted);
        else if (matcher === "toBeNull") expect(actual).toBeNull();
        else if (matcher === "toBeUndefined") expect(actual).toBeUndefined();
        else expect(actual).toBeFalsy();
      };
      const negative = () => {
        if (matcher === "toBe") expect(actual).not.toBe(wanted);
        else if (matcher === "toBeNull") expect(actual).not.toBeNull();
        else if (matcher === "toBeUndefined")
          expect(actual).not.toBeUndefined();
        else expect(actual).not.toBeFalsy();
      };
      if (passes) {
        positive();
        expect(() => negative()).toThrow();
      } else {
        expect(() => positive()).toThrow();
        negative();
      }
    }
  });

  it("keeps ordinary string and object failures readable", () => {
    const stringMessage = failure(() => expect("left").toBe("right"));
    const objectMessage = failure(() =>
      expect<unknown>({ left: 1 }).toBe({ right: 2 }),
    );
    expect(stringMessage.includes("left")).toBe(true);
    expect(stringMessage.includes("right")).toBe(true);
    expect(objectMessage.includes("left")).toBe(true);
    expect(objectMessage.includes("right")).toBe(true);
  });

  it("keeps a raw-node assertion mutant failure message bounded", () => {
    const button = document.createElement("button");
    button.id = "save";
    button.className = "primary action";
    document.body.append(button);
    const message = failure(() => expect(button).toBeNull());
    expect(message.length).toBeLessThan(200);
    expect(message.includes("<button#save.primary.action>")).toBe(true);
  });

  it("registers twice without changing matcher behavior", () => {
    registerCompactDomMatchers();
    expect(NaN).toBe(NaN);
    expect(null).toBeNull();
  });
});
