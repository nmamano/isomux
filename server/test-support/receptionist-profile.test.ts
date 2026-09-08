import { describe, it, expect } from "bun:test";
import { renderReceptionistProfile } from "../receptionist-profile.ts";
import { ISOMUX_KNOWLEDGE } from "../../api/chat.ts";
import { RECEPTIONIST_INSTRUCTIONS, RECEPTIONIST_OUTFIT } from "../../shared/receptionist-profile.ts";
import { AGENT_TEMPLATES, templateEngineValues } from "../../shared/agent-templates.ts";

describe("receptionist profile renderer", () => {
  it("includes shared knowledge byte for byte and renders office guidance at spawn", () => {
    const text = renderReceptionistProfile({officeName: "Acme", members: [{name: "Boss", role: "owner"}, {name: "Mia", role: "member"}], publicOrigin: "https://office.example.com"});
    expect(text).toContain(ISOMUX_KNOWLEDGE);
    expect(text.startsWith(RECEPTIONIST_INSTRUCTIONS)).toBe(true);
    expect(text).toContain('Owners: "Boss". Members: "Mia".');
    expect(text).toContain("Office name: Acme.");
    expect(text).toContain("The office is at https://office.example.com.");
    expect(text).toContain("Never ask for or repeat secrets");
    expect(text).not.toContain("What you can and cannot see");
    expect(text).not.toContain("you cannot message other agents");
  });
  it("keeps the profile in the template list with its original outfit and bypass permissions", () => {
    const profile = AGENT_TEMPLATES.find((p) => p.key === "isomux-receptionist")!;
    expect(profile).toBeDefined();
    expect(profile.outfit).toEqual(RECEPTIONIST_OUTFIT);
    expect(profile.customInstructions).toBe(RECEPTIONIST_INSTRUCTIONS);
    for (const engine of ["claude", "codex", "opencode"] as const) {
      expect(templateEngineValues(profile, engine, {modelFamily: "sonnet", effort: "medium", permissionMode: "default"}, [], false).permissionMode).toBe("bypassPermissions");
    }
  });
});
