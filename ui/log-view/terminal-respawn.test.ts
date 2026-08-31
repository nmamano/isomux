import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { resetTerminalForRespawn } from "./TerminalPanel.tsx";

describe("resetTerminalForRespawn", () => {
  it("fully resets xterm before the replacement PTY prints its prompt", () => {
    let resets = 0;
    resetTerminalForRespawn({
      reset() {
        resets++;
      },
    });
    expect(resets).toBe(1);

    const source = readFileSync(
      new URL("./TerminalPanel.tsx", import.meta.url),
      "utf8",
    );
    const handleRespawn = source.match(
      /function handleRespawn\(\) \{([\s\S]*?)\n {2}\}/u,
    )?.[1];
    expect(handleRespawn).toContain("resetTerminalForRespawn(termRef.current)");
    expect(handleRespawn).not.toContain(".clear(");
  });
});
