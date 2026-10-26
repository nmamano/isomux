// Task e832fc7c: a Claude or Codex agent's own skill tool lists the bundled
// skills (wrap-session and the rest) with no member typing them. A session
// start links them into the skills folder of the provider home the agent's
// env names, or, for Codex with none, the office's own Codex home: the box
// home, or the member's personal home. A member's own skill of the same name
// wins, as on the Sk menu, whichever user skill root of the menu holds it.

import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { FakeBackend } from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import type { RoomWire } from "../../shared/types.ts";
import { STATE_ROOT } from "../config.ts";
import { createAgentManager } from "../agent-manager.ts";
import { personalProviderHome } from "../provider-homes.ts";
import { setPersonalProviderActiveProvider } from "../env-loader.ts";
import { ISOMUX_CODEX_HOME } from "../backends/codex/native-bin.ts";

const BUNDLED = ["figure-it-out", "grill-me", "loose-ends", "wrap-session"];

// The process that runs the tests may name its own provider homes; a session
// env built from it would put the links there.
const saved = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
const restore: (() => void)[] = [];
afterEach(() => {
  restore.splice(0).forEach((undo) => undo());
  for (const [name, value] of Object.entries(saved))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
});

// Where a link points, read one level; null when there is no link.
const target = (link: string) => {
  try {
    return resolve(dirname(link), readlinkSync(link));
  } catch {
    return null;
  }
};

function skillFolder(dir: string, text: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), text);
}

// A manager with box homes and bundled skills under the test state root.
// personalFor: the member ids whose personal provider homes are active.
function setup(
  tag: string,
  personalFor: string[],
  withBundled = true,
): {
  box: { claude: string; codex: string };
  // The provider home each engine reads in the box-home case.
  home: { claude: string; codex: string };
  bundled: string;
  start: (agentType: "claude" | "codex", memberId: string) => Promise<boolean>;
} {
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  const fake = new FakeBackend({
    session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
  });
  const box = {
    claude: join(STATE_ROOT, `bundled-${tag}-box-claude`),
    codex: join(STATE_ROOT, `bundled-${tag}-box-codex`),
  };
  const bundled = join(STATE_ROOT, `bundled-${tag}-skills`);
  // A Codex agent with no CODEX_HOME runs on the office's own Codex home,
  // one per test process; links an earlier test made there go first.
  expect(resolve(ISOMUX_CODEX_HOME).startsWith(resolve(STATE_ROOT))).toBe(true);
  rmSync(join(ISOMUX_CODEX_HOME, "skills"), { recursive: true, force: true });
  for (const name of BUNDLED)
    skillFolder(join(bundled, name), `bundled ${name}`);
  const previous = setPersonalProviderActiveProvider((userId) =>
    personalFor.includes(userId),
  );
  restore.push(() => setPersonalProviderActiveProvider(previous));
  const room = `room-bundled-${tag}`;
  const rooms: RoomWire[] = [
    { id: room, name: room, prompt: null, canCloseWhenEmpty: false },
  ];
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms }),
    initialRooms: [],
    providerSkillSourceRoots: box,
    ...(withBundled ? { bundledSkillsDir: bundled } : {}),
  });
  mgr.configureAgentTurnDeps();
  // A spawn is lazy: the first message starts the session.
  const start = async (agentType: "claude" | "codex", memberId: string) => {
    const info = (await mgr.spawn(
      `${agentType} ${tag}`,
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      room,
      undefined,
      undefined,
      "high",
      "Owner",
      agentType,
      undefined,
      memberId,
    ))!;
    void mgr.sendMessage(info.id, "hello", "Owner");
    const deadline = Date.now() + 2_000;
    while (!fake.sessionForAgent(info.id) && Date.now() < deadline)
      await Bun.sleep(5);
    return Boolean(fake.sessionForAgent(info.id));
  };
  return {
    box,
    home: { claude: box.claude, codex: ISOMUX_CODEX_HOME },
    bundled,
    start,
  };
}

describe("bundled skills at a Claude or Codex session start", () => {
  for (const agentType of ["claude", "codex"] as const) {
    it(`links them into the box home of a ${agentType} agent with no personal account`, async () => {
      const h = setup(`box-${agentType}`, []);
      expect(await h.start(agentType, "0b0c0d01")).toBe(true);
      const skills = join(h.home[agentType], "skills");
      expect(BUNDLED.map((name) => [name, target(join(skills, name))])).toEqual(
        BUNDLED.map((name) => [name, join(h.bundled, name)]),
      );
    });

    it(`leaves a name to a member skill in any user skill root of a ${agentType} agent's Sk menu`, async () => {
      const h = setup(`menu-${agentType}`, []);
      // The menu of either engine lists the box Claude and the box Codex
      // skills ahead of the bundled ones.
      skillFolder(
        join(h.box.codex, "skills", "wrap-session"),
        "member wrap-session",
      );
      skillFolder(join(h.box.claude, "skills", "grill-me"), "member grill-me");

      expect(await h.start(agentType, "0b0c0d05")).toBe(true);

      const skills = join(h.home[agentType], "skills");
      expect(BUNDLED.map((name) => [name, target(join(skills, name))])).toEqual(
        [
          ["figure-it-out", join(h.bundled, "figure-it-out")],
          ["grill-me", null],
          ["loose-ends", join(h.bundled, "loose-ends")],
          ["wrap-session", null],
        ],
      );
    });

    it(`links them into the personal home of a ${agentType} agent, where the member's box skills win`, async () => {
      const member = agentType === "claude" ? "0b0c0d02" : "0b0c0d03";
      const h = setup(`personal-${agentType}`, [member]);
      const personalSkills = join(
        personalProviderHome(member, agentType),
        "skills",
      );
      const boxSkills = join(h.box[agentType], "skills");
      // An earlier start linked the bundled wrap-session.
      mkdirSync(personalSkills, { recursive: true });
      symlinkSync(
        join(h.bundled, "wrap-session"),
        join(personalSkills, "wrap-session"),
      );
      // Since then the member made their own wrap-session in the box home,
      // and linked a grill-me folder they keep elsewhere.
      skillFolder(join(boxSkills, "wrap-session"), "member wrap-session");
      const elsewhere = join(STATE_ROOT, `bundled-personal-${agentType}-own`);
      skillFolder(join(elsewhere, "grill-me"), "member grill-me");
      symlinkSync(join(elsewhere, "grill-me"), join(boxSkills, "grill-me"));
      // The member's link to a bundled skill under another name.
      symlinkSync(join(h.bundled, "wrap-session"), join(boxSkills, "my-wrap"));
      // A box-home agent's start linked loose-ends there.
      symlinkSync(join(h.bundled, "loose-ends"), join(boxSkills, "loose-ends"));

      expect(await h.start(agentType, member)).toBe(true);

      const read = (name: string) =>
        readFileSync(join(personalSkills, name, "SKILL.md"), "utf8");
      expect(read("wrap-session")).toBe("member wrap-session");
      expect(read("grill-me")).toBe("member grill-me");
      expect(read("my-wrap")).toBe("bundled wrap-session");
      // The bundled ones link straight to the bundled folder, never through
      // the box home's link.
      expect(target(join(personalSkills, "loose-ends"))).toBe(
        join(h.bundled, "loose-ends"),
      );
      expect(target(join(personalSkills, "figure-it-out"))).toBe(
        join(h.bundled, "figure-it-out"),
      );
    });
  }

  it("links nothing when the manager has no bundled skills folder, as in tests", async () => {
    const h = setup("none", [], false);
    mkdirSync(join(h.box.claude, "skills"), { recursive: true });
    expect(await h.start("claude", "0b0c0d04")).toBe(true);
    expect(readdirSync(join(h.box.claude, "skills"))).toEqual([]);
  });
});
