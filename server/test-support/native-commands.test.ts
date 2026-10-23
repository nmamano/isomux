// Claude Code built-ins Isomux passes through (GitHub #57 /code-review, #58
// /simplify; CommandConfig.native). Seam: startTestServer() + FakeBackend.
//
// What this freezes:
//   - A Claude agent gets the command exactly as typed: no member prefix and
//     no notice ahead of it, because the engine expands a slash command only
//     at the start of a message. An armed notice waits for the next turn.
//   - An agent on another engine refuses it and sends nothing.
//   - A busy agent queues it: it never supersedes the running turn, and the
//     flush sends it alone and as typed, between the plain items around it.
//   - A command the SDK reports and Isomux does not handle goes the same way.
//   - /review is /code-review.
//   - Autocomplete and /help show it only to agents that run it.
import { describe, it, expect, afterEach, setDefaultTimeout } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import { commands } from "../commands.ts";
import { MEMORY_CAPS } from "../../shared/memory-caps.ts";
import { STATE_ROOT } from "../config.ts";
import { translatorFor } from "../../shared/i18n/translate.ts";
import { ENGINE_NAMES, type AgentInfo } from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

setDefaultTimeout(30_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

const { t } = translatorFor("en");

function completingBackend(): FakeBackend {
  return new FakeBackend({
    session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
  });
}

// Room memory near its cap arms the memory notice for the next send.
function seedRoomMemory(roomId: string, chars: number): void {
  const dir = join(STATE_ROOT, "memory", "rooms");
  mkdirSync(dir, { recursive: true });
  const line = `- Tester, 2026-10-15: ${"filler fact ".repeat(8)}`;
  const lines: string[] = [];
  let size = 0;
  while (size < chars) {
    lines.push(line);
    size += line.length + 1;
  }
  writeFileSync(join(dir, `${roomId}.md`), lines.join("\n") + "\n");
}

async function spawnAgent(
  srv: TestServer,
  agentType: AgentInfo["agentType"] = "claude",
): Promise<AgentInfo> {
  const room = srv.agentManager.getRooms()[0];
  const info = await srv.agentManager.spawn(
    `${agentType} agent`,
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    room.id,
    undefined,
    undefined,
    undefined,
    undefined,
    agentType,
  );
  if (!info) throw new Error("spawn returned null");
  return info;
}

function sentTexts(srv: TestServer, agentId: string): string[] {
  return srv.fakeBackend.sessions
    .filter((s) => s.opts.agentId === agentId)
    .flatMap((s) => s.sent.map((m) => m.text));
}

function systemEntries(srv: TestServer, agentId: string): string[] {
  return srv.agentManager
    .getAgentLogs(agentId)
    .filter((e) => e.kind === "system")
    .map((e) => e.content);
}

describe("native Claude Code commands", () => {
  it("reach a Claude agent as typed, and an armed notice waits for the next turn", async () => {
    const srv = (server = await startTestServer({
      fakeBackend: completingBackend(),
    }));
    const owner = await srv.seedOwner("Morgan");
    seedRoomMemory(
      srv.agentManager.getRooms()[0].id,
      Math.round(MEMORY_CAPS.room * 0.9),
    );
    const agent = await spawnAgent(srv);

    const command = "/code-review high --fix --max-findings all 57";
    await srv.agentManager.sendMessage(agent.id, command, owner.username);
    await srv.agentManager.sendMessage(agent.id, "hello", owner.username);
    await waitUntil(() => sentTexts(srv, agent.id).length >= 2, "two sends");

    expect(sentTexts(srv, agent.id)).toHaveLength(2);
    const [first, second] = sentTexts(srv, agent.id);
    expect(first).toBe(command);
    // The enabling conditions, on the same agent: a plain message carries the
    // member prefix, and the notice was armed (it rode the next send).
    expect(second).toContain(`[${owner.username}] hello`);
    expect(second).toContain("--- begin isomux: memory-check ---");
  });

  it("are refused on another engine, with nothing sent", async () => {
    const srv = (server = await startTestServer({
      fakeBackend: completingBackend(),
    }));
    const owner = await srv.seedOwner("Morgan");
    const agent = await spawnAgent(srv, "codex");

    await srv.agentManager.sendMessage(agent.id, "/simplify", owner.username);
    // Proves the agent sends: a plain message reaches the backend.
    await srv.agentManager.sendMessage(agent.id, "hello", owner.username);
    await waitUntil(() => sentTexts(srv, agent.id).length >= 1, "a send");

    expect(sentTexts(srv, agent.id)).toHaveLength(1);
    expect(sentTexts(srv, agent.id)[0]).toContain("hello");
    expect(systemEntries(srv, agent.id)).toContain(
      t("commands.unsupported.engine", {
        name: "simplify",
        engines: ENGINE_NAMES.claude,
      }),
    );
  });

  // The first send parks (the agent stays busy); every later one completes.
  function firstTurnParks() {
    const parked: { session: FakeSession | null } = { session: null };
    const fake = new FakeBackend({
      session: {
        onSend: (_t, _a, s) => {
          if (!parked.session) {
            parked.session = s;
            s.push({ kind: "assistant_text", text: "..." });
            return;
          }
          s.completeTurn({ text: "ok" });
        },
      },
    });
    return { fake, parked };
  }

  async function queuedBetweenPlainItems(command: string) {
    const { fake, parked } = firstTurnParks();
    const srv = (server = await startTestServer({ fakeBackend: fake }));
    const owner = await srv.seedOwner("Morgan");
    const agent = await spawnAgent(srv);
    void srv.agentManager.sendMessage(agent.id, "kickoff", owner.username);
    await waitUntil(
      () => srv.agentManager.getAgent(agent.id)?.state === "thinking",
      "busy",
    );
    await srv.agentManager.sendMessage(agent.id, "plain one", owner.username);
    await srv.agentManager.sendMessage(agent.id, command, owner.username);
    await srv.agentManager.sendMessage(agent.id, "plain two", owner.username);

    // Nothing superseded the running turn: the command waits, marked native.
    expect(sentTexts(srv, agent.id)).toHaveLength(1);
    expect(
      (
        srv.agentManager.getAllAgents().find((a) => a.id === agent.id)?.queue ??
        []
      ).map((m) => !!m.native),
    ).toEqual([false, true, false]);

    parked.session!.completeTurn({ text: "ok" });
    await waitUntil(
      () => sentTexts(srv, agent.id).length >= 4,
      "three flushes",
    );
    const [, before, native, after] = sentTexts(srv, agent.id);
    expect(before).toContain(`[${owner.username}] plain one`);
    expect(before).not.toContain(command);
    expect(native).toBe(command);
    expect(after).toContain(`[${owner.username}] plain two`);
  }

  it("wait in the queue while the agent is busy, and go alone and as typed", async () => {
    await queuedBetweenPlainItems("/code-review low");
  });

  // The busy path uses the same classification (see the queue test above).
  it("treat a command the SDK reports as native", async () => {
    const reported = ["verify"];
    // Enabling condition: Isomux itself has no entry for it.
    expect("verify" in commands).toBe(false);
    const srv = (server = await startTestServer({
      fakeBackend: new FakeBackend({
        session: {
          slashCommands: reported,
          onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }),
        },
      }),
    }));
    const owner = await srv.seedOwner("Morgan");
    const agent = await spawnAgent(srv);
    // The first message starts the session that reports the command.
    await srv.agentManager.sendMessage(agent.id, "hello", owner.username);
    await srv.agentManager.sendMessage(agent.id, "/verify now", owner.username);
    await waitUntil(() => sentTexts(srv, agent.id).length >= 2, "two sends");
    expect(sentTexts(srv, agent.id)[1]).toBe("/verify now");
  });

  it("run /review as typed, as an alias of /code-review", async () => {
    const srv = (server = await startTestServer({
      fakeBackend: completingBackend(),
    }));
    const owner = await srv.seedOwner("Morgan");
    const agent = await spawnAgent(srv);
    await srv.agentManager.sendMessage(agent.id, "/review 57", owner.username);
    await waitUntil(() => sentTexts(srv, agent.id).length >= 1, "a send");
    expect(sentTexts(srv, agent.id)).toEqual(["/review 57"]);
  });

  it("are refused with an attachment, with nothing sent", async () => {
    const srv = (server = await startTestServer({
      fakeBackend: completingBackend(),
    }));
    const owner = await srv.seedOwner("Morgan");
    const agent = await spawnAgent(srv);
    const attachment = {
      filename: "a1b2c3.txt",
      originalName: "notes.txt",
      mediaType: "text/plain",
      size: 4,
    };

    await srv.agentManager.sendMessage(
      agent.id,
      "/code-review low",
      owner.username,
      undefined,
      [attachment],
    );
    // Proves the agent sends: the same command without the attachment goes.
    await srv.agentManager.sendMessage(
      agent.id,
      "/code-review low",
      owner.username,
    );
    await waitUntil(() => sentTexts(srv, agent.id).length >= 1, "a send");

    expect(sentTexts(srv, agent.id)).toEqual(["/code-review low"]);
    expect(systemEntries(srv, agent.id)).toContain(
      t("commands.native.attachments", { name: "code-review" }),
    );
  });

  // /loop is a bundled skill Isomux refuses, but a member's own skill of
  // that name still runs.
  it.each(["simplify", "loop"])(
    "lose to a user skill of the same name: /%s",
    async (name) => {
      const srv = (server = await startTestServer({
        fakeBackend: completingBackend(),
      }));
      const owner = await srv.seedOwner("Morgan");
      const skillDir = join(STATE_ROOT, "skills", name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "user skill body marker");
      const agent = await spawnAgent(srv);

      await srv.agentManager.sendMessage(agent.id, `/${name}`, owner.username);
      await waitUntil(() => sentTexts(srv, agent.id).length >= 1, "a send");

      expect(sentTexts(srv, agent.id)).toHaveLength(1);
      expect(sentTexts(srv, agent.id)[0]).toContain("user skill body marker");
    },
  );

  it("show in /help only on an engine that runs them", async () => {
    const srv = (server = await startTestServer({
      fakeBackend: completingBackend(),
    }));
    const owner = await srv.seedOwner("Morgan");
    const help = async (agentType: AgentInfo["agentType"]) => {
      const agent = await spawnAgent(srv, agentType);
      await srv.agentManager.sendMessage(agent.id, "/help", owner.username);
      const entry = srv.agentManager
        .getAgentLogs(agent.id)
        .find((e) => typeof e.metadata?.helpContent === "string");
      return entry?.metadata?.helpContent as string;
    };

    const claude = await help("claude");
    const codex = await help("codex");
    for (const name of ["code-review", "simplify"]) {
      expect(claude).toContain(`\`/${name}\``);
      expect(codex).not.toContain(`\`/${name}\``);
    }
    // Enabling condition: Codex /help does list commands every engine runs.
    expect(codex).toContain("`/clear`");
  });

  it("leave the menu when the agent moves to another engine", async () => {
    const srv = (server = await startTestServer({
      fakeBackend: completingBackend(),
    }));
    const owner = await srv.seedOwner("Morgan");
    const agent = await spawnAgent(srv);
    const help = async () => {
      await srv.agentManager.sendMessage(agent.id, "/help", owner.username);
      const entries = srv.agentManager
        .getAgentLogs(agent.id)
        .filter((e) => typeof e.metadata?.helpContent === "string");
      return entries.at(-1)?.metadata?.helpContent as string;
    };
    // Enabling condition: the Claude agent lists it.
    expect(await help()).toContain("`/code-review`");

    await srv.agentManager.editAgent(agent.id, { agentType: "codex" });

    expect(await help()).not.toContain("`/code-review`");
  });
});
