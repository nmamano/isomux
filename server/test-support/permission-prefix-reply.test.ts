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

// These assertions are about ORDER and resolution, not wording, so they run on
// the English translator and keep every string they always had
// (internal-docs/i18n-loop.md, S7).
const t = english.t;

describe("permission options", () => {
  it("keeps button values identical to typed numbers for every option shape", () => {
    const shapes = [
      [undefined, undefined],
      ["Allow for session", undefined],
      [undefined, "git"],
      ["Allow for session", "git"],
    ] as const;
    for (const [persistent, prefix] of shapes) {
      const options = permissionOptions(t, persistent, prefix);
      const choices = permissionInteractionChoices(t, persistent, prefix);
      expect(choices).toHaveLength(options.length);
      for (const [index, choice] of choices.entries()) {
        const typed = String(index + 1);
        expect(choice.value).toBe(typed);
        expect(choice.label).toBe(options[index].label);
        expect(resolvePermissionReply(choice.value, options)).toEqual(
          resolvePermissionReply(typed, options),
        );
      }
    }
  });

  function renderedChoices(
    allowPersistentLabel?: string,
    allowPrefixLabel?: string,
  ): Array<{ label: string; decision: string }> {
    const options = permissionOptions(t, allowPersistentLabel, allowPrefixLabel);
    const lines = permissionPromptLines(t, {
      toolName: "Bash",
      allowPersistentLabel,
      allowPrefixLabel,
    });
    return lines
      .map((line) => /^ {2}(\d+)\. (.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({
        label: match[2],
        decision:
          resolvePermissionReply(match[1], options)?.kind ?? "deny_reason",
      }));
  }

  it("round-trips every rendered option through the same ordered choices", () => {
    expect(renderedChoices("Allow always")).toEqual([
      { label: "Allow always", decision: "allow_persistent" },
      { label: "Allow - just this time", decision: "allow_once" },
      { label: "Deny", decision: "deny" },
    ]);
    expect(renderedChoices()).toEqual([
      { label: "Allow - just this time", decision: "allow_once" },
      { label: "Deny", decision: "deny" },
    ]);
    expect(renderedChoices("Allow always", "rg --files")).toEqual([
      { label: "Allow always", decision: "allow_persistent" },
      { label: "Allow - just this time", decision: "allow_once" },
      { label: "Deny", decision: "deny" },
      {
        label:
          "Allow - and don't ask again this session for any command starting with `rg --files`",
        decision: "allow_prefix",
      },
    ]);
    expect(renderedChoices(undefined, "rg --files")).toEqual([
      { label: "Allow - just this time", decision: "allow_once" },
      { label: "Deny", decision: "deny" },
      {
        label:
          "Allow - and don't ask again this session for any command starting with `rg --files`",
        decision: "allow_prefix",
      },
    ]);
  });

  it("maps the persistent three-option menu", () => {
    const options = permissionOptions(t, "Allow always");
    expect(resolvePermissionReply("1", options)).toEqual({
      kind: "allow_persistent",
    });
    expect(resolvePermissionReply("2", options)).toEqual({
      kind: "allow_once",
    });
    expect(resolvePermissionReply("3", options)).toEqual({ kind: "deny" });
  });

  it("maps the OpenCode two-option menu and never allows an absent number", () => {
    const options = permissionOptions(t);
    expect(resolvePermissionReply("1", options)).toEqual({
      kind: "allow_once",
    });
    expect(resolvePermissionReply("2", options)).toEqual({ kind: "deny" });
    expect(resolvePermissionReply("3", options)).toBeNull();
  });

  it("renumbers prefix replies with and without a persistent choice", () => {
    const four = permissionOptions(t, "Allow always", "rg --files");
    expect(resolvePermissionReply("4 rg", four)).toEqual({
      kind: "allow_prefix",
      prefixText: "rg",
    });
    const three = permissionOptions(t, undefined, "rg --files");
    expect(resolvePermissionReply("3 rg", three)).toEqual({
      kind: "allow_prefix",
      prefixText: "rg",
    });
    expect(resolvePermissionReply("4", three)).toBeNull();
  });

  it("rejects numeric near-misses for every offered menu shape", () => {
    const shapes = [
      permissionOptions(t, "Allow always"),
      permissionOptions(t),
      permissionOptions(t, "Allow always", "rg --files"),
      permissionOptions(t, undefined, "rg --files"),
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

  it("keeps Claude and Codex prompt bytes and starts OpenCode at one", () => {
    expect(
      permissionPromptLines(t, {
        toolName: "Bash",
        allowPersistentLabel:
          "Allow - and don't ask again for similar calls this session",
      }).join("\n"),
    ).toBe(
      "**Wants to use Bash**\n\nReply:\n  1. Allow - and don't ask again for similar calls this session\n  2. Allow - just this time\n  3. Deny\n\nOr type any other message to deny with that as the reason.",
    );
    expect(
      permissionPromptLines(t, {
        toolName: "Bash",
        allowPersistentLabel:
          "Allow - and don't ask again for this exact command this session",
        allowPrefixLabel: "rg --files",
        allowPrefixExample: "rg",
      }).join("\n"),
    ).toBe(
      "**Wants to use Bash**\n\nReply:\n  1. Allow - and don't ask again for this exact command this session\n  2. Allow - just this time\n  3. Deny\n  4. Allow - and don't ask again this session for any command starting with `rg --files`\n     Reply `4 <prefix>` to choose how much to allow, e.g. `4 rg`.\n\nOr type any other message to deny with that as the reason.",
    );
    expect(permissionPromptLines(t, { toolName: "bash" }).join("\n")).toBe(
      "**Wants to use bash**\n\nReply:\n  1. Allow - just this time\n  2. Deny\n\nOr type any other message to deny with that as the reason.",
    );
  });
});
