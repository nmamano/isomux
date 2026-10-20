// Server-produced text reaches a user in the user's language, over the real
// paths (internal-docs/i18n-loop.md, S7; task c37a7365). Four claims:
//
//   1. a slash command's reply is stored in English and carries a message
//      each reader words in their own language, whoever typed it;
//   2. a choice card, its text fallback, and a system line are stored the
//      same way, whoever typed (or nobody, for a permission the BACKEND asked
//      for);
//   3. an API error stays English for a Spanish user (ruling 2);
//   4. an AGENT's message is agent INPUT, not a command: it reaches the backend
//      as its literal text and produces no Isomux response entry in any
//      language.
//
// Every claim is which language (or which reader's language) a text was
// written in, so the expectation is the catalog value of its key, read through
// `inLanguage` or worded.ts, which first prove that value differs from English
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
import { localizeLogParts } from "../../shared/i18n/log-message.ts";
import { DOCS_URL, SKILLS_PAGE_PATH } from "../command-handlers.ts";
import { expectWorded, expectWordedText } from "./worded.ts";

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

describe("a slash command's reply is stored in English and worded per reader", () => {
  // The typist reads Spanish: the old writer put Spanish into a log every
  // reader of the agent sees.
  async function spanishTypist(srv: TestServer) {
    const owner = await srv.seedOwner("Boss");
    setLanguage(owner.username, "es");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "A", room.id, owner.username);
    // The ENABLING CONDITION, asserted so a writer that still worded the
    // reply for the typist would fail on its stored text.
    expect(getUserByName(owner.username)?.language).toBe("es");
    return { owner, agent };
  }

  it("stores /resume's nothing-to-resume line in English, worded per reader", async () => {
    server = await startTestServer();
    const { owner, agent } = await spanishTypist(server);
    // /resume on a fresh agent answers with one of its two "nothing to
    // resume" lines (/clear answers with nothing since 2026-09-13: the empty
    // state is its confirmation).
    await server.agentManager.sendMessage(agent.id, "/resume", owner.username);
    // Found by either language, so a Spanish line fails on its words.
    const keys = ["commands.resume.none", "commands.resume.noOthers"] as const;
    const texts = (k: (typeof keys)[number]) =>
      ["en", "es"].map((l) => translatorFor(l as "en" | "es").t(k));
    const entries = server.agentManager
      .getAgentLogs(agent.id)
      .filter((e) => e.kind === "system");
    const key = keys.find((k) =>
      entries.some((e) => texts(k).includes(e.content)),
    );
    expect(key).toBeDefined();
    expectWorded(
      entries.find((e) => texts(key!).includes(e.content)),
      key!,
    );
  });

  it("stores /help's header and body in English, with the body worded per reader", async () => {
    server = await startTestServer();
    const { owner, agent } = await spanishTypist(server);
    await server.agentManager.sendMessage(agent.id, "/help", owner.username);
    const helpEntry = server.agentManager
      .getAgentLogs(agent.id)
      .find((entry) => typeof entry.metadata?.helpContent === "string");
    expectWorded(helpEntry, "commands.help.header");

    // The English body stays where older clients and agents read it, and the
    // parts beside it word the same text.
    const english = helpEntry?.metadata?.helpContent as string;
    const parts = helpEntry?.metadata?.helpContentMessage;
    expect(wordedIn("en", parts)).toBe(english);
    expect(
      english.indexOf(translatorFor("en").t("commands.help.receptionist")),
    ).toBe(0);

    const help = localizeLogParts(translatorFor("es"), parts);
    expect(help).not.toBeNull();
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

  it("stores an unsupported command's refusal in English, worded per reader", async () => {
    server = await startTestServer();
    const { owner, agent } = await spanishTypist(server);
    await server.agentManager.sendMessage(agent.id, "/compact", owner.username);
    // Found by either language, so a Spanish line fails on its words.
    const texts = [
      translatorFor("en").t("commands.compact.message"),
      inLanguage("es", "commands.compact.message"),
    ];
    expectWorded(
      server.agentManager
        .getAgentLogs(agent.id)
        .find((e) => e.kind === "system" && texts.includes(e.content)),
      "commands.compact.message",
    );
  });
});

// From here on, the line or card is written once for every reader (task
// c37a7365): its stored text is English whoever typed and whoever owns the
// agent, and its message words it for each reader. Before that task, these
// were worded for the typist (or the owner when nobody typed), so a Catalan
// typist's line reached an English reader in Catalan.

/** The entry's message, or a card field's parts, in `language`. */
function wordedIn(language: "en" | "ca", parts: unknown): string | null {
  return localizeLogParts(translatorFor(language), parts);
}

function lastSystemEntry(
  srv: TestServer,
  agentId: string,
): LogEntry | undefined {
  return srv.agentManager
    .getAgentLogs(agentId)
    .filter((e: LogEntry) => e.kind === "system")
    .at(-1);
}

describe("a choice card stores English and words itself for each reader", () => {
  it("gives the /effort card English fields and a message for each reader", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    setLanguage(owner.username, "ca");
    const room = server.agentManager.getRooms()[0];
    const agent = await spawnAgent(server, "A", room.id, owner.username);
    // The ENABLING CONDITION: the typist reads Catalan, so a card worded for
    // the typist would have Catalan fields and fail.
    expect(getUserByName(owner.username)?.language).toBe("ca");

    await server.agentManager.sendMessage(agent.id, "/effort", owner.username);
    const interaction = server.agentManager.getPendingInteractions()[0];
    expect(interaction?.kind).toBe("effort");
    expectWordedText(
      interaction?.title,
      interaction?.message?.title,
      "choices.effort.title",
    );
    const { t: en } = translatorFor("en");
    expect(interaction?.instruction.trim()).toBe(
      en("choices.model.instruction"),
    );
    expect(wordedIn("ca", interaction?.message?.instruction)?.trim()).toBe(
      inLanguage("ca", "choices.model.instruction"),
    );
    // A level label is catalog text too, keyed by its id.
    const high = interaction?.choices.find((c) => c.value === "high");
    expectWordedText(high?.label, high?.message?.label, "common.effort.high");

    // The text fallback the log shows next to the card is the same words.
    const fallback = server.agentManager
      .getAgentLogs(agent.id)
      .find((e) => e.metadata?.interactionFallback === true);
    expect(fallback?.content).toContain(en("choices.model.instruction"));
    expect(fallback?.content).toContain(en("common.effort.high"));
    const catalan = wordedIn("ca", fallback?.message);
    expect(catalan).toContain(inLanguage("ca", "choices.model.instruction"));
    expect(catalan).toContain(inLanguage("ca", "common.effort.high"));
    expect(catalan).not.toContain(en("choices.model.instruction"));
  });
});

describe("a line a member caused reads in each reader's language", () => {
  // The owner reads English and the member who types reads Catalan: one
  // entry has to serve both.
  async function mixedOffice(srv: TestServer) {
    const owner = await srv.seedOwner("Boss");
    setLanguage(owner.username, null);
    const member = await srv.seedMember("Jordi");
    setLanguage(member.username, "ca");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "A", room.id, owner.username);
    // Both ENABLING CONDITIONS, so neither side can pass for the wrong reason.
    expect(getUserByName(owner.username)?.language).toBeNull();
    expect(getUserByName(member.username)?.language).toBe("ca");
    expect(srv.agentManager.getAgent(agent.id)?.userId).toBe(
      getUserByName(owner.username)?.id,
    );
    return { agent, member };
  }

  it("stores a cancelled effort pick in English, worded for each reader", async () => {
    server = await startTestServer();
    const { agent, member } = await mixedOffice(server);
    await server.agentManager.sendMessage(agent.id, "/effort", member.username);
    expect(server.agentManager.getPendingInteractions()).toHaveLength(1);
    // Anything that is not a listed number cancels the pick.
    await server.agentManager.sendMessage(
      agent.id,
      "no thanks",
      member.username,
    );
    expectWorded(
      lastSystemEntry(server, agent.id),
      "systemEntries.effortCancelled",
    );
  });

  it("stores a cancelled model pick in English, worded for each reader", async () => {
    server = await startTestServer();
    const { agent, member } = await mixedOffice(server);
    await server.agentManager.sendMessage(agent.id, "/model", member.username);
    expect(server.agentManager.getPendingInteractions()).toHaveLength(1);
    await server.agentManager.sendMessage(
      agent.id,
      "no thanks",
      member.username,
    );
    expectWorded(
      lastSystemEntry(server, agent.id),
      "systemEntries.modelCancelled",
    );
  });
});

describe("a line nobody typed reads in each reader's language", () => {
  it("words a backend permission prompt for each reader", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    setLanguage(owner.username, "ca");
    const room = server.agentManager.getRooms()[0];
    const agent = await spawnAgent(server, "A", room.id, owner.username);

    // The ENABLING CONDITION: the agent is owned by the Catalan user and the
    // permission arrives from the BACKEND, the case the old writer worded in
    // the owner's language.
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
    expectWordedText(
      interaction?.title,
      interaction?.message?.title,
      "choices.permission.title",
      { tool: "Bash" },
    );
    expectWordedText(
      interaction?.instruction,
      interaction?.message?.instruction,
      "choices.permission.instruction",
    );
    const [allow, deny] = interaction?.choices ?? [];
    expectWordedText(
      allow?.label,
      allow?.message?.label,
      "choices.permission.allowOnce",
    );
    expectWordedText(
      deny?.label,
      deny?.message?.label,
      "choices.permission.deny",
    );
    // The prompt text the log shows alongside the card is the same words.
    const { t: en } = translatorFor("en");
    const prompt = server.agentManager
      .getAgentLogs(agent.id)
      .find(
        (e) =>
          e.kind === "system" &&
          e.content.includes(en("choices.permission.reply")),
      );
    expect(wordedIn("ca", prompt?.message)).toContain(
      inLanguage("ca", "choices.permission.reply"),
    );
  });

  it("words the API new-conversation entry for each reader", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    setLanguage(owner.username, "ca");
    const room = server.agentManager.getRooms()[0];
    const agent = await spawnAgent(server, "A", room.id, owner.username);

    // The ENABLING CONDITION: newConversation is reached from a route whose
    // handler contract passes no identity, so the old writer fell back to the
    // Catalan owner.
    expect(server.agentManager.getAgent(agent.id)?.userId).toBe(
      getUserByName(owner.username)?.id,
    );
    expect(getUserByName(owner.username)?.language).toBe("ca");

    // The real HTTP route, not the manager call.
    const res = await server.http(`/api/agents/${agent.id}/new-conversation`, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(204);
    // Found by either language, so a Catalan entry fails on its words, not
    // on a timeout.
    const texts = [
      translatorFor("en").t("systemEntries.newConversation"),
      inLanguage("ca", "systemEntries.newConversation"),
    ];
    const entry = () =>
      server!.agentManager
        .getAgentLogs(agent.id)
        .find((e) => e.kind === "system" && texts.includes(e.content));
    await waitUntil(() => !!entry(), 2000, "new-conversation entry");
    expectWorded(entry(), "systemEntries.newConversation");
  });
});

describe("the dormant-wake message is split by reader", () => {
  // The human's log is worded per reader; the agent's wake notice stays
  // English because an agent always reads English (internal-docs/i18n-loop.md,
  // S7).
  it("words the logged wake for each reader and sends the agent the English notice", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    setLanguage(owner.username, "ca");
    const room = server.agentManager.getRooms()[0];
    const agent = await spawnAgent(server, "A", room.id, owner.username);

    // ENABLING CONDITIONS: the owner reads Catalan, so an owner-worded log
    // would put Catalan in the stored text.
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

    const keys = [
      "systemEntries.wake.afterBackendEnded",
      "systemEntries.wake.inFlightWarning",
    ] as const;
    const { t: en } = translatorFor("en");
    const wake = server.agentManager
      .getAgentLogs(agent.id)
      .find(
        (e) =>
          e.kind === "system" &&
          (e.content.includes(en(keys[0])) ||
            e.content.includes(translatorFor("ca").t(keys[0]))),
      );
    // The HUMAN's surface: English stored, Catalan for the Catalan reader.
    const catalan = wordedIn("ca", wake?.message);
    for (const key of keys) {
      expect(wake?.content).toContain(en(key));
      expect(catalan).toContain(inLanguage("ca", key));
      expect(catalan).not.toContain(en(key));
    }

    // The AGENT's surface, in English, inside the wake-notice envelope.
    const sent = (server.fakeBackend.sessionForAgent(agent.id)?.sent ?? [])
      .map((m) => m.text)
      .join("\n");
    expect(sent).toContain("--- begin isomux: wake-notice ---");
    for (const key of keys) {
      expect(sent).toContain(en(key));
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

    // The ENABLING CONDITION: the same caller is now on Spanish, and the
    // answer does not follow.
    setLanguage(owner.username, "es");
    expect(getUserByName(owner.username)?.language).toBe("es");
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
