// Which ask commands get the one-tap Run (task c3b91695): a command that
// shows as it runs. A character that the card draws as nothing, or that moves
// what the card draws, keeps the command on Copy to terminal only.

import { describe, expect, it } from "bun:test";

import { isRunnableCommand } from "./runnable-command.ts";

describe("isRunnableCommand", () => {
  it("runs a command whose every character shows", () => {
    for (const command of [
      "bun test server/asks.test.ts",
      "git log --oneline -3 && echo 'done: ok'",
      // A tab shows as space on the card, as it does in a terminal.
      "printf 'a\\tb'\tdone",
      "echo café 日本語 ✓",
    ])
      expect({ command, runnable: isRunnableCommand(command) }).toEqual({
        command,
        runnable: true,
      });
  });

  it("refuses a control character or a Unicode format character", () => {
    for (const [name, ch] of [
      ["ESC", "\u001b"],
      ["BS", "\u0008"],
      ["NUL", "\u0000"],
      ["DEL", "\u007f"],
      ["C1 CSI", "\u009b"],
      ["RIGHT-TO-LEFT OVERRIDE", "\u202e"],
      ["LEFT-TO-RIGHT ISOLATE", "\u2066"],
      ["ZERO WIDTH SPACE", "\u200b"],
      ["BYTE ORDER MARK", "\ufeff"],
      ["SOFT HYPHEN", "\u00ad"],
    ])
      expect({ name, runnable: isRunnableCommand(`ls ${ch}-la`) }).toEqual({
        name,
        runnable: false,
      });
  });
});
