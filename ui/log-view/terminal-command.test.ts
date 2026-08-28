import { describe, expect, it } from "bun:test";
import { commandInputBytes } from "./terminal-command.ts";

describe("commandInputBytes", () => {
  it("clears the full input line and leaves the command unexecuted", () => {
    const bytes = commandInputBytes("expr 6 \\* 7");
    expect(bytes).toBe("\x05\x15expr 6 \\* 7");
    expect(bytes).not.toMatch(/[\r\n]/u);
    expect(bytes).not.toContain("\x03");
  });
});
