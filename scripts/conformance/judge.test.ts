import { describe, expect, it } from "bun:test";
import { agentReferenceUsageEvent } from "../../server/agent-reference-telemetry.ts";
import type { Identity } from "../../server/identity/index.ts";
import type { Engine } from "../install-smoke/check.ts";
import type { AskMemberWire, LogEntry, TaskItem } from "../../shared/types.ts";
import {
  failedOfficeCalls,
  findMarkerTask,
  judgeCommit,
  messagingFailure,
  newOpenAsk,
  parseUsageLog,
  replyFrom,
  skillLoaded,
  slashResolved,
  usageCallsSince,
} from "./judge.ts";
import claudeSkillLoad from "./fixtures/claude-skill-load.json";
import claudeSkillRefused from "./fixtures/claude-skill-refused.json";
import claudeSlash from "./fixtures/claude-slash.json";
import codexSkillLoad from "./fixtures/codex-skill-load.json";
import codexReadOutsideRoot from "./fixtures/codex-skill-read-outside-root.json";
import opencodeOfficeCallFailed from "./fixtures/opencode-office-call-failed.json";
import opencodeSkillLoad from "./fixtures/opencode-skill-load.json";
import opencodeSkillRefused from "./fixtures/opencode-skill-refused.json";

// The subject agent S, its peer P and a third agent of the office.
const S = "agent-subject";
const P = "agent-peer";
const OTHER = "agent-other";

const fixture = (entries: unknown): LogEntry[] => entries as LogEntry[];

describe("findMarkerTask", () => {
  const task = (title: string, createdByAgentId?: string): TaskItem => ({
    id: `t${title.length}`,
    title,
    status: "open",
    createdBy: createdByAgentId ?? "Owner",
    ...(createdByAgentId ? { createdByAgentId } : {}),
    createdAt: 1,
    version: "v1",
  });

  it("finds the task the agent made with the source's marker and the step's code", () => {
    const tasks = [task("MK-room 4821", S), task("MK-office 4821", S)];
    expect(findMarkerTask(tasks, "MK-office", "4821", S)?.title).toBe(
      "MK-office 4821",
    );
  });

  // The office stamps the creator; a task the peer or a member made with
  // the same title proves nothing about S's prompt.
  it("does not count the task when another agent or a member made it", () => {
    const tasks = [task("MK-office 4821", P), task("MK-office 4821")];
    expect(findMarkerTask(tasks, "MK-office", "4821", S)).toBeNull();
  });

  // Each source has its own marker: S that ran the room line for an office
  // check read the wrong source.
  it("does not count another source's marker or another step's code", () => {
    const tasks = [
      task("MK-room 4821", S),
      task("MK-office 1111", S),
      task("MK-office 48210", S),
    ];
    expect(findMarkerTask(tasks, "MK-office", "4821", S)).toBeNull();
  });
});

describe("usageCallsSince", () => {
  const identity = (agentId: string) =>
    ({ scope: "agent", agentId }) as unknown as Identity;
  // The office's own writer makes the lines, so the shapes are the ones the
  // usage record holds.
  const line = (
    agentId: string,
    now: number,
    call: { opId: string; topic?: string; scheduled?: boolean },
  ) =>
    JSON.stringify(
      agentReferenceUsageEvent({
        identity: identity(agentId),
        sessionId: null,
        now,
        ...call,
      }),
    );
  const fetch = (agentId: string, now: number, topic: string) =>
    line(agentId, now, { opId: "agentReference.get", topic });

  const record = [
    fetch(S, 100, "asks"),
    "{not json",
    fetch(S, 200, "scheduled-messages"),
    fetch(P, 300, "scheduled-messages"),
    line(S, 400, { opId: "agents.listAsks" }),
    line(S, 500, { opId: "agents.sendMessage", scheduled: true }),
    "",
  ].join("\n");

  it("reads every whole line of the record and leaves out a broken one", () => {
    expect(parseUsageLog(record)).toHaveLength(5);
  });

  it("finds the agent's page fetch of the topic at or after the step start", () => {
    const events = parseUsageLog(record);
    const found = usageCallsSince(
      events,
      S,
      { topic: "scheduled-messages" },
      200,
    );
    expect(found.map((e) => e.at)).toEqual([200]);
  });

  // A scheduled send is a feature call that the scheduled-messages page
  // documents; it is not a read of that page.
  it("counts only page fetches for a topic, never a feature call the page documents", () => {
    const events = parseUsageLog(record);
    expect(
      usageCallsSince(events, S, { topic: "scheduled-messages" }, 201),
    ).toEqual([]);
  });

  it("leaves out calls made before the step and calls of other agents", () => {
    const events = parseUsageLog(record);
    expect(usageCallsSince(events, S, { topic: "asks" }, 101)).toEqual([]);
    expect(usageCallsSince(events, P, { opId: "agents.listAsks" }, 0)).toEqual(
      [],
    );
  });

  it("finds the agent's feature call by its operation", () => {
    const events = parseUsageLog(record);
    expect(
      usageCallsSince(events, S, { opId: "agents.listAsks" }, 0).map(
        (e) => e.at,
      ),
    ).toEqual([400]);
  });
});

describe("replyFrom", () => {
  const NONCE = "nonce-7c1e";
  // The office's shapes: an inbound agent message is a user_message whose
  // metadata names the sender (senderMeta in server/agent-manager.ts); the
  // sender's own copy is agent_outbound with the recipient.
  const inbound = (
    sender: string,
    text: string,
    timestamp: number,
  ): LogEntry => ({
    id: `in-${sender}-${timestamp}`,
    agentId: S,
    timestamp,
    kind: "user_message",
    content: text,
    metadata: {
      sender_agent_id: sender,
      sender_agent_name: sender,
      sender_agent_room: "Room",
    },
  });
  const memberStep: LogEntry = {
    id: "member",
    agentId: S,
    timestamp: 1000,
    kind: "user_message",
    content: `Ask the peer to reply to you with the word ${NONCE}`,
    metadata: { username: "Owner" },
  };
  const outbound: LogEntry = {
    id: "out",
    agentId: S,
    timestamp: 1100,
    kind: "agent_outbound",
    content: `Please reply with ${NONCE}`,
    metadata: { recipient_agent_id: P, recipient_agent_name: "Peer" },
  };

  it("finds the peer's message that carries the nonce", () => {
    const reply = inbound(P, `Here it is: ${NONCE}`, 1200);
    expect(replyFrom([memberStep, outbound, reply], P, NONCE, 1000)?.id).toBe(
      reply.id,
    );
  });

  // The member's step message and S's own sent copy both carry the nonce:
  // neither is a delivered reply.
  it("does not count the member's message or the agent's own sent copy", () => {
    expect(replyFrom([memberStep, outbound], P, NONCE, 1000)).toBeNull();
  });

  it("does not count a message of another agent, without the nonce, or before the step", () => {
    const entries = [
      inbound(OTHER, NONCE, 1200),
      inbound(P, "done", 1300),
      inbound(P, NONCE, 900),
    ];
    expect(replyFrom(entries, P, NONCE, 1000)).toBeNull();
  });
});

describe("messagingFailure", () => {
  const NONCE = "cf-5f37";
  const STEP = 1000;
  // The reason's leading clauses: the nightly report and the board key on
  // them, so they stay as they were before the suffix existed.
  const LEG1 = `the peer got no message with ${NONCE} from the agent`;
  const LEG2 = `the agent got no reply with ${NONCE} from the peer`;
  let seq = 0;
  const entry = (
    agentId: string,
    kind: LogEntry["kind"],
    content: string,
    timestamp: number,
    metadata?: Record<string, unknown>,
  ): LogEntry => ({
    id: `e${++seq}`,
    agentId,
    timestamp,
    kind,
    content,
    ...(metadata ? { metadata } : {}),
  });
  // The office's shapes: the receiver's user_message names the sender; the
  // sender's agent_outbound names the recipient and the message id
  // (addAgentOutbound in server/agent-manager.ts).
  const inbound = (to: string, from: string, text: string, at: number) =>
    entry(to, "user_message", text, at, { sender_agent_id: from });
  const outbound = (
    from: string,
    to: string,
    text: string,
    at: number,
    messageId: string,
    toName: string | null = to,
  ) =>
    entry(from, "agent_outbound", text, at, {
      recipient_agent_id: to,
      recipient_agent_name: toName,
      message_id: messageId,
    });
  // A send the office refused: the call names the recipient in its URL and
  // its result is the office's error body.
  const refusedSend = (from: string, to: string, error: string, at: number) => {
    const toolId = `call-${++seq}`;
    return [
      entry(from, "tool_call", "Bash", at, {
        toolId,
        input: {
          command: `curl -s -X POST localhost:4000/api/agents/${to}/messages --data-binary @-`,
        },
      }),
      entry(from, "tool_result", error, at + 1, { toolUseId: toolId }),
    ];
  };
  const memberStep = entry(
    S,
    "user_message",
    `Send a message to the agent Peer (agent id ${P}) that asks it to reply to you with the word ${NONCE}.`,
    STEP,
    { username: "Owner" },
  );
  const asked = inbound(P, S, `Please reply with ${NONCE}`, STEP + 200);
  const sentAsk = outbound(
    S,
    P,
    `Please reply with ${NONCE}`,
    STEP + 190,
    "m-ask",
  );
  const judge = (subject: LogEntry[], peer: LogEntry[]) =>
    messagingFailure(subject, peer, S, P, NONCE, STEP);

  it("is green when both legs reached their receiver", () => {
    const subject = [memberStep, sentAsk, inbound(S, P, NONCE, STEP + 400)];
    const peer = [asked, outbound(P, S, NONCE, STEP + 390, "m-reply")];
    expect(judge(subject, peer)).toBeNull();
  });

  // Leg 1 first: with nothing delivered either way, the missing first leg
  // is the cause.
  it("names leg 1 when neither leg arrived, and adds nothing when the agent sent nothing", () => {
    expect(judge([memberStep], [])).toBe(LEG1);
  });

  it("leg 1: names the message the office accepted from the agent", () => {
    const reason = judge([memberStep, sentAsk], []);
    expect(reason?.startsWith(LEG1)).toBe(true);
    expect(reason).toContain("m-ask");
  });

  it("leg 1: quotes the agent's send the office refused", () => {
    const reason = judge(
      [
        memberStep,
        ...refusedSend(S, P, '{"error":{"code":"turn_stale"}}', STEP + 100),
      ],
      [],
    );
    expect(reason?.startsWith(LEG1)).toBe(true);
    expect(reason).toContain("turn_stale");
  });

  // The office accepted the peer's reply (agent_outbound exists only after
  // enqueue returned ok), yet the agent's log has no such message: the
  // product case, and the message id is what to chase.
  it("leg 2: names the reply the office accepted but the agent's log lacks", () => {
    const reason = judge(
      [memberStep, sentAsk],
      [asked, outbound(P, S, `Here: ${NONCE}`, STEP + 390, "m-lost")],
    );
    expect(reason?.startsWith(LEG2)).toBe(true);
    expect(reason).toContain("m-lost");
  });

  // An office refusal leaves no agent_outbound; it must not read as a peer
  // that never tried.
  it("leg 2: quotes the peer's send the office refused, before its other sends", () => {
    const peer = [
      asked,
      ...refusedSend(
        P,
        S,
        '{"error":{"code":"forbidden","message":"stale turn"}}',
        STEP + 300,
      ),
      outbound(P, OTHER, "unrelated note", STEP + 350, "m-other", "Other"),
    ];
    const reason = judge([memberStep, sentAsk], peer);
    expect(reason?.startsWith(LEG2)).toBe(true);
    expect(reason).toContain("stale turn");
    expect(reason).not.toContain("unrelated note");
  });

  it("leg 2: an accepted reply wins over a refused attempt before it", () => {
    const peer = [
      asked,
      ...refusedSend(
        P,
        S,
        '{"error":{"code":"forbidden","message":"stale turn"}}',
        STEP + 300,
      ),
      outbound(P, S, NONCE, STEP + 390, "m-retry"),
    ];
    const reason = judge([memberStep, sentAsk], peer);
    expect(reason).toContain("m-retry");
    expect(reason).not.toContain("stale turn");
  });

  it("leg 2: names the recipient and text of a reply sent to the wrong agent", () => {
    const peer = [
      asked,
      outbound(P, OTHER, `To you: ${NONCE}`, STEP + 390, "m-w", "Other Agent"),
    ];
    const reason = judge([memberStep, sentAsk], peer);
    expect(reason?.startsWith(LEG2)).toBe(true);
    expect(reason).toContain("Other Agent");
    expect(reason).toContain("To you:");
  });

  it("leg 2: names the recipient by id when the office had no name for it", () => {
    const peer = [asked, outbound(P, OTHER, NONCE, STEP + 390, "m-w", null)];
    expect(judge([memberStep, sentAsk], peer)).toContain(OTHER);
  });

  it("leg 2: quotes a reply to the agent that lacks the nonce", () => {
    const peer = [
      asked,
      outbound(P, S, "Got your message, done.", STEP + 390, "m-n"),
    ];
    const reason = judge([memberStep, sentAsk], peer);
    expect(reason?.startsWith(LEG2)).toBe(true);
    expect(reason).toContain("Got your message, done.");
  });

  // The reason is one line of the report: at most three sends, each cut,
  // with line breaks folded.
  it("leg 2: lists at most three sends, each on one line and cut", () => {
    const long = `first line\n\nsecond ${"x".repeat(200)}TAIL`;
    const peer = [
      asked,
      outbound(P, OTHER, long, STEP + 300, "m1"),
      outbound(P, OTHER, "send-two", STEP + 310, "m2"),
      outbound(P, OTHER, "send-three", STEP + 320, "m3"),
      outbound(P, OTHER, "send-four", STEP + 330, "m4"),
    ];
    const reason = judge([memberStep, sentAsk], peer) ?? "";
    expect(reason).not.toContain("\n");
    expect(reason).toContain("first line second");
    expect(reason).not.toContain("TAIL");
    expect(reason).toContain("send-two");
    expect(reason).toContain("send-three");
    expect(reason).not.toContain("send-four");
  });

  // The peer answered in its own chat instead of sending.
  it("leg 2: quotes the peer's last chat text when it sent nothing", () => {
    const peer = [
      asked,
      entry(P, "text", "Let me look at the page.", STEP + 300),
      entry(P, "text", `Reply: ${NONCE}`, STEP + 380),
      entry(P, "text", "   ", STEP + 390),
    ];
    const reason = judge([memberStep, sentAsk], peer);
    expect(reason?.startsWith(LEG2)).toBe(true);
    expect(reason).toContain(`Reply: ${NONCE}`);
    expect(reason).not.toContain("Let me look");
  });

  it("leg 2: says more than the leading clause when the peer sent and said nothing", () => {
    const reason = judge([memberStep, sentAsk], [asked]);
    expect(reason?.startsWith(LEG2)).toBe(true);
    expect((reason ?? "").length).toBeGreaterThan(LEG2.length);
  });

  // A conversation runs several steps: what came before this one is not
  // this step's evidence.
  it("ignores every source before the step", () => {
    const before = STEP - 100;
    expect(
      judge([memberStep, inbound(S, P, NONCE, before)], [asked])?.startsWith(
        LEG2,
      ),
    ).toBe(true);
    expect(
      judge([memberStep, outbound(S, P, NONCE, before, "m-old")], []),
    ).toBe(LEG1);
    expect(
      judge(
        [
          memberStep,
          ...refusedSend(S, P, '{"error":{"code":"old_refusal"}}', before),
        ],
        [],
      ),
    ).toBe(LEG1);
    const quiet = judge([memberStep, sentAsk], [asked]);
    expect(
      judge(
        [memberStep, sentAsk],
        [
          asked,
          outbound(P, S, NONCE, before, "m-old"),
          ...refusedSend(P, S, '{"error":{"code":"old_refusal"}}', before),
          outbound(P, OTHER, "old-note", before, "m-old2"),
          entry(P, "text", "old chat", before),
        ],
      ),
    ).toBe(quiet);
  });
});

describe("judgeCommit", () => {
  const identity = { name: "Ada Owner", email: "ada@example.com" };
  const commit = {
    subject: "conformance nonce-31",
    authorName: "Ada Owner",
    authorEmail: "ada@example.com",
  };

  it("passes the agent's commit with the nonce and the OS user's identity", () => {
    expect(judgeCommit(commit, identity, "nonce-31")).toBeNull();
  });

  it("fails when there is no commit or its message lacks the nonce", () => {
    expect(judgeCommit(null, identity, "nonce-31")).toEqual(expect.any(String));
    expect(
      judgeCommit({ ...commit, subject: "conformance" }, identity, "nonce-31"),
    ).toEqual(expect.any(String));
  });

  // 956b994b: a shell with the profile HOME commits as a fallback identity
  // (user@host), or with only one of the two fields right.
  it("fails when the author name or email is not the OS user's", () => {
    expect(
      judgeCommit({ ...commit, authorName: "nil" }, identity, "nonce-31"),
    ).toEqual(expect.any(String));
    expect(
      judgeCommit(
        { ...commit, authorEmail: "nil@auntie-2" },
        identity,
        "nonce-31",
      ),
    ).toEqual(expect.any(String));
  });
});

describe("newOpenAsk", () => {
  const ask = (id: string, agentId: string, createdAt: number) =>
    ({
      id,
      agentId,
      prompt: "Ship it?",
      options: ["yes", "no"],
      createdAt,
      updatedAt: createdAt,
    }) as AskMemberWire;

  it("finds the ask the agent opened in the step", () => {
    const asks = [ask("a1", S, 500), ask("a2", S, 2000)];
    expect(newOpenAsk(asks, S, 1000)?.id).toBe("a2");
  });

  it("does not count an ask from before the step or from another agent", () => {
    const asks = [ask("a1", S, 500), ask("a3", P, 2000)];
    expect(newOpenAsk(asks, S, 1000)).toBeNull();
  });
});

describe("skillLoaded", () => {
  const claude = fixture(claudeSkillLoad);
  const opencode = fixture(opencodeSkillLoad);
  const codex = fixture(codexSkillLoad);
  const codexOutside = fixture(codexReadOutsideRoot);
  const CODEX_ROOT = "/home/user/.codex/skills";
  const at = (entries: LogEntry[]) => entries[0].timestamp;

  it("finds Claude's Skill tool call for the skill", () => {
    expect(
      skillLoaded(claude, "claude", "isomux-loop-worker", [], at(claude))?.id,
    ).toBe(claude[0].id);
  });

  // OpenCode and Codex leave isError out of a good result.
  it("finds OpenCode's skill tool call for the skill", () => {
    expect("isError" in (opencode[1].metadata ?? {})).toBe(false);
    expect(
      skillLoaded(opencode, "opencode", "wrap-session", [], at(opencode))?.id,
    ).toBe(opencode[0].id);
  });

  it("finds Codex's shell read of SKILL.md under a root the office gives it", () => {
    expect(
      skillLoaded(
        codex,
        "codex",
        "improve-codebase-architecture",
        [CODEX_ROOT],
        at(codex),
      )?.id,
    ).toBe(codex[0].id);
  });

  it("does not count a load of another skill, or one before the step", () => {
    expect(
      skillLoaded(claude, "claude", "wrap-session", [], at(claude)),
    ).toBeNull();
    expect(
      skillLoaded(opencode, "opencode", "wrap-session", [], at(opencode) + 1),
    ).toBeNull();
    expect(
      skillLoaded(codex, "codex", "improve", [CODEX_ROOT], at(codex)),
    ).toBeNull();
  });

  // One engine's tool shape does not prove another engine loaded the skill.
  it("reads each engine's own tool call only", () => {
    expect(
      skillLoaded(claude, "opencode", "isomux-loop-worker", [], at(claude)),
    ).toBeNull();
    expect(
      skillLoaded(opencode, "claude", "wrap-session", [], at(opencode)),
    ).toBeNull();
  });

  it("does not count Codex's read of the skill under a root the office did not give it", () => {
    expect(
      skillLoaded(
        codex,
        "codex",
        "improve-codebase-architecture",
        ["/home/user/.codex/skill", "/home/user/.claude/skills"],
        at(codex),
      ),
    ).toBeNull();
  });

  // The repo copy of a bundled skill (skills/wrap-session/SKILL.md, read by
  // relative path from a checkout) is what an agent finds when the office
  // gave it no skill: red. The same read counts when its cwd puts it under a
  // given root, so the path resolves against the call's cwd.
  it("resolves Codex's relative read against the call's cwd", () => {
    expect(
      skillLoaded(
        codexOutside,
        "codex",
        "wrap-session",
        ["/home/user/src/isomux/skills"],
        at(codexOutside),
      ),
    ).toBeNull();
    expect(
      skillLoaded(
        codexOutside,
        "codex",
        "wrap-session",
        ["/home/user/src/isomux-worktrees/b1018-install/skills"],
        at(codexOutside),
      )?.id,
    ).toBe(codexOutside[0].id);
  });

  const claudeRefused = fixture(claudeSkillRefused);
  const opencodeRefused = fixture(opencodeSkillRefused);
  const results = (
    entries: LogEntry[],
    change: (metadata: Record<string, unknown>) => Record<string, unknown>,
  ): LogEntry[] =>
    entries.map((e) =>
      e.kind === "tool_result"
        ? { ...e, metadata: change({ ...(e.metadata ?? {}) }) }
        : e,
    );

  // Claude answers an unknown skill with "Unknown skill", OpenCode with
  // "Unable to load skill", and the agent then reads the file by hand. The
  // same call with a good result counts, so the refusal is what makes it red.
  it("does not count a skill call the tool refused", () => {
    expect(
      skillLoaded(
        claudeRefused,
        "claude",
        "wrap-session",
        [],
        at(claudeRefused),
      ),
    ).toBeNull();
    expect(
      skillLoaded(
        opencodeRefused,
        "opencode",
        "wrap-session",
        [],
        at(opencodeRefused),
      ),
    ).toBeNull();
    const accepted = (m: Record<string, unknown>) => ({ ...m, isError: false });
    expect(
      skillLoaded(
        results(claudeRefused, accepted),
        "claude",
        "wrap-session",
        [],
        at(claudeRefused),
      )?.id,
    ).toBe(claudeRefused[0].id);
    expect(
      skillLoaded(
        results(opencodeRefused, accepted),
        "opencode",
        "wrap-session",
        [],
        at(opencodeRefused),
      )?.id,
    ).toBe(opencodeRefused[0].id);
  });

  // A call cut off at the step deadline has no result: no proof, so red.
  it("does not count a skill call with no result", () => {
    const cases: [LogEntry[], Engine, string, string[]][] = [
      [claude, "claude", "isomux-loop-worker", []],
      [opencode, "opencode", "wrap-session", []],
      [codex, "codex", "improve-codebase-architecture", [CODEX_ROOT]],
    ];
    for (const [entries, engine, skill, roots] of cases) {
      expect(skillLoaded(entries, engine, skill, roots, at(entries))?.id).toBe(
        entries[0].id,
      );
      const noResult = entries.filter((e) => e.kind !== "tool_result");
      expect({
        engine,
        found: skillLoaded(noResult, engine, skill, roots, at(entries)),
      }).toEqual({ engine, found: null });
    }
  });

  // Another call's result proves nothing, and neither does a result that
  // names no call.
  it("pairs a result with its call by id", () => {
    expect(
      skillLoaded(
        results(claude, (m) => ({ ...m, toolUseId: "toolu_another_call" })),
        "claude",
        "isomux-loop-worker",
        [],
        at(claude),
      ),
    ).toBeNull();
    const noIds = claude.map((e) => {
      const {
        toolId: _call,
        toolUseId: _result,
        ...metadata
      } = e.metadata ?? {};
      return { ...e, metadata };
    });
    expect(
      skillLoaded(noIds, "claude", "isomux-loop-worker", [], at(claude)),
    ).toBeNull();
  });
});

// The real step 1 of an OpenCode run on a server from before 30dd196e: the
// member's line (curl with $ISOMUX_AGENT_TOKEN) was refused, then the agent
// made the task through the socket form from its system prompt. The task
// exists, so only the failed line shows the defect.
describe("failedOfficeCalls", () => {
  const step = fixture(opencodeOfficeCallFailed);
  const MARKER = "CF-office-db58a5";
  const since = step[0].timestamp;
  const refused = step[2];
  const made = step[step.length - 1];

  it("finds the member's line the office refused, though the agent then made the task", () => {
    expect(made.content).toContain(MARKER);
    expect(failedOfficeCalls(step, MARKER, since).map((e) => e.id)).toEqual([
      refused.id,
    ]);
  });

  it("does not count another step's marker, or a failure before the step", () => {
    expect(failedOfficeCalls(step, MARKER, since)).toHaveLength(1);
    expect(failedOfficeCalls(step, "CF-room-adbb17", since)).toEqual([]);
    expect(failedOfficeCalls(step, MARKER, refused.timestamp + 1)).toEqual([]);
  });

  // A line that never reached the office (wrong address, no socket) has no
  // office error in its output; the tool marks it failed.
  it("counts the line when the tool reports an error", () => {
    const unreachable = step.map((e) =>
      e.id === made.id
        ? {
            ...e,
            content: "curl: (7) Failed to connect to isomux port 80",
            metadata: { ...e.metadata, isError: true },
          }
        : e,
    );
    expect(
      failedOfficeCalls(unreachable, MARKER, since).map((e) => e.id),
    ).toEqual([refused.id, made.id]);
  });

  // The agent's own failed office call (a page that does not exist) is not
  // the member's line.
  it("does not count a failed office call without the step's marker", () => {
    const stray: LogEntry[] = [
      {
        id: "log-stray-call",
        agentId: step[1].agentId,
        timestamp: made.timestamp + 10,
        kind: "tool_call",
        content: "shell",
        metadata: {
          toolId: "call-stray",
          input: {
            command:
              'curl -s localhost:36647/api/agent-reference/nope -H "Authorization: Bearer $ISOMUX_AGENT_TOKEN"',
          },
        },
      },
      {
        id: "log-stray-result",
        agentId: step[1].agentId,
        timestamp: made.timestamp + 20,
        kind: "tool_result",
        content: '{"error":{"code":"not_found","message":"not found"}}',
        metadata: { toolUseId: "call-stray", isError: true },
      },
    ];
    expect(
      failedOfficeCalls([...step, ...stray], MARKER, since).map((e) => e.id),
    ).toEqual([refused.id]);
  });
});

describe("slashResolved", () => {
  const resolved = fixture(claudeSlash);
  const at = resolved[0].timestamp;

  it("finds the member's slash command that the office expanded into the skill", () => {
    expect(slashResolved(resolved, "wrap-session", at)?.id).toBe(
      resolved[0].id,
    );
  });

  // An unknown command stores the typed text with no expansion.
  it("does not count the command when the office did not expand it", () => {
    const { sdkText: _dropped, ...metadata } = resolved[0].metadata ?? {};
    const unexpanded = [{ ...resolved[0], metadata }];
    expect(slashResolved(unexpanded, "wrap-session", at)).toBeNull();
  });

  it("does not count another command, or one before the step", () => {
    const other = [{ ...resolved[0], content: "/wrap-sessionx" }];
    expect(slashResolved(other, "wrap-session", at)).toBeNull();
    expect(slashResolved(resolved, "wrap-session", at + 1)).toBeNull();
  });
});
