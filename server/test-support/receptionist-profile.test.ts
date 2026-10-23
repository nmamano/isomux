import { describe, it, expect } from "bun:test";
import { renderReceptionistProfile } from "../receptionist-profile.ts";
import { ISOMUX_KNOWLEDGE } from "../../api/chat.ts";
import {
  RECEPTIONIST_INSTRUCTIONS,
  RECEPTIONIST_PROFILE_KEY,
} from "../../shared/receptionist-profile.ts";
import {
  AGENT_TEMPLATES,
  templateEngineValues,
} from "../../shared/agent-templates.ts";

describe("receptionist profile renderer", () => {
  it("includes shared knowledge byte for byte and renders the office's name, people by role and origin", () => {
    const render = (role: "owner" | "member") =>
      renderReceptionistProfile({
        officeName: "Acme",
        members: [{ name: "Morgan", role }],
        publicOrigin: "https://office.example.com",
      });
    const text = render("owner");
    expect(text.startsWith(RECEPTIONIST_INSTRUCTIONS)).toBe(true);
    expect(text).toContain(ISOMUX_KNOWLEDGE);
    expect(text).toContain("Acme");
    expect(text).toContain(JSON.stringify("Morgan"));
    expect(text).toContain("https://office.example.com");
    // The role decides where the name goes.
    expect(render("member")).toContain(JSON.stringify("Morgan"));
    expect(render("member")).not.toBe(text);
  });

  // The only proof: the spawn dialog's tests stay green without this branch.
  it("the profile template picks bypass permissions on every engine", () => {
    const profile = AGENT_TEMPLATES.find(
      (p) => p.key === RECEPTIONIST_PROFILE_KEY,
    )!;
    for (const engine of ["claude", "codex", "opencode"] as const) {
      const values = templateEngineValues(
        profile,
        engine,
        { modelFamily: "sonnet", effort: "medium", permissionMode: "default" },
        [],
        false,
      );
      expect({ engine, mode: values.permissionMode }).toEqual({
        engine,
        mode: "bypassPermissions",
      });
    }
  });
});
