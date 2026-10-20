import { describe, expect, it } from "bun:test";
import { english } from "./i18n.ts";
import { renderLogText, type LogPart } from "../shared/i18n/log-message.ts";
import {
  mergeSettingsNotice,
  renderSettingsNotice,
  type SettingsNoticeArm,
} from "./settings-notice.ts";

const t = english.t;
// The notice is message parts each reader words (task c37a7365); these
// checks read the English render.
const render = (parts: LogPart[]) => renderLogText(english, parts);
const claude = { agentType: "claude" as const, claudeFamilyModels: {} };

const arm = (
  changes: SettingsNoticeArm["changes"],
  by = "Boss",
  interrupted = false,
): SettingsNoticeArm => ({ changes, by: [by], interrupted });

describe("mergeSettingsNotice", () => {
  it("a setting back at its old value drops out; nothing left is no notice", () => {
    const first = mergeSettingsNotice(
      null,
      arm({ effort: { from: "high", to: "low" } }),
    );
    expect(
      mergeSettingsNotice(first, arm({ effort: { from: "low", to: "high" } })),
    ).toBeNull();
  });

  it("an interruption stays when the changes cancel out", () => {
    const first = mergeSettingsNotice(
      null,
      arm({ effort: { from: "high", to: "low" } }, "Boss", true),
    );
    const merged = mergeSettingsNotice(
      first,
      arm({ effort: { from: "low", to: "high" } }, "Lead"),
    );
    expect(merged).toEqual({
      changes: {},
      by: ["Boss", "Lead"],
      interrupted: true,
    });
  });

  it("names each caller once, in order", () => {
    let a = mergeSettingsNotice(null, arm({ effort: { from: "a", to: "b" } }));
    a = mergeSettingsNotice(a, arm({ effort: { from: "b", to: "c" } }, "Lead"));
    a = mergeSettingsNotice(a, arm({ effort: { from: "c", to: "d" } }));
    expect(a?.by).toEqual(["Boss", "Lead"]);
    expect(a?.changes.effort).toEqual({ from: "a", to: "d" });
  });
});

describe("renderSettingsNotice", () => {
  const interrupted = arm({}, "Boss", true);

  it("adds the rejection sentence only when the transcript proves it", () => {
    const without = render(renderSettingsNotice(interrupted, claude, false));
    const withIt = render(renderSettingsNotice(interrupted, claude, true));
    expect(without).toContain(t("systemEntries.wake.inFlightWarning"));
    expect(without).not.toContain(t("systemEntries.wake.shutdownRejection"));
    expect(withIt).toContain(t("systemEntries.wake.shutdownRejection"));
  });

  it("a value with no dialog words shows as itself", () => {
    const text = render(
      renderSettingsNotice(
        arm({ permissionMode: { from: "default", to: "plan" } }),
        claude,
        false,
      ),
    );
    expect(text.split("\n")[1]).toBe(
      t("systemEntries.settingsNotice.change", {
        setting: t("common.field.permissionMode"),
        from: t("dialogs.agent.permission.claudeDefault"),
        to: "plan",
      }),
    );
  });
});
