import { describe, expect, it } from "bun:test";
import {
  buildSystemPrompt,
  hostedIdentityNote,
  memorySection,
} from "../system-prompt.ts";
import {
  AGENT_REFERENCE_TOPICS,
  PRIVILEGED_REFERENCE_TOPICS,
  type AgentReferenceTopic,
  agentReferenceContent,
} from "../agent-reference.ts";
import {
  AGENT_CAPABILITIES,
  PRIVILEGED_AGENT_CAPABILITIES,
  type Identity,
} from "../identity/index.ts";
import type { SupportedLanguageCode } from "../../shared/languages.ts";
import { LOBBY_ROOM_ID } from "../../shared/types.ts";
import {
  AGENT_SENDER_PRIVILEGED,
  AGENT_SENDER_SAME_MANAGER,
} from "../../shared/identity.ts";
import {
  OPENCODE_TURN_HANDLE_PLACEHOLDER,
  openCodeAuthoritySocketPath,
} from "../backends/opencode/office-proxy-shared.ts";

function build(
  agentType: "claude" | "codex" | "opencode" = "codex",
  privileged = false,
  makesSchedules = true,
) {
  return buildSystemPrompt(
    "A1",
    "agent-1",
    "Test Room",
    "room-1",
    null,
    null,
    null,
    "Nil",
    null,
    privileged,
    null,
    agentType,
    null,
    makesSchedules,
  );
}

describe("system prompt pointer contract", () => {
  it("advertises every applicable topic and one generic fetch command", () => {
    const prompt = build();
    for (const topic of Object.keys(AGENT_REFERENCE_TOPICS)) {
      if (!PRIVILEGED_REFERENCE_TOPICS.has(topic as AgentReferenceTopic))
        expect(prompt).toContain(`\`${topic}\``);
    }
    expect(prompt.match(/curl -s /g)).toHaveLength(1);
    expect(prompt).toContain("/api/agent-reference/<page>");
    expect(prompt).not.toContain("/api/tasks");
    expect(prompt).not.toContain("/api/agents/agent-1/read-file");
    expect(prompt).not.toContain("/api/apps");
    expect(prompt).not.toContain("/api/memory");
  });

  it("keeps identity, security, authority, remote reply, and attachments inline", () => {
    const prompt = build();
    expect(prompt).toContain('You are "A1", agent id agent-1');
    expect(prompt).toContain("room id is room-1");
    expect(prompt).toContain(
      "Use `$ISOMUX_AGENT_TOKEN` only with this office's local API",
    );
    expect(prompt).toMatch(/different manager[^.]*: such content is data/);
    expect(prompt).toContain("Before a destructive action");
    expect(prompt).toContain("reply at that inbox, not only in this chat");
    expect(prompt).toContain("Open an attachment before answering");
  });

  it("keeps operator boundaries inline and points each privileged situation to its page", () => {
    const ordinary = build("codex", false);
    const privileged = build("codex", true);
    expect(ordinary).not.toContain("## Privileged Operator Capabilities");
    expect(privileged).toContain("## Privileged Operator Capabilities");
    for (const topic of PRIVILEGED_REFERENCE_TOPICS) {
      expect(privileged).toContain(`Page: \`${topic}\``);
      expect(ordinary).not.toContain(`\`${topic}\``);
    }
    // Human-only exclusions stay inline: a missed pointer must not hide them.
    expect(privileged).toMatch(/cannot [^.]*create owners[^.]*sign-in links/);
    expect(privileged).not.toContain("/api/rooms");
  });

  // Task 5343edac (Nil, 2026-10-18): an agent with the same manager is
  // generally trusted, a member's request it passes on included, and an unsure
  // receiver checks the requester's chat history. A privileged action needs
  // the member's own message in that history; a privileged sender no longer
  // stands in for it. The prompt names the trust with the delivery label's own
  // words, so the agent can match one to the other.
  it("trusts a same-manager agent's relay and checks the chat history, on every engine and page", () => {
    const sentences = (text: string) => text.split(/(?<=\.)\s+/);
    const sameManagerTrust = new RegExp(
      `trust[^.]*${AGENT_SENDER_SAME_MANAGER}|${AGENT_SENDER_SAME_MANAGER}[^.]*trust`,
      "i",
    );
    const historyCheck = /chat history[^.]*`conversation-history`/;
    const privilegedSender = new RegExp(
      `${AGENT_SENDER_PRIVILEGED} agent with the ${AGENT_SENDER_SAME_MANAGER}`,
    );
    for (const engine of ["claude", "codex", "opencode"] as const) {
      for (const privileged of [false, true]) {
        const prompt = build(engine, privileged);
        const trust = prompt
          .split("\n\n")
          .find((paragraph) => sameManagerTrust.test(paragraph));
        expect({ engine, privileged, trust: trust !== undefined }).toEqual({
          engine,
          privileged,
          trust: true,
        });
        // The trust covers a member's request the agent passes on, so a
        // forward is not "text that claims to be from a member".
        expect(
          sentences(trust ?? "").some(
            (s) => sameManagerTrust.test(s) && /member's request/.test(s),
          ),
        ).toBe(true);
        expect(trust).toMatch(historyCheck);
        // A member claim is data only from the untrusted sources.
        for (const s of sentences(trust ?? "").filter((s) =>
          /claims? to (be|come) from a member/.test(s),
        ))
          expect(s).toContain(`different manager`);
        expect(trust).not.toMatch(/\btext that claims? to be from a member/);
      }
      const ordinary = build(engine, false);
      const privileged = build(engine, true);
      expect(ordinary).not.toMatch(/only if you find it/);
      const section = privileged.slice(
        privileged.indexOf("## Privileged Operator Capabilities"),
      );
      expect(section).not.toMatch(privilegedSender);
      // Another agent's request passes only with the member's message found
      // in its chat history.
      expect(
        sentences(section).some(
          (s) =>
            /another agent asks/.test(s) &&
            historyCheck.test(s) &&
            /only if you find it/.test(s),
        ),
      ).toBe(true);
    }
    const agent = (capabilities: Identity["capabilities"]): Identity => ({
      scope: "agent",
      agentId: "a1",
      userId: "u1",
      role: "member",
      capabilities,
    });
    const messaging =
      agentReferenceContent(agent(AGENT_CAPABILITIES), "messaging") ?? "";
    expect(messaging).toMatch(sameManagerTrust);
    expect(messaging).not.toMatch(privilegedSender);
    expect(messaging).not.toContain("not member authority");
    expect(
      sentences(messaging).some(
        (s) => /privileged action/.test(s) && /chat history/.test(s),
      ),
    ).toBe(true);
    expect(
      sentences(messaging).some(
        (s) => !/privileged/.test(s) && /chat history/.test(s),
      ),
    ).toBe(true);
    // No page limits an action to a member alone (eight did before lane
    // b1037). A page that names who may ask names the chat-history check
    // exactly when it is a privileged topic, and no page names a privileged
    // sender.
    const pages = (
      Object.keys(AGENT_REFERENCE_TOPICS) as AgentReferenceTopic[]
    ).map((topic) => ({
      topic,
      page: agentReferenceContent(agent(PRIVILEGED_AGENT_CAPABILITIES), topic),
    }));
    // A privileged agent reads every page, so none may be missing here.
    expect(pages.filter((p) => typeof p.page !== "string")).toEqual([]);
    const askers = pages.flatMap(({ topic, page }) =>
      sentences(page ?? "")
        .filter((s) => /when a member\b[^.]*\basks\b/.test(s))
        .map((s) => ({
          topic,
          asker: /when a member or an agent with the same manager asks/.test(s)
            ? "same manager"
            : /when a member asks, [^.]*chat history/.test(s)
              ? "chat history"
              : s,
        })),
    );
    expect(pages.filter((p) => privilegedSender.test(p.page ?? ""))).toEqual(
      [],
    );
    // Fail closed: a rewrite that drops every such sentence checks nothing.
    expect(askers.length).toBeGreaterThan(0);
    for (const a of askers)
      expect(a).toEqual({
        topic: a.topic,
        asker: PRIVILEGED_REFERENCE_TOPICS.has(a.topic)
          ? "chat history"
          : "same manager",
      });
  });

  // Task 0a248523: the backend reports a tool call cut by a steer as rejected
  // by the user. The prompt ties that text to the server's interruption note,
  // and only to it: a real human denial keeps its force. This must apply
  // before the agent fetches any reference, so it stays inline.
  it("reads an Isomux interruption note as the cause, without voiding real denials", () => {
    const p = build();
    expect(p).toMatch(
      /Isomux note[^.]*interrupted or stopped your turn[^.]*not from an office member/,
    );
    expect(p).toMatch(/member's denial or safety refusal[^.]*still stands/);
  });

  it("keeps OpenCode's stable placeholder and proxy command", () => {
    const prompt = build("opencode");
    expect(prompt).toContain("http://isomux/api/agent-reference/<page>");
    expect(prompt).toContain("__ISOMUX_OPENCODE_TURN__");
    expect(prompt).not.toContain("$ISOMUX_AGENT_TOKEN");
  });

  it("renders all baseline prompts within the approved byte budgets", () => {
    const measured = (["claude", "codex", "opencode"] as const).flatMap(
      (engine) =>
        [false, true].flatMap((privileged) =>
          [false, true].map((makesSchedules) => ({
            engine,
            privileged,
            bytes: Buffer.byteLength(build(engine, privileged, makesSchedules)),
          })),
        ),
    );
    for (const row of measured) {
      const ordinaryBudget = row.engine === "opencode" ? 11_000 : 9_000;
      expect(row.bytes).toBeLessThanOrEqual(
        ordinaryBudget + (row.privileged ? 2_000 : 0),
      );
    }
  });
});

// Task 11e311db (Nil, 2026-10-24): a schedule runs with nobody present, so
// only an agent whose mode acts without approvals makes one
// (agentMakesSchedules). Its prompt offers schedule creation; any other
// agent's prompt has the same situation line, sending the member to the
// Schedules page instead of a page the agent cannot use.
describe("system prompt schedule line", () => {
  it("offers schedule creation only to an agent that makes schedules, and keeps the situation for the others", () => {
    for (const engine of ["claude", "codex", "opencode"] as const) {
      const makes = build(engine, false, true).split("\n");
      const asks = build(engine, false, false).split("\n");
      const pointer = "Page: `cronjob-management`";
      expect([engine, makes.some((l) => l.includes(pointer))]).toEqual([
        engine,
        true,
      ]);
      expect([engine, asks.join("\n").includes("cronjob-management")]).toEqual([
        engine,
        false,
      ]);
      // Inspecting schedules and runs stays open to both.
      for (const lines of [makes, asks])
        expect(lines.some((l) => l.includes("Page: `cronjobs`"))).toBe(true);
      // One line changes, in place: the other agent still reads the
      // situation, and its line points at no reference page.
      expect(asks.length).toBe(makes.length);
      const changed = makes.flatMap((line, i) => (line === asks[i] ? [] : [i]));
      expect(changed).toHaveLength(1);
      expect(makes[changed[0]]).toContain(pointer);
      // The same situation, before its colon; another action after it.
      const situation = (line: string) => line.slice(0, line.indexOf(":"));
      expect(situation(asks[changed[0]])).toBe(situation(makes[changed[0]]));
      expect(asks[changed[0]]).not.toContain("Page:");
    }
  });
});

describe("dynamic prompt layers", () => {
  it("renders hosted identity only for hosted installs", () => {
    expect(hostedIdentityNote("self-hosted", "https://acme.isomux.app")).toBe(
      "",
    );
    const hosted = hostedIdentityNote("hosted", "https://acme.isomux.app");
    // Every hostname slot is filled, including the root SSH target the owner
    // uses from their own device.
    expect(hosted).not.toContain("<hostname>");
    expect(hosted).toContain("root@acme.isomux.app");
  });

  // The lobby has no room scope for tasks or memory, so its prompt must not
  // hand the agent "lobby" as a room id to use there.
  it("gives a lobby agent no room id where a room agent gets one", () => {
    const room = buildSystemPrompt("A1", "agent-1", "Room", "room-x");
    const lobby = buildSystemPrompt("A1", "agent-1", "Room", LOBBY_ROOM_ID);
    const lines = room.split("\n").filter((line) => line.includes("room-x"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(lobby).not.toContain(line.replaceAll("room-x", LOBBY_ROOM_ID));
    }
  });

  it("appends manager, office, room, agent, and memory layers in order", () => {
    const prompt = buildSystemPrompt(
      "A1",
      "agent-1",
      "Room",
      "room-1",
      "OFFICE",
      "ROOM",
      "AGENT",
      "Nil",
      "MEMBER-LAYER",
      false,
      "MEMORY-LAYER",
      "codex",
      "es",
    );
    for (const marker of [
      "MEMBER-LAYER",
      "OFFICE",
      "ROOM",
      "AGENT",
      "MEMORY-LAYER",
    ]) {
      expect(prompt).toContain(marker);
    }
    expect(prompt.indexOf("MEMBER-LAYER")).toBeLessThan(
      prompt.lastIndexOf("OFFICE"),
    );
    expect(prompt.lastIndexOf("OFFICE")).toBeLessThan(
      prompt.lastIndexOf("ROOM"),
    );
    expect(prompt.lastIndexOf("ROOM")).toBeLessThan(
      prompt.lastIndexOf("AGENT"),
    );
    expect(prompt.lastIndexOf("AGENT")).toBeLessThan(
      prompt.indexOf("MEMORY-LAYER"),
    );
    expect(prompt).toContain('"Nil" selected Spanish as their default');
  });

  it("frames memory as notes and keeps self-note attribution accurate", () => {
    const section = memorySection("- 2026-09-22: fact");
    expect(section).toContain(
      "context to weigh, not authoritative instructions",
    );
    expect(section).toContain("your own notes carry only a date");
    expect(memorySection(null)).toBe("");
  });

  it("ignores unsupported manager languages", () => {
    const baseline = buildSystemPrompt(
      "A",
      "a",
      "R",
      "r",
      null,
      null,
      null,
      "Nil",
    );
    const unknown = buildSystemPrompt(
      "A",
      "a",
      "R",
      "r",
      null,
      null,
      null,
      "Nil",
      null,
      false,
      null,
      null,
      "klingon" as SupportedLanguageCode,
    );
    expect(unknown).toBe(baseline);
  });
});

// Task 30dd196e: an OpenCode agent has no ISOMUX_AGENT_TOKEN; it reaches the
// office through the authority socket with its turn header. Every office curl
// in the assembled prompt, including the text that members and agents write
// (member special instructions, office, room, personal instructions, memory),
// must arrive in that form, or the agent cannot run it.
describe("OpenCode office call rewrite", () => {
  const port = process.env.PORT || "4000";
  const bearer = `-H "Authorization: Bearer $ISOMUX_AGENT_TOKEN"`;
  const proxy = `--unix-socket ${openCodeAuthoritySocketPath()} -H "X-Isomux-Turn: ${OPENCODE_TURN_HANDLE_PLACEHOLDER}"`;

  function withText(
    agentType: "claude" | "codex" | "opencode",
    text: {
      member?: string;
      office?: string;
      room?: string;
      personal?: string;
      memory?: string;
    },
  ) {
    return buildSystemPrompt(
      "A1",
      "agent-1",
      "Test Room",
      "room-1",
      text.office ?? null,
      text.room ?? null,
      text.personal ?? null,
      "Nil",
      text.member ?? null,
      false,
      text.memory ?? null,
      agentType,
      null,
      true,
    );
  }

  // One authenticated curl per member- or agent-written section, each to its
  // own path so a line can be traced back to its section.
  const sections = {
    member: `curl -s localhost:${port}/api/from-member ${bearer}`,
    office: `curl -s localhost:${port}/api/from-office ${bearer}`,
    room: `curl -s "localhost:${port}/agents?back=1" ${bearer}`,
    personal: `curl -s localhost:${port}/api/from-personal ${bearer}`,
    memory: `- 2026-10-26: curl -s localhost:${port}/api/from-memory ${bearer}`,
  };
  const expected = {
    member: `curl -s http://isomux/api/from-member ${proxy}`,
    office: `curl -s http://isomux/api/from-office ${proxy}`,
    room: `curl -s "http://isomux/agents?back=1" ${proxy}`,
    personal: `curl -s http://isomux/api/from-personal ${proxy}`,
    memory: `- 2026-10-26: curl -s http://isomux/api/from-memory ${proxy}`,
  };

  it("rewrites the office calls in every section that members and agents write", () => {
    const prompt = withText("opencode", sections);
    const lines = prompt.split("\n");
    for (const key of Object.keys(sections) as (keyof typeof sections)[])
      expect([key, lines.includes(expected[key])]).toEqual([key, true]);
    // The base fetch command keeps its rewrite.
    expect(prompt).toContain(
      `curl -s http://isomux/api/agent-reference/<page> ${proxy}`,
    );
    expect(prompt).not.toContain("ISOMUX_AGENT_TOKEN");
  });

  it("maps every form of the office address to http://isomux and nothing else", () => {
    const cases: [string, string][] = [
      [
        `curl -s http://localhost:${port}/a ${bearer}`,
        `curl -s http://isomux/a ${proxy}`,
      ],
      [
        `curl -s http://127.0.0.1:${port}/b ${bearer}`,
        `curl -s http://isomux/b ${proxy}`,
      ],
      [
        `curl -s "localhost:${port}/c?x=1" ${bearer}`,
        `curl -s "http://isomux/c?x=1" ${proxy}`,
      ],
      [
        `curl -s 127.0.0.1:${port}/d ${bearer}`,
        `curl -s http://isomux/d ${proxy}`,
      ],
      [
        `Office API calls go to localhost:${port}.`,
        `Office API calls go to http://isomux.`,
      ],
      // Another port, or a host that only ends in "localhost", is not the
      // office.
      [`curl -s localhost:${port}1/e`, `curl -s localhost:${port}1/e`],
      [
        `curl -s http://xlocalhost:${port}/f`,
        `curl -s http://xlocalhost:${port}/f`,
      ],
    ];
    const lines = withText("opencode", {
      room: cases.map(([input]) => input).join("\n"),
    }).split("\n");
    for (const [input, output] of cases)
      expect([input, lines.includes(output)]).toEqual([input, true]);
    expect(lines.join("\n")).not.toContain("http://http://");
  });

  // Outside a curl command, a link to a page is for a human, whose browser
  // reaches localhost and not http://isomux (the receptionist's setup link).
  it("rewrites office routes outside a curl command and leaves page links", () => {
    const pages = [
      `Open http://localhost:${port}/setup#key=abc to claim the office.`,
      `Open http://127.0.0.1:${port}/setup#key=abc to claim the office.`,
      `The office is at http://localhost:${port}/ in a browser.`,
      `Sign in at localhost:${port}/signin first.`,
    ];
    const routes: [string, string][] = [
      [
        `GET localhost:${port}/api/x lists them.`,
        `GET http://isomux/api/x lists them.`,
      ],
      [
        `GET http://127.0.0.1:${port}/agents?back=1 lists them.`,
        `GET http://isomux/agents?back=1 lists them.`,
      ],
      [
        `Agents are at localhost:${port}/agents.`,
        `Agents are at http://isomux/agents.`,
      ],
      // Inside a curl command, any path is an office call.
      [`curl -s localhost:${port}/setup`, `curl -s http://isomux/setup`],
    ];
    // The continued line is in the command; the line after it is not.
    const continued = [
      `curl -s \\`,
      `  localhost:${port}/setup`,
      `See http://localhost:${port}/setup#key=abc.`,
    ];
    const lines = withText("opencode", {
      room: [...pages, ...routes.map(([input]) => input), ...continued].join(
        "\n",
      ),
    }).split("\n");
    for (const page of pages)
      expect([page, lines.includes(page)]).toEqual([page, true]);
    for (const [input, output] of routes)
      expect([input, lines.includes(output)]).toEqual([input, true]);
    const at = lines.indexOf(`curl -s \\`);
    expect(lines.slice(at, at + 3)).toEqual([
      `curl -s \\`,
      `  http://isomux/setup`,
      `See http://localhost:${port}/setup#key=abc.`,
    ]);
  });

  it("replaces each spelling of the bearer header with the proxy arguments", () => {
    const headers = [
      `-H 'Authorization: Bearer $ISOMUX_AGENT_TOKEN'`,
      `-H "Authorization: Bearer \${ISOMUX_AGENT_TOKEN}"`,
      `--header "Authorization: Bearer $ISOMUX_AGENT_TOKEN"`,
      `--header 'Authorization: Bearer \${ISOMUX_AGENT_TOKEN}'`,
    ];
    const lines = withText("opencode", {
      room: headers
        .map((h, i) => `curl -s localhost:${port}/api/h${i} ${h}`)
        .join("\n"),
    }).split("\n");
    headers.forEach((h, i) =>
      expect([
        h,
        lines.includes(`curl -s http://isomux/api/h${i} ${proxy}`),
      ]).toEqual([h, true]),
    );
  });

  it("rewrites a continued curl whose header sits on a later line", () => {
    const room = [
      `curl -s -X POST localhost:${port}/api/tasks \\`,
      `  ${bearer} \\`,
      `  -d '{}'`,
    ].join("\n");
    const prompt = withText("opencode", { room });
    const lines = prompt.split("\n");
    const at = lines.indexOf(`curl -s -X POST http://isomux/api/tasks \\`);
    expect(lines.slice(at, at + 3)).toEqual([
      `curl -s -X POST http://isomux/api/tasks \\`,
      `  ${proxy} \\`,
      `  -d '{}'`,
    ]);
    expect(prompt).not.toContain("ISOMUX_AGENT_TOKEN");
  });

  it("rewrites the header before the prose on one line", () => {
    const room = `curl -s localhost:${port}/api/x ${bearer}  # $ISOMUX_AGENT_TOKEN is auto-injected`;
    const line = withText("opencode", { room })
      .split("\n")
      .find((l) => l.startsWith(`curl -s http://isomux/api/x `));
    expect(line).toBeDefined();
    expect(line!.split(proxy)).toHaveLength(2);
    expect(line).not.toContain("ISOMUX_AGENT_TOKEN");
    expect(line).not.toContain("Authorization");
  });

  it("leaves the office calls in Claude and Codex prompts as written", () => {
    for (const engine of ["claude", "codex"] as const) {
      const prompt = withText(engine, sections);
      const lines = prompt.split("\n");
      for (const key of Object.keys(sections) as (keyof typeof sections)[])
        expect([engine, key, lines.includes(sections[key])]).toEqual([
          engine,
          key,
          true,
        ]);
      expect([engine, prompt.includes("http://isomux")]).toEqual([
        engine,
        false,
      ]);
      expect([engine, prompt.includes(openCodeAuthoritySocketPath())]).toEqual([
        engine,
        false,
      ]);
    }
  });
});
