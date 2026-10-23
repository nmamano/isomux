import { describe, expect, it } from "bun:test";
import {
  cronjobFormDirty,
  type CronjobFormSnapshot,
} from "./CronjobDialog.tsx";

const CLAUDE_CREATE: CronjobFormSnapshot = {
  name: "",
  scheduleType: "daily",
  hourStr: "9",
  minuteStr: "0",
  weekday: 1,
  intervalStr: "60",
  prompt: "",
  cwd: "~",
  agentType: "claude",
  modelFamily: "opus",
  effort: "high",
  permissionMode: "bypassPermissions",
  codexSandbox: "workspace-write",
  enabled: true,
  roomId: "",
};

describe("cronjobFormDirty", () => {
  it("counts each form field as dirty on its own", () => {
    const edits: Array<Partial<CronjobFormSnapshot>> = [
      { name: "Daily review" },
      { scheduleType: "weekly" },
      { hourStr: "10" },
      { minuteStr: "30" },
      { weekday: 2 },
      { intervalStr: "120" },
      { prompt: "Review the office." },
      { cwd: "~/nil/isomux" },
      { agentType: "codex" },
      { modelFamily: "sonnet" },
      { effort: "medium" },
      { permissionMode: "never" },
      { codexSandbox: "read-only" },
      { enabled: false },
      { roomId: "a1b2c3d4" },
    ];
    for (const edit of edits) {
      expect(
        cronjobFormDirty({ ...CLAUDE_CREATE, ...edit }, CLAUDE_CREATE),
      ).toBe(true);
    }
  });

  it("ignores whitespace-only edits in free-text fields", () => {
    const baseline = {
      ...CLAUDE_CREATE,
      name: "Daily review",
      prompt: "Review the office.",
      cwd: "~/nil/isomux",
    };
    expect(
      cronjobFormDirty(
        {
          ...baseline,
          name: " Daily review ",
          prompt: " Review the office.\n",
          cwd: "~/nil/isomux ",
        },
        baseline,
      ),
    ).toBe(false);
  });
});
