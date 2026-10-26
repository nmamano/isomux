// Task 30dd196e: an OpenCode agent gets the office's skills on both paths.
// Its own skill tool loads them from the folders the session names (the
// user skill roots the Sk menu uses, and the bundled skills), and a skill a
// member runs as /<name> reaches it with its office calls in the form an
// OpenCode agent can run: no ISOMUX_AGENT_TOKEN, the authority socket and the
// turn header instead.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeBackend } from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import type { RoomWire } from "../../shared/types.ts";
import { STATE_ROOT } from "../config.ts";
import { createAgentManager } from "../agent-manager.ts";
import { BUNDLED_SKILLS_DIR } from "../skills.ts";
import { personalProviderHome } from "../provider-homes.ts";
import { setPersonalProviderActiveProvider } from "../env-loader.ts";
import {
  OPENCODE_TURN_HANDLE_PLACEHOLDER,
  openCodeAuthoritySocketPath,
} from "../backends/opencode/office-proxy-shared.ts";

const PORT = process.env.PORT || "4000";
const MEMBER_ID = "01a19e7b";

// The member's personal provider homes are active, so the session env names
// them and not the provider homes of the process that runs the test.
const restoreProvider: (() => void)[] = [];
afterEach(() => restoreProvider.splice(0).forEach((restore) => restore()));

function rooms(id: string): RoomWire[] {
  return [{ id, name: id, prompt: null, canCloseWhenEmpty: false }];
}

// One manager with box skill roots that hold a skill with an office call.
function setup(tag: string) {
  const fake = new FakeBackend({
    // A turn ends at once, except one that says "hold": the test ends it.
    session: {
      onSend: (t, _a, s) => {
        if (!t.includes("hold")) s.completeTurn({ text: "ok" });
      },
    },
  });
  const boxClaude = join(STATE_ROOT, `skills-${tag}-claude`);
  const boxCodex = join(STATE_ROOT, `skills-${tag}-codex`);
  const skill = join(boxClaude, "skills", "office-call");
  mkdirSync(skill, { recursive: true });
  mkdirSync(join(boxCodex, "skills"), { recursive: true });
  writeFileSync(
    join(skill, "SKILL.md"),
    [
      "---",
      "name: office-call",
      "description: Looks up the back room.",
      "---",
      "Look up the back room:",
      `curl -s "localhost:${PORT}/agents?back=1" -H "Authorization: Bearer $ISOMUX_AGENT_TOKEN"`,
      "",
    ].join("\n"),
  );
  const previous = setPersonalProviderActiveProvider(
    (userId) => userId === MEMBER_ID,
  );
  restoreProvider.push(() => setPersonalProviderActiveProvider(previous));
  const room = `room-skills-${tag}`;
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: rooms(room) }),
    initialRooms: [],
    providerSkillSourceRoots: { claude: boxClaude, codex: boxCodex },
  });
  mgr.configureAgentTurnDeps();
  const spawn = async (name: string, agentType: "claude" | "opencode") =>
    (await mgr.spawn(
      name,
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      room,
      undefined,
      agentType === "opencode" ? "gate/gate-model" : undefined,
      "high",
      "Owner",
      agentType,
      undefined,
      MEMBER_ID,
    ))!;
  // A spawn is lazy: the message starts the session.
  const session = async (agentId: string, text: string) => {
    void mgr.sendMessage(agentId, text, "Owner");
    const deadline = Date.now() + 2_000;
    while (!fake.sessionForAgent(agentId) && Date.now() < deadline)
      await Bun.sleep(5);
    return fake.sessionForAgent(agentId)!;
  };
  // The text of the turn that carries the skill body.
  const skillTurn = async (agentId: string) => {
    const deadline = Date.now() + 2_000;
    const find = () =>
      fake
        .sessionForAgent(agentId)
        ?.sent.find((m) => m.text.includes("Look up the back room"))?.text;
    while (!find() && Date.now() < deadline) await Bun.sleep(5);
    return find();
  };
  // The first turn has ended.
  const idle = async (agentId: string) => {
    const deadline = Date.now() + 2_000;
    const done = () =>
      fake.sessionForAgent(agentId)?.sent.length === 1 &&
      mgr.getAgent(agentId)?.state === "waiting_for_response";
    while (!done() && Date.now() < deadline) await Bun.sleep(5);
    return done();
  };
  return { fake, mgr, boxClaude, boxCodex, spawn, session, skillTurn, idle };
}

describe("OpenCode skills", () => {
  it("names the user skill roots and the bundled skills for an OpenCode session, the same for each agent of one manager, and none for Claude", async () => {
    const h = setup("roots");
    const first = await h.spawn("OpenCode one", "opencode");
    const second = await h.spawn("OpenCode two", "opencode");
    const claude = await h.spawn("Claude one", "claude");
    const paths = (await h.session(first.id, "hello")).opts.skillPaths;
    expect(paths).toBeDefined();
    for (const dir of [
      join(personalProviderHome(MEMBER_ID, "claude"), "skills"),
      join(h.boxClaude, "skills"),
      join(personalProviderHome(MEMBER_ID, "codex"), "skills"),
      join(h.boxCodex, "skills"),
      BUNDLED_SKILLS_DIR,
    ])
      expect([dir, paths!.includes(dir)]).toEqual([dir, true]);
    // One OpenCode server serves every agent of a manager: a list that
    // differs per agent would replace that server at each session start.
    expect((await h.session(second.id, "hello")).opts.skillPaths).toEqual(
      paths,
    );
    expect((await h.session(claude.id, "hello")).opts.skillPaths).toBe(
      undefined,
    );
  });

  it("sends a /skill body with its office calls in the OpenCode form, and the Claude body as written", async () => {
    const h = setup("slash");
    const proxy = `--unix-socket ${openCodeAuthoritySocketPath()} -H "X-Isomux-Turn: ${OPENCODE_TURN_HANDLE_PLACEHOLDER}"`;
    const opencode = await h.spawn("OpenCode slash", "opencode");
    // A skill typed during a turn waits in the queue and goes out later.
    const queued = await h.spawn("OpenCode queued", "opencode");
    const claude = await h.spawn("Claude slash", "claude");
    // The session runs, then the member types the skill.
    for (const agent of [opencode, claude]) {
      await h.session(agent.id, "hello");
      expect([agent.agentType, await h.idle(agent.id)]).toEqual([
        agent.agentType,
        true,
      ]);
      void h.mgr.sendMessage(agent.id, "/office-call", "Owner");
    }
    const held = await h.session(queued.id, "hold");
    await h.mgr.sendMessage(queued.id, "/office-call", "Owner");
    // The skill did not go out during the held turn: it waits in the queue.
    expect(held.sent).toHaveLength(1);
    held.completeTurn({ text: "ok" });

    for (const agent of [opencode, queued]) {
      const sent = await h.skillTurn(agent.id);
      expect([agent.name, sent !== undefined]).toEqual([agent.name, true]);
      expect([agent.name, sent!.split("\n")]).toEqual([
        agent.name,
        expect.arrayContaining([
          `curl -s "http://isomux/agents?back=1" ${proxy}`,
        ]),
      ]);
      expect([agent.name, sent!.includes("ISOMUX_AGENT_TOKEN")]).toEqual([
        agent.name,
        false,
      ]);
    }
    const sentToClaude = await h.skillTurn(claude.id);
    expect(sentToClaude).toBeDefined();
    expect(sentToClaude!.split("\n")).toContain(
      `curl -s "localhost:${PORT}/agents?back=1" -H "Authorization: Bearer $ISOMUX_AGENT_TOKEN"`,
    );
  });
});
