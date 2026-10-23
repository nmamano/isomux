// Permission replies are a safety boundary in both directions: every number
// shown must resolve to its label, while malformed and unshown numbers must
// fall through to denial instead of silently widening what the agent may run.
import { describe, expect, it } from "bun:test";

import {
  permissionInteractionChoices,
  permissionOptions,
  permissionPromptLines,
  resolvePermissionReply,
} from "../agent-manager.ts";
import { english } from "../i18n.ts";
import { renderLogText, type LogPart } from "../../shared/i18n/log-message.ts";

// These assertions are about ORDER and resolution, not wording. The prompt is
// message parts each reader words (task c37a7365); they read its English
// render and keep every string they always had.
const promptText = (parts: LogPart[]) => renderLogText(english, parts);

describe("permission options", () => {
  it("keeps button values identical to typed numbers for every option shape", () => {
    const shapes = [
      [undefined, undefined],
      ["Allow for session", undefined],
      [undefined, "git"],
      ["Allow for session", "git"],
    ] as const;
    for (const [persistent, prefix] of shapes) {
      const options = permissionOptions(persistent, prefix);
      const choices = permissionInteractionChoices(persistent, prefix);
      expect(choices).toHaveLength(options.length);
      for (const [index, choice] of choices.entries()) {
        const typed = String(index + 1);
        expect(choice.value).toBe(typed);
        expect(choice.label).toEqual(options[index].label);
        expect(resolvePermissionReply(choice.value, options)).toEqual(
          resolvePermissionReply(typed, options),
        );
      }
    }
  });

  // The numbered rows of the typed-reply prompt, each resolved through the
  // menu the prompt was built from. A row's label must be the label of the
  // option its number picks.
  function renderedDecisions(
    allowPersistentLabel?: string,
    allowPrefixLabel?: string,
  ): { decisions: string[]; labels: string[]; text: string } {
    const options = permissionOptions(allowPersistentLabel, allowPrefixLabel);
    const text = promptText(
      permissionPromptLines({
        toolName: "Bash",
        allowPersistentLabel,
        allowPrefixLabel,
        allowPrefixExample: "rg",
      }),
    );
    const rows = text
      .split("\n")
      .map((line) => /^ {2}(\d+)\. (.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null);
    expect(rows.length).toBeGreaterThan(0);
    for (const [, number, label] of rows)
      expect(label).toBe(
        renderLogText(english, [options[Number(number) - 1].label]),
      );
    return {
      text,
      labels: rows.map(([, , label]) => label),
      decisions: rows.map(
        ([, number]) =>
          resolvePermissionReply(number, options)?.kind ?? "deny_reason",
      ),
    };
  }

  it("round-trips every rendered option through the same ordered choices", () => {
    expect(renderedDecisions("Allow always").decisions).toEqual([
      "allow_persistent",
      "allow_once",
      "deny",
    ]);
    expect(renderedDecisions().decisions).toEqual(["allow_once", "deny"]);
    const four = renderedDecisions("Allow always", "rg --files");
    expect(four.decisions).toEqual([
      "allow_persistent",
      "allow_once",
      "deny",
      "allow_prefix",
    ]);
    // What a click grants is on its row: the backend's own persistent label,
    // and the prefix the agent asked for.
    expect(four.labels[0]).toBe("Allow always");
    expect(four.labels[3]).toContain("`rg --files`");
    // The prefix hint names the number its row carries.
    expect(four.text).toContain("`4 <prefix>`");
    const three = renderedDecisions(undefined, "rg --files");
    expect(three.decisions).toEqual(["allow_once", "deny", "allow_prefix"]);
    expect(three.text).toContain("`3 <prefix>`");
  });

  it("renumbers prefix replies with and without a persistent choice", () => {
    const four = permissionOptions("Allow always", "rg --files");
    expect(resolvePermissionReply("4 rg", four)).toEqual({
      kind: "allow_prefix",
      prefixText: "rg",
    });
    const three = permissionOptions(undefined, "rg --files");
    expect(resolvePermissionReply("3 rg", three)).toEqual({
      kind: "allow_prefix",
      prefixText: "rg",
    });
    expect(resolvePermissionReply("4", three)).toBeNull();
  });

  it("rejects numeric near-misses for every offered menu shape", () => {
    const shapes = [
      permissionOptions("Allow always"),
      permissionOptions(),
      permissionOptions("Allow always", "rg --files"),
      permissionOptions(undefined, "rg --files"),
    ];
    for (const options of shapes) {
      for (const reply of [
        "42",
        "4x",
        "-4",
        "44 rg",
        "01",
        "001",
        "02",
        "",
        "no",
        "please allow 4",
      ]) {
        expect(resolvePermissionReply(reply, options)).toBeNull();
      }
    }
    expect(resolvePermissionReply("3", shapes[0])).toEqual({ kind: "deny" });
    expect(resolvePermissionReply("3", shapes[1])).toBeNull();
    expect(resolvePermissionReply("3", shapes[2])).toEqual({ kind: "deny" });
    expect(resolvePermissionReply("3", shapes[3])).toEqual({
      kind: "allow_prefix",
    });
  });
});
