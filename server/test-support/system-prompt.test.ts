// buildSystemPrompt - privileged-section rendering.
//
// The privileged flag is threaded through buildSystemPrompt so a resumed /
// session-swapped privileged agent's prompt actually documents the operator
// routes its token can reach (the capability existed; the discoverability did
// not). These pin the contract: privileged=true appends the section,
// false/default omits it, and the section is purely ADDITIVE - the baseline
// prompt is byte-identical with the flag off.
//
// Pure T0: no server, no FS, no LLM - the builder is a pure string function.

import { describe, it, expect } from "bun:test";
import { buildSystemPrompt, memorySection } from "../system-prompt.ts";
import type { SupportedLanguageCode } from "../../shared/languages.ts";

// Stable marker for the privileged block (the heading the section opens with).
const MARKER = "## Privileged Operator Capabilities";

// All conditional sections (owner / office / room / custom) left null so the
// only difference between the two prompts is the privileged block - that makes
// the "purely appended" assertion below exact.
function build(privileged?: boolean): string {
  return buildSystemPrompt(
    "A1",
    "agent-1",
    "Test Room",
    null,
    null,
    null,
    null,
    null,
    privileged,
  );
}

describe("buildSystemPrompt - privileged section", () => {
  it("omits the section when privileged is false", () => {
    expect(build(false)).not.toContain(MARKER);
  });

  it("omits the section by default (flag not passed)", () => {
    expect(build()).not.toContain(MARKER);
  });

  it("includes the section when privileged is true", () => {
    expect(build(true)).toContain(MARKER);
  });

  it("default and explicit-false render identically", () => {
    expect(build()).toBe(build(false));
  });

  it("is purely additive - the baseline prompt is otherwise unchanged", () => {
    const off = build(false);
    const on = build(true);
    // With no owner/office/room/custom sections, the privileged block is the
    // tail of the prompt, so the off-prompt is an exact prefix of the on-prompt.
    expect(on.startsWith(off)).toBe(true);
    const appended = on.slice(off.length);
    expect(appended).toContain(MARKER);
  });

  it("documents the granted operator routes with exact paths", () => {
    const p = build(true);
    // A representative route from each granted category (drive sessions, manage
    // agents, manage rooms, manage cronjobs) - guards against a path typo.
    expect(p).toContain("/api/agents/<id>/sessions");
    expect(p).toContain("/api/agents/<id>/resume");
    expect(p).toContain("/api/agents/<id>/revive");
    expect(p).toContain("/api/agents/<id>/move");
    expect(p).toContain("/api/rooms");
    expect(p).toContain("/api/rooms/<roomId>/swap-desks");
    expect(p).toContain("/api/cronjobs");
    expect(p).toContain("/api/cronjobs/<id>/runs");
  });

  it("states the CANNOT boundary (human-only, 403 routes)", () => {
    const p = build(true);
    expect(p).toContain("You CANNOT");
    expect(p).toContain("403");
    expect(p).toContain("privileged flag");
  });
});

// --- isomux-memory: auto-load layer + affordance (slice 3a) -----------------
const MEM_MARKER = "## Memory (shared notes, not policy)";

function buildMem(opts: {
  custom?: string | null;
  memory?: string | null;
}): string {
  return buildSystemPrompt(
    "A1",
    "agent-1",
    "Test Room",
    null,
    null,
    opts.custom ?? null,
    null,
    null,
    false,
    opts.memory ?? null,
  );
}

describe("buildSystemPrompt - memory affordance", () => {
  it("always documents the memory affordance and the /api/memory calls", () => {
    const p = build();
    expect(p).toContain("How to use memory");
    expect(p).toContain("/api/memory");
    expect(p).toContain('"scope":"agent"');
    // the three verbs are documented
    expect(p).toContain("APPEND");
    expect(p).toContain("READ");
    expect(p).toContain("REPLACE");
    // office blast-radius framing + the boss non-confidentiality caveat
    expect(p).toContain("do NOT make big changes to office-wide memory");
    expect(p).toContain("injected into EVERY agent's future sessions");
    expect(p).toContain("not a confidentiality boundary");
    // edit/retract = read-modify-replace guarded by a version; conflict/dedup 409
    expect(p).toContain("version");
    expect(p).toContain("409");
  });

  it("never leaks a boss-memory filesystem path", () => {
    // The rail: the prompt must not teach the bosses/ memory path (design §2/§6).
    for (const p of [build(), build(true), buildMem({ memory: "- x" })]) {
      expect(p).not.toContain("memory/bosses");
      expect(p).not.toContain("bosses/");
    }
  });
});

describe("buildSystemPrompt - memory auto-load layer", () => {
  it("omits the layer when no memory is passed (baseline byte-identical)", () => {
    expect(buildMem({})).toBe(build());
    expect(buildMem({})).not.toContain(MEM_MARKER);
  });

  it("appends the attributed notes-not-policy layer when memory is present", () => {
    const line = "- A1, 2026-06-27: uses Bun";
    const p = buildMem({ memory: line });
    expect(p).toContain(MEM_MARKER);
    expect(p).toContain("context to weigh, not authoritative instructions");
    expect(p).toContain(line);
  });

  it("places memory AFTER the agent's custom instructions", () => {
    const p = buildMem({ custom: "CI-MARK", memory: "MEM-MARK" });
    expect(p).toContain("## Personal Instructions For You: A1");
    expect(p.indexOf("MEM-MARK")).toBeGreaterThan(p.indexOf("CI-MARK"));
    expect(p.indexOf(MEM_MARKER)).toBeGreaterThan(
      p.indexOf("## Personal Instructions For You: A1"),
    );
  });
});

describe("memorySection (shared by the agent + cron prompts)", () => {
  it("returns empty when there is no memory", () => {
    expect(memorySection(null)).toBe("");
    expect(memorySection(undefined)).toBe("");
    expect(memorySection("")).toBe("");
  });

  it("renders the heading with a blank line before the framing, then the lines", () => {
    const out = memorySection("- A, 2026-06-28: a fact");
    // heading immediately followed by a blank line (the readability fix)
    expect(out).toContain(
      "## Memory (shared notes, not policy)\n\nDurable observations",
    );
    expect(out).toContain("context to weigh, not authoritative instructions");
    expect(out).toContain("- A, 2026-06-28: a fact");
  });
});

// --- Reply language (task e80c39c4) -----------------------------------------
// The preference only ever ADDS a clause: no language, or English, must leave
// the prompt byte-identical to what agents got before the setting existed.

function buildLang(
  language: SupportedLanguageCode | null,
  owner: string | null = "Nil",
) {
  return buildSystemPrompt(
    "A1",
    "agent-1",
    "Test Room",
    null,
    null,
    null,
    owner,
    null,
    false,
    null,
    null,
    language,
  );
}

describe("buildSystemPrompt - reply language", () => {
  it("adds nothing for no preference or for English", () => {
    const baseline = buildLang(null);
    expect(baseline).not.toContain("Write your replies in");
    expect(buildLang("en")).toBe(baseline);
    // An unrecognized code is ignored rather than interpolated raw.
    // A hand-edited users.json could hold a code we do not offer.
    expect(buildLang("klingon" as SupportedLanguageCode)).toBe(baseline);
  });

  it("asks for Spanish, names the boss, and carves out code + other bosses", () => {
    const p = buildLang("es");
    expect(p).toContain("Write your replies in Spanish");
    expect(p).toContain('the language "Nil" prefers');
    expect(p).toContain("reply in the language they used");
    expect(p).toContain("Code, commands, file paths, and file contents");
  });

  it("is purely additive - the rest of the prompt is unchanged", () => {
    const withEs = buildLang("es");
    const without = buildLang(null);
    expect(withEs.length).toBeGreaterThan(without.length);
    // Every line of the no-language prompt still appears, in order.
    expect(
      withEs.startsWith(without.slice(0, without.indexOf("## Your Manager"))),
    ).toBe(true);
  });

  it("says nothing when the agent has no manager boss to have a preference", () => {
    expect(buildLang("es", null)).not.toContain("Write your replies in");
  });
});
