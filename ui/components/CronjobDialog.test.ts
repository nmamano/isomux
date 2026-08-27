import { describe, expect, it } from "bun:test";
import {
  cronjobFormDirty,
  updateCronjobMachineDefaults,
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
};

const CODEX_CREATE: CronjobFormSnapshot = {
  ...CLAUDE_CREATE,
  agentType: "codex",
  modelFamily: "gpt-fallback",
  permissionMode: "never",
};

describe("cronjobFormDirty", () => {
  it("does not prompt for untouched Claude create and edit forms", () => {
    expect(cronjobFormDirty({ ...CLAUDE_CREATE }, CLAUDE_CREATE)).toBe(false);
    const edit = {
      ...CLAUDE_CREATE,
      name: "Daily review",
      prompt: "Review the office.",
    };
    expect(cronjobFormDirty({ ...edit }, edit)).toBe(false);
  });

  it("does not prompt for untouched Codex create and edit forms after model fetch", () => {
    const createBaseline = { ...CODEX_CREATE };
    updateCronjobMachineDefaults(createBaseline, "gpt-live", "medium");
    expect(
      cronjobFormDirty(
        { ...CODEX_CREATE, modelFamily: "gpt-live", effort: "medium" },
        createBaseline,
      ),
    ).toBe(false);

    const edit = {
      ...CODEX_CREATE,
      name: "Codex review",
      prompt: "Review the office.",
    };
    expect(cronjobFormDirty({ ...edit }, edit)).toBe(false);
  });

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
