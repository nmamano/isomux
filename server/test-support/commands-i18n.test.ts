// Server-produced text reaches a user in the user's language, over the real
// paths (internal-docs/i18n-loop.md, S7). Four claims:
//
//   1. a slash command typed by a user whose stored language is `es` answers in
//      Spanish, and the same command from a user who never chose one answers in
//      English;
//   2. a choice interaction the user opened (/effort) carries their language,
//      and one opened with NO actor - a permission the BACKEND asked for -
//      falls back to the agent owner's language;
//   3. an API error stays English for a Spanish user (ruling 2);
//   4. an AGENT's message is agent INPUT, not a command: it reaches the backend
//      as its literal text and produces no Isomux response entry in any
//      language.
//
// Every claim is which language (or which reader's language) a text was
// written in, so the expectation is the catalog value of its key, read through
// `inLanguage`, which first proves that value differs from English
// (internal-docs/testing-guide.md, principle 15 and its one exception). The
// API error and the agent's wake notice are compared with English on the same
// grounds.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { formatAgentSenderPrefix } from "../../shared/identity.ts";
import { getUserByName, updateUserById } from "../users.ts";
import type { AgentInfo, LogEntry } from "../../shared/types.ts";
import {
  translatorFor,
  type MessageKey,
  type ParamsFor,
} from "../../shared/i18n/translate.ts";
import { DOCS_URL, SKILLS_PAGE_PATH } from "../command-handlers.ts";

async function waitUntil(
  pred: () => boolean,
  timeoutMs = 2000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function spawnAgent(
  srv: TestServer,
  name: string,
  roomId: string,
  username?: string,
  agentType: "claude" | "codex" | "opencode" = "claude",
): Promise<AgentInfo> {
  const info = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    roomId,
    undefined,
    undefined,
    undefined,
    username,
    agentType,
  );
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

/** Put a seeded user on a language. Returns their id. */
function setLanguage(username: string, language: "es" | "ca" | null): string {
  const user = getUserByName(username);
  if (!user) throw new Error(`no user record for ${username}`);
  const r = updateUserById(user.id, { language });
  if (!r.ok) throw new Error(`could not set language: ${r.error}`);
  return user.id;
}

/** The catalog value of `key` in `language`, which must differ from English. */
function inLanguage<K extends MessageKey>(
  language: "es" | "ca",
  key: K,
  ...params: ParamsFor<K>
): string {
  const text = translatorFor(language).t(key, ...params);
  expect({ key, text }).not.toEqual({
    key,
    text: translatorFor("en").t(key, ...params),
  });
  return text;
}

function systemEntries(srv: TestServer, agentId: string): string[] {
  return srv.agentManager
    .getAgentLogs(agentId)
    .filter((e: LogEntry) => e.kind === "system")
    .map((e: LogEntry) => e.content);
}

describe("a slash command answers in the typing user's language", () => {
  it("gives a Spanish user Spanish and a never-chose user English", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    setLanguage(owner.username, "es");
    const room = server.agentManager.getRooms()[0];
    const agent = await spawnAgent(server, "A", room.id, owner.username);

    // The ENABLING CONDITION for this test: the sender is a known human whose
    // stored preference is Spanish. Asserted so a resolver that stopped reading
    // the preference could not pass by accident.
    expect(getUserByName(owner.username)?.language).toBe("es");

    // /resume on a fresh agent answers with one of its two "nothing to
    // resume" lines (/clear answers with nothing since 2026-09-13: the empty
    // state is its confirmation).
    const spanishReplies = [
      inLanguage("es", "commands.resume.none"),
      inLanguage("es", "commands.resume.noOthers"),
    ];
    const { t: en } = translatorFor("en");
    const englishReplies = [
      en("commands.resume.none"),
      en("commands.resume.noOthers"),
    ];
    await server.agentManager.sendMessage(agent.id, "/resume", owner.username);
    expect(
      systemEntries(server, agent.id).some((e) => spanishReplies.includes(e)),
    ).toBe(true);

    // Same command, a user who never chose a language: English.
    const member = await server.seedMember("Sam");
    expect(getUserByName(member.username)?.language).toBeNull();
    const other = await spawnAgent(server, "B", room.id, member.username);
    await server.agentManager.sendMessage(other.id, "/resume", member.username);
    expect(
      systemEntries(server, other.id).some((e) => englishReplies.includes(e)),
    ).toBe(true);
  });

  it("translates a command's DESCRIPTION in /help, from the catalog", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    setLanguage(owner.username, "es");
    const room = server.agentManager.getRooms()[0];
    const agent = await spawnAgent(server, "A", room.id, owner.username);

    await server.agentManager.sendMessage(agent.id, "/help", owner.username);
    const helpEntry = server.agentManager
      .getAgentLogs(agent.id)
      .find((entry) => typeof entry.metadata?.helpContent === "string");
    const help = helpEntry?.metadata?.helpContent as string | undefined;
    expect(help).toBeDefined();
    const { t } = translatorFor("es");
    // The Receptionist pointer and the docs link lead; the reference material
    // follows, and the skill sections come after the command list.
    const receptionistAt = help!.indexOf(t("commands.help.receptionist"));
    const docsAt = help!.indexOf(t("commands.help.docs", { url: DOCS_URL }));
    const commandsAt = help!.indexOf(t("commands.help.commands"));
    expect(receptionistAt).toBe(0);
    expect(docsAt).toBeGreaterThan(receptionistAt);
    expect(commandsAt).toBeGreaterThan(docsAt);
    // Skills are not listed: one line links the Skills page, after the docs.
    const skillsAt = help!.indexOf(
      t("commands.help.skills", { url: SKILLS_PAGE_PATH }),
    );
    expect(skillsAt).toBeGreaterThan(docsAt);
    expect(commandsAt).toBeGreaterThan(skillsAt);
    expect(helpEntry?.content).toBe(t("commands.help.header"));
    const diffLine = help!
      .split("\n")
      .find((line) => line.includes("`/isomux-diff`"));
    expect(diffLine).toContain("`/diff`");
    // The registry carries no English description any more, so this text can
    // only have come from the catalog.
    expect(help).toContain(inLanguage("es", "commands.clear.description"));
  });

  it("/help lists no skill on any engine and links the Skills page", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    const { t } = translatorFor("en");
    for (const engine of ["claude", "codex", "opencode"] as const) {
      const agent = await spawnAgent(
        server,
        engine,
        room.id,
        owner.username,
        engine,
      );
      const { commands, skills } = server.agentManager.getAgentCommands(
        agent.id,
      );
      const commandNames = new Set(commands.map((c) => c.name));
      const skillNames = skills
        .map((s) => s.name)
        .filter((name) => !commandNames.has(name));
      expect(skillNames.length).toBeGreaterThan(0);

      await server.agentManager.sendMessage(agent.id, "/help", owner.username);
      const help = server.agentManager
        .getAgentLogs(agent.id)
        .find((entry) => typeof entry.metadata?.helpContent === "string")
        ?.metadata?.helpContent as string | undefined;
      expect(help).toContain(
        t("commands.help.skills", { url: SKILLS_PAGE_PATH }),
      );
      for (const name of skillNames) expect(help).not.toContain(`/${name}\``);
    }
  });

  it("refuses an unsupported command in the user's language", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    setLanguage(owner.username, "ca");
    const room = server.agentManager.getRooms()[0];
    const agent = await spawnAgent(server, "A", room.id, owner.username);

    await server.agentManager.sendMessage(agent.id, "/compact", owner.username);
    expect(systemEntries(server, agent.id)).toContain(
      inLanguage("ca", "commands.compact.message"),
    );
  });
});

describe("a choice interaction the user opened carries their language", () => {
  it("gives a Catalan user a Catalan title and instruction", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    setLanguage(owner.username, "ca");
    const room = server.agentManager.getRooms()[0];
    const agent = await spawnAgent(server, "A", room.id, owner.username);

    await server.agentManager.sendMessage(agent.id, "/effort", owner.username);
    const interaction = server.agentManager.getPendingInteractions()[0];
    expect(interaction?.kind).toBe("effort");
    expect(interaction?.title).toBe(inLanguage("ca", "choices.effort.title"));
    expect(interaction?.instruction).toContain(
      inLanguage("ca", "choices.model.instruction"),
    );
    // The level labels come from the catalog too, keyed by id.
    expect(interaction?.choices.map((c) => c.label)).toContain(
      inLanguage("ca", "common.effort.high"),
    );
  });
});

describe("a KNOWN actor wins over the agent's owner", () => {
  // The regression for the round-1 finding: several sites inside sendMessage
  // resolved from the owner even though the sender was in scope. With the
  // owner on English and the actor on Catalan, owner-only code reads English
  // and fails here.
  it("cancels an effort pick in the ACTOR's language, not the owner's", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    setLanguage(owner.username, null);
    const member = await server.seedMember("Jordi");
    setLanguage(member.username, "ca");
    const room = server.agentManager.getRooms()[0];
    // The agent belongs to the OWNER; the member is only the one typing.
    const agent = await spawnAgent(server, "A", room.id, owner.username);

    // Both ENABLING CONDITIONS, so neither side can pass for the wrong reason.
    expect(getUserByName(owner.username)?.language).toBeNull();
    expect(getUserByName(member.username)?.language).toBe("ca");
    expect(server.agentManager.getAgent(agent.id)?.userId).toBe(
      getUserByName(owner.username)?.id,
    );

    await server.agentManager.sendMessage(agent.id, "/effort", member.username);
    expect(server.agentManager.getPendingInteractions()).toHaveLength(1);
    // Anything that is not a listed number cancels the pick.
    await server.agentManager.sendMessage(
      agent.id,
      "no thanks",
      member.username,
    );
    expect(systemEntries(server, agent.id)).toContain(
      inLanguage("ca", "systemEntries.effortCancelled"),
    );
    expect(systemEntries(server, agent.id)).not.toContain(
      translatorFor("en").t("systemEntries.effortCancelled"),
    );
  });

  it("cancels a model pick in the ACTOR's language, not the owner's", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    setLanguage(owner.username, null);
    const member = await server.seedMember("Jordi");
    setLanguage(member.username, "ca");
    const room = server.agentManager.getRooms()[0];
    const agent = await spawnAgent(server, "A", room.id, owner.username);
    expect(getUserByName(owner.username)?.language).toBeNull();
    expect(getUserByName(member.username)?.language).toBe("ca");

    await server.agentManager.sendMessage(agent.id, "/model", member.username);
    expect(server.agentManager.getPendingInteractions()).toHaveLength(1);
    await server.agentManager.sendMessage(
      agent.id,
      "no thanks",
      member.username,
    );
    expect(systemEntries(server, agent.id)).toContain(
      inLanguage("ca", "systemEntries.modelCancelled"),
    );
  });
});

describe("an actorless choice interaction falls back to the agent's owner", () => {
  it("words a backend permission prompt in the OWNER's language", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    setLanguage(owner.username, "ca");
    const room = server.agentManager.getRooms()[0];
    const agent = await spawnAgent(server, "A", room.id, owner.username);

    // The ENABLING CONDITION: the agent is owned by the Catalan user, and the
    // permission arrives from the BACKEND, so no actor is in scope. If the
    // owner link were missing this would read English and the assertions below
    // would fail rather than pass vacuously.
    expect(server.agentManager.getAgent(agent.id)?.userId).toBe(
      getUserByName(owner.username)?.id,
    );
    expect(getUserByName(owner.username)?.language).toBe("ca");

    // Give the agent a live session for the backend to speak through.
    await server.agentManager.sendMessage(
      agent.id,
      "run something",
      owner.username,
    );
    // No `title`: the backend supplies one in production, and the FALLBACK is
    // the string Isomux owns, which is what this asserts.
    server.fakeBackend.sessionForAgent(agent.id)!.push({
      kind: "approval_request",
      approvalId: "ap-1",
      toolName: "Bash",
      input: { command: "rm -rf /tmp/x" },
    });
    await waitUntil(
      () => server!.agentManager.getPendingInteractions().length > 0,
      2000,
      "permission interaction opened",
    );

    const interaction = server.agentManager.getPendingInteractions()[0];
    expect(interaction?.kind).toBe("permission");
    expect(interaction?.title).toBe(
      inLanguage("ca", "choices.permission.title", { tool: "Bash" }),
    );
    expect(interaction?.instruction).toBe(
      inLanguage("ca", "choices.permission.instruction"),
    );
    expect(interaction?.choices.map((c) => c.label)).toEqual([
      inLanguage("ca", "choices.permission.allowOnce"),
      inLanguage("ca", "choices.permission.deny"),
    ]);
    // The prompt text the log shows alongside the card is the same words.
    expect(systemEntries(server, agent.id).join("\n")).toContain(
      inLanguage("ca", "choices.permission.reply"),
    );
  });
});

describe("an actorless LIFECYCLE entry falls back to the agent's owner", () => {
  it("words the API new-conversation entry in the OWNER's language", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    setLanguage(owner.username, "ca");
    const room = server.agentManager.getRooms()[0];
    const agent = await spawnAgent(server, "A", room.id, owner.username);

    // The ENABLING CONDITION: newConversation is reached from a route whose
    // handler contract passes no identity, so nothing but the ownership link
    // can supply a language here. Asserted so the Catalan expectation below
    // cannot pass for the wrong reason.
    expect(server.agentManager.getAgent(agent.id)?.userId).toBe(
      getUserByName(owner.username)?.id,
    );
    expect(getUserByName(owner.username)?.language).toBe("ca");

    // The real HTTP route, not the manager call: this is the path whose
    // handler contract passes no identity through.
    const res = await server.http(`/api/agents/${agent.id}/new-conversation`, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(204);
    const catalan = inLanguage("ca", "systemEntries.newConversation");
    await waitUntil(
      () => systemEntries(server!, agent.id).includes(catalan),
      2000,
      "new-conversation entry in Catalan",
    );
  });
});

describe("the dormant-wake message is split by reader", () => {
  // One string used to serve both surfaces. It now serves two, and this is the
  // test that tells them apart: the human's log follows the reader, the
  // agent's wake notice stays English because an agent always reads English
  // (internal-docs/i18n-loop.md, S7).
  it("logs the wake in Catalan and sends the agent the English notice", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    setLanguage(owner.username, "ca");
    const room = server.agentManager.getRooms()[0];
    const agent = await spawnAgent(server, "A", room.id, owner.username);

    // ENABLING CONDITIONS: the reader is on Catalan and owns the agent, so an
    // English log here would be a real failure rather than a missing fixture.
    expect(getUserByName(owner.username)?.language).toBe("ca");
    expect(server.agentManager.getAgent(agent.id)?.userId).toBe(
      getUserByName(owner.username)?.id,
    );

    await server.agentManager.sendMessage(agent.id, "hello", owner.username);
    // A clean stream end while idle is what an earlyoom SIGTERM looks like from
    // here; it sets dormantReason "stream-ended", the branch that arms a notice.
    server.fakeBackend.sessionForAgent(agent.id)!.endStream();
    await waitUntil(
      () => server!.agentManager.getAgent(agent.id)?.dormant === true,
      3000,
      "went dormant on stream end",
    );

    await server.agentManager.sendMessage(
      agent.id,
      "still there?",
      owner.username,
    );
    await waitUntil(
      () => server!.agentManager.getAgent(agent.id)?.dormant === false,
      3000,
      "woke after stream end",
    );

    // The HUMAN's surface, in the reader's language.
    const keys = [
      "systemEntries.wake.afterBackendEnded",
      "systemEntries.wake.inFlightWarning",
    ] as const;
    const log = systemEntries(server, agent.id).join("\n");
    for (const key of keys) expect(log).toContain(inLanguage("ca", key));

    // The AGENT's surface, in English, inside the wake-notice envelope.
    const sent = (server.fakeBackend.sessionForAgent(agent.id)?.sent ?? [])
      .map((m) => m.text)
      .join("\n");
    expect(sent).toContain("--- begin isomux: wake-notice ---");
    for (const key of keys) {
      expect(sent).toContain(translatorFor("en").t(key));
      // And the agent never sees the reader's language.
      expect(sent).not.toContain(translatorFor("ca").t(key));
    }
  });
});

describe("what stays English", () => {
  it("keeps an API error English for a Spanish user (ruling 2)", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    const agent = await spawnAgent(server, "A", room.id, owner.username);
    const badRequest = async () => {
      const res = await server!.http(`/api/agents/${agent.id}/messages`, {
        method: "POST",
        rawSessionId: owner.rawSessionId,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error?: { code?: string; message?: string };
      };
      expect(body.error?.code).toBe("invalid_text");
      return body.error?.message;
    };

    const english = await badRequest();
    expect(english?.length).toBeGreaterThan(0);

    // The ENABLING CONDITION: the same caller, now on Spanish, does get Spanish
    // from a surface that follows the reader.
    setLanguage(owner.username, "es");
    await server.agentManager.sendMessage(agent.id, "/compact", owner.username);
    expect(systemEntries(server, agent.id)).toContain(
      inLanguage("es", "commands.compact.message"),
    );

    expect(await badRequest()).toBe(english);
  });

  it("delivers an agent's message as agent INPUT, with no localized response", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    setLanguage(owner.username, "es");
    const room = server.agentManager.getRooms()[0];
    const receiver = await spawnAgent(
      server,
      "Receiver",
      room.id,
      owner.username,
    );
    const sender = await spawnAgent(server, "Sender", room.id, owner.username);

    // The ENABLING CONDITION: the receiver's owner is on Spanish, so if this
    // path DID run a command handler the answer would be Spanish and visible.
    expect(getUserByName(owner.username)?.language).toBe("es");

    const before = systemEntries(server, receiver.id).length;
    const res = await server.http(`/api/agents/${receiver.id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getAgentTokenRaw(sender.id)}`,
      },
      body: JSON.stringify({ text: "/help" }),
    });
    expect(res.status).toBe(200);

    // PROVENANCE: the delivered entry is attributed to the sending AGENT, not
    // to a user. This is what makes it the bearer path rather than the chat
    // path, and it is asserted from the server's own metadata rather than
    // inferred from the text.
    const entry = server.agentManager
      .getAgentLogs(receiver.id)
      .find((e: LogEntry) => e.content === "/help");
    expect(entry).toBeDefined();
    expect(entry!.metadata?.sender_agent_id).toBe(sender.id);
    expect(entry!.metadata?.sender_agent_name).toBe("Sender");
    expect(entry!.metadata?.username).toBeUndefined();

    // It reached the BACKEND as agent input, wrapped in the sender label the
    // server builds - the exact body, not a containment check.
    const session = server.fakeBackend.sessionForAgent(receiver.id);
    const sent = session?.sent.map((m) => m.text) ?? [];
    // Both agents have the same manager, so the label carries that marker.
    expect(sent).toContain(
      `${formatAgentSenderPrefix(sender.id, "Sender", room.name, "same-manager")} /help`,
    );

    // And Isomux wrote no /help answer for it, in any language.
    expect(systemEntries(server, receiver.id).length).toBe(before);
    expect(
      server.agentManager
        .getAgentLogs(receiver.id)
        .some((e: LogEntry) => e.metadata?.helpContent !== undefined),
    ).toBe(false);
  });
});
