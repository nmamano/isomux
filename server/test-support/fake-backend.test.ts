import { describe, expect, it } from "bun:test";
import { FakeBackend, FakeSession } from "./fake-backend.ts";
import type {
  Backend,
  CreateSessionOptions,
  NormalizedEvent,
} from "../backends/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function opts(agentId = "a1"): CreateSessionOptions {
  return {
    agentId,
    cwd: "/tmp/fake",
    systemPrompt: "sys",
    modelFamily: "fake",
    effort: "default",
    permissionMode: "default",
  };
}

async function collect(
  stream: AsyncIterable<NormalizedEvent>,
): Promise<NormalizedEvent[]> {
  const out: NormalizedEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

const kinds = (evs: NormalizedEvent[]) => evs.map((e) => e.kind);
const tick = () => new Promise<void>((r) => setTimeout(r, 5));

// ---------------------------------------------------------------------------
// Backend contract
// ---------------------------------------------------------------------------

describe("FakeBackend — Backend contract", () => {
  it("is assignable to a Backend resolver", () => {
    const fake = new FakeBackend();
    // Type-level: the managers' resolveBackend dep is (agentType) => Backend.
    const resolveBackend: (agentType: "claude" | "codex") => Backend = () =>
      fake;
    expect(resolveBackend("claude")).toBe(fake);
  });

  it("defaults capabilities and exposes config overrides", async () => {
    const fake = new FakeBackend();
    expect(fake.capabilities.fork).toBe(true);

    const custom = new FakeBackend({
      capabilities: {
        fork: false,
        hooks: false,
        skills: false,
        oneShot: false,
        canUseTool: false,
        topicGen: false,
        edit: false,
        mcp: false,
      },
      modelOptions: [{ value: "m", label: "M" }],
    });
    expect(custom.capabilities.fork).toBe(false);
    expect(custom.getModelOptions()).toEqual([{ value: "m", label: "M" }]);
  });

  it("oneShotPrompt returns configured value (string + function) and counts", async () => {
    const fixed = new FakeBackend({ oneShot: "topic: refactor" });
    expect(await fixed.oneShotPrompt("p", { modelFamily: "fake" })).toBe(
      "topic: refactor",
    );
    expect(fixed.oneShotCount).toBe(1);

    const fn = new FakeBackend({ oneShot: (p) => `echo:${p}` });
    expect(await fn.oneShotPrompt("hi", { modelFamily: "fake" })).toBe(
      "echo:hi",
    );
  });

  it("detectAuthError is configurable, default never", () => {
    expect(new FakeBackend().detectAuthError("anything")).toBe(false);
    const auth = new FakeBackend({
      isAuthError: (t) => t.includes("Invalid API key"),
    });
    expect(auth.detectAuthError("Invalid API key")).toBe(true);
    expect(auth.detectAuthError("fine")).toBe(false);
  });

  it("forkSessionBeforeMessage defaults to fresh, honors override", async () => {
    expect(await new FakeBackend().forkSessionBeforeMessage("s", "m")).toEqual({
      kind: "fresh",
    });
    const forked = new FakeBackend({
      forkResult: {
        kind: "fork",
        sessionId: "child",
        forkedFromSessionId: "s",
      },
    });
    expect(await forked.forkSessionBeforeMessage("s", "m")).toEqual({
      kind: "fork",
      sessionId: "child",
      forkedFromSessionId: "s",
    });
    expect(forked.forkCount).toBe(1);
  });

  it("tracks sessions and resolves by agent", () => {
    const fake = new FakeBackend();
    fake.createSession(opts("a1"));
    fake.createSession(opts("a2"));
    expect(fake.createSessionCount).toBe(2);
    expect(fake.lastSession?.opts.agentId).toBe("a2");
    expect(fake.sessionForAgent("a1")?.opts.agentId).toBe("a1");
    expect(fake.sessionForAgent("nope")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

describe("FakeSession — stream lifecycle", () => {
  it("auto-emits system_init carrying the assigned sessionId", async () => {
    const fake = new FakeBackend();
    fake.createSession(opts());
    const s = fake.lastSession!;
    s.endStream();
    const got = await collect(s.stream());
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      kind: "system_init",
      sessionId: s.sessionId,
    });
  });

  it("resumeSession reuses the provided id on its system_init", async () => {
    const fake = new FakeBackend();
    fake.resumeSession("prior-session", opts());
    const s = fake.lastSession!;
    expect(s.isResume).toBe(true);
    expect(s.sessionId).toBe("prior-session");
    s.endStream();
    const got = await collect(s.stream());
    expect(got[0]).toMatchObject({
      kind: "system_init",
      sessionId: "prior-session",
    });
  });

  it("yields pushed events in order, then completeTurn boundary", async () => {
    const fake = new FakeBackend({ session: { autoSystemInit: false } });
    fake.createSession(opts());
    const s = fake.lastSession!;
    s.push({ kind: "thinking", text: "hmm" });
    s.completeTurn({ text: "done" });
    s.endStream();
    expect(kinds(await collect(s.stream()))).toEqual([
      "thinking",
      "assistant_text",
      "turn_completed",
    ]);
  });

  it("ignores pushes after close() / endStream()", async () => {
    const fake = new FakeBackend({ session: { autoSystemInit: false } });
    fake.createSession(opts());
    const s = fake.lastSession!;
    s.push({ kind: "assistant_text", text: "kept" });
    s.close();
    s.push({ kind: "assistant_text", text: "dropped" });
    const got = await collect(s.stream());
    expect(kinds(got)).toEqual(["assistant_text"]);
    expect(got[0]).toMatchObject({ text: "kept" });
  });

  it("close() unblocks a parked stream() and is idempotent", async () => {
    const fake = new FakeBackend({ session: { autoSystemInit: false } });
    fake.createSession(opts());
    const s = fake.lastSession!;
    const collected = collect(s.stream()); // parks: buffer empty, not ended
    await tick();
    s.close();
    s.close(); // idempotent — must not throw
    expect(await collected).toEqual([]); // resolved, did not hang
    expect(s.closed).toBe(true);
  });

  it("endStream() unblocks a parked stream() and is idempotent", async () => {
    const fake = new FakeBackend({ session: { autoSystemInit: false } });
    fake.createSession(opts());
    const s = fake.lastSession!;
    const collected = collect(s.stream()); // parks: buffer empty, not ended
    await tick();
    s.endStream();
    s.endStream(); // idempotent — must not throw
    expect(await collected).toEqual([]); // resolved, did not hang
  });

  it("records sends and runs an onSend auto-responder", async () => {
    const fake = new FakeBackend({
      session: {
        autoSystemInit: false,
        onSend: (text, _att, session) =>
          session.completeTurn({ text: `re:${text}` }),
      },
    });
    fake.createSession(opts());
    const s = fake.lastSession!;
    await s.send("ping");
    s.endStream();
    expect(s.sent).toEqual([{ text: "ping", attachments: undefined }]);
    const got = await collect(s.stream());
    expect(got).toContainEqual({ kind: "assistant_text", text: "re:ping" });
  });

  it("abort() is idempotent and records, canAbortInPlace is configurable", async () => {
    const fake = new FakeBackend({ session: { abortInPlace: true } });
    fake.createSession(opts());
    const s = fake.lastSession!;
    expect(s.canAbortInPlace()).toBe(true);
    await s.abort();
    await s.abort();
    expect(s.abortCount).toBe(2);
    expect(new FakeBackend().createSession(opts()).canAbortInPlace()).toBe(
      false,
    );
  });

  it("approve() records the decision", async () => {
    const fake = new FakeBackend();
    const session = fake.createSession(opts()) as FakeSession;
    await session.approve("ap1", { kind: "allow_once" });
    expect(session.approvals).toEqual([
      { approvalId: "ap1", decision: { kind: "allow_once" } },
    ]);
  });

  it("getContextUsage returns null by default, override honored", async () => {
    expect(
      await new FakeBackend().createSession(opts()).getContextUsage(),
    ).toBe(null);
    const usage = {
      model: "fake",
      totalTokens: 10,
      maxTokens: 100,
      percentage: 10,
    };
    const fake = new FakeBackend({ session: { contextUsage: usage } });
    expect(await fake.createSession(opts()).getContextUsage()).toEqual(usage);
  });
});
