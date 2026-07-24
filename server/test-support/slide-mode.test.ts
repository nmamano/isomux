import { describe, it, expect } from "bun:test";
import {
  createSlideMode,
  buildFormatterPrompt,
  extractSlideHtml,
  type SlideJobContext,
} from "../slide-mode.ts";
import type { DeckTurn } from "../../shared/slide-turns.ts";
import type { SlideRecord } from "../../shared/types.ts";

// A deferred we resolve by hand to hold a generation open.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function turn(overrides: Partial<DeckTurn> = {}): DeckTurn {
  return {
    entryId: "u1",
    promptText: "What is 2+2?",
    assistantText: "It is 4.",
    errorText: null,
    placeholder: false,
    ...overrides,
  };
}

interface Harness {
  ensureSlide: ReturnType<typeof createSlideMode>["ensureSlide"];
  deck: Map<string, SlideRecord>;
  ready: Array<{ entryId: string; slide: SlideRecord }>;
  calls: string[]; // prompts passed to the backend, in order
  resolveNext: (html: string) => void;
  concurrentPeak: () => number;
  setToken: (t: number) => void;
  setJob: (entryId: string, job: SlideJobContext | null) => void;
}

function harness(): Harness {
  const deck = new Map<string, SlideRecord>();
  const ready: Array<{ entryId: string; slide: SlideRecord }> = [];
  const calls: string[] = [];
  let currentToken = 1;
  let concurrent = 0;
  let peak = 0;
  const pending: Array<{ resolve: (v: string) => void }> = [];
  const jobs = new Map<string, SlideJobContext | null>();

  const defaultJob = (entryId: string): SlideJobContext => ({
    agentType: "claude",
    modelFamily: "sonnet",
    cwd: "/tmp",
    rootSessionId: "root1",
    token: currentToken,
    turn: turn({ entryId }),
    prevSlideHtml: null,
  });

  const slideMode = createSlideMode({
    resolveBackend: () => ({
      oneShotPrompt: (prompt: string) => {
        calls.push(prompt);
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        const d = deferred<string>();
        pending.push({
          resolve: (html: string) => {
            concurrent -= 1;
            d.resolve(html);
          },
        });
        return d.promise;
      },
    }),
    resolveJob: (_agentId, entryId) =>
      jobs.has(entryId) ? jobs.get(entryId)! : defaultJob(entryId),
    isCurrent: (_agentId, token) => token === currentToken,
    readSlide: (_a, _root, entryId) => deck.get(entryId) ?? null,
    writeSlide: (_a, _root, entryId, rec) => deck.set(entryId, rec),
    onSlideReady: (_a, _root, entryId, rec) =>
      ready.push({ entryId, slide: rec }),
    now: () => 1000,
  });

  return {
    ensureSlide: slideMode.ensureSlide,
    deck,
    ready,
    calls,
    resolveNext: (html) => pending.shift()?.resolve(html),
    concurrentPeak: () => peak,
    setToken: (t) => {
      currentToken = t;
    },
    setJob: (entryId, job) => jobs.set(entryId, job),
  };
}

describe("createSlideMode.ensureSlide", () => {
  it("returns a cached slide without calling the backend", async () => {
    const h = harness();
    h.deck.set("u1", {
      html: "<div>cached</div>",
      placeholder: false,
      errorText: null,
      promptText: "q",
      model: "sonnet",
      createdAt: 1,
    });
    const res = h.ensureSlide("a1", "u1");
    expect(res).toEqual({ status: "ready", slide: h.deck.get("u1")! });
    await flush();
    expect(h.calls).toHaveLength(0);
  });

  it("generates on a miss: pending → writes + broadcasts the slide", async () => {
    const h = harness();
    const res = h.ensureSlide("a1", "u1");
    expect(res).toEqual({ status: "pending" });
    await flush();
    expect(h.calls).toHaveLength(1);
    h.resolveNext("<div>slide</div>");
    await flush();
    expect(h.deck.get("u1")?.html).toBe("<div>slide</div>");
    expect(h.ready).toHaveLength(1);
    expect(h.ready[0].entryId).toBe("u1");
  });

  it("dedupes concurrent requests for the same turn", async () => {
    const h = harness();
    h.ensureSlide("a1", "u1");
    h.ensureSlide("a1", "u1");
    const third = h.ensureSlide("a1", "u1");
    expect(third).toEqual({ status: "pending" });
    await flush();
    expect(h.calls).toHaveLength(1); // one generation, not three
  });

  it("writes a placeholder with no backend call for an empty turn", async () => {
    const h = harness();
    h.setJob("u1", {
      agentType: "claude",
      modelFamily: "sonnet",
      cwd: "/tmp",
      rootSessionId: "root1",
      token: 1,
      turn: turn({ placeholder: true, assistantText: "", errorText: "boom" }),
      prevSlideHtml: null,
    });
    h.ensureSlide("a1", "u1");
    await flush();
    expect(h.calls).toHaveLength(0);
    expect(h.deck.get("u1")).toMatchObject({
      html: null,
      placeholder: true,
      errorText: "boom",
    });
    expect(h.ready).toHaveLength(1);
  });

  it("drops a result whose conversation token moved on (stale guard)", async () => {
    const h = harness();
    h.ensureSlide("a1", "u1");
    await flush();
    h.setToken(2); // /clear|/resume|fork happened during generation
    h.resolveNext("<div>late</div>");
    await flush();
    expect(h.deck.has("u1")).toBe(false);
    expect(h.ready).toHaveLength(0);
  });

  it("force regenerates even when cached, threading feedback into the prompt", async () => {
    const h = harness();
    h.deck.set("u1", {
      html: "<div>old</div>",
      placeholder: false,
      errorText: null,
      promptText: "q",
      model: "sonnet",
      createdAt: 1,
    });
    const res = h.ensureSlide("a1", "u1", {
      force: true,
      feedback: "bigger title",
    });
    expect(res).toEqual({ status: "pending" });
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toContain("bigger title");
    h.resolveNext("<div>new</div>");
    await flush();
    expect(h.deck.get("u1")?.html).toBe("<div>new</div>"); // overwrote
  });

  it("returns unavailable when the turn cannot be resolved", () => {
    const h = harness();
    h.setJob("gone", null);
    expect(h.ensureSlide("a1", "gone")).toEqual({ status: "unavailable" });
  });

  it("a re-request under a new conversation token starts a fresh job", async () => {
    // Regression: an old-token job in flight must not dedupe a new-token request
    // (the old job is dropped by the stale guard, so the turn would otherwise
    // never generate). Keying by token fixes it.
    const h = harness();
    h.ensureSlide("a1", "u1"); // token 1, key a1::1::u1
    await flush();
    expect(h.calls).toHaveLength(1);
    h.setToken(2); // /clear|/resume|fork
    h.ensureSlide("a1", "u1"); // token 2, key a1::2::u1 → NOT deduped
    await flush();
    expect(h.calls).toHaveLength(2); // a live job for the new conversation
    h.resolveNext("<div>old</div>"); // token-1 job → dropped by stale guard
    h.resolveNext("<div>new</div>"); // token-2 job → written
    await flush();
    expect(h.deck.get("u1")?.html).toBe("<div>new</div>");
    expect(h.ready).toHaveLength(1);
  });

  it("coalesces rapid force regens into one rerun with the latest feedback", async () => {
    const h = harness();
    h.ensureSlide("a1", "u1"); // initial, no feedback
    await flush();
    expect(h.calls).toHaveLength(1);
    h.ensureSlide("a1", "u1", { force: true, feedback: "A" }); // queued rerun
    h.ensureSlide("a1", "u1", { force: true, feedback: "B" }); // overwrites A
    await flush();
    expect(h.calls).toHaveLength(1); // no competing writer while gen1 runs
    h.resolveNext("<div>1</div>"); // gen1 done → rerun fires
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toContain("B");
    expect(h.calls[1]).not.toContain("A");
    h.resolveNext("<div>2</div>");
    await flush();
  });

  it("caps concurrency at 2 per agent", async () => {
    const h = harness();
    h.ensureSlide("a1", "u1");
    h.ensureSlide("a1", "u2");
    h.ensureSlide("a1", "u3");
    h.ensureSlide("a1", "u4");
    await flush();
    expect(h.concurrentPeak()).toBe(2);
    expect(h.calls).toHaveLength(2); // only 2 running; others queued
    h.resolveNext("<div>1</div>");
    await flush();
    expect(h.calls).toHaveLength(3); // a slot freed → the next starts
  });
});

describe("slide prompt + output helpers", () => {
  it("buildFormatterPrompt includes prompt, answer, style ref, and feedback", () => {
    const p = buildFormatterPrompt(turn(), "<div>prev</div>", "make it teal");
    expect(p).toContain("What is 2+2?");
    expect(p).toContain("It is 4.");
    expect(p).toContain("<div>prev</div>");
    expect(p).toContain("make it teal");
  });

  it("extractSlideHtml strips a stray code fence", () => {
    expect(extractSlideHtml("```html\n<div>x</div>\n```")).toBe("<div>x</div>");
  });

  it("extractSlideHtml throws when the model didn't return a root div", () => {
    expect(() => extractSlideHtml("Sorry, I can't.")).toThrow();
    expect(() => extractSlideHtml("<span>x</span>")).toThrow();
    expect(() => extractSlideHtml("<div>a</div><div>b</div>")).toThrow(); // multi-root
  });

  it("extractSlideHtml rejects network-capable / scriptable markup", () => {
    expect(() => extractSlideHtml('<div><img src="x"></div>')).toThrow();
    expect(() =>
      extractSlideHtml('<div><a href="http://x">y</a></div>'),
    ).toThrow();
    expect(() => extractSlideHtml("<div><script>1</script></div>")).toThrow();
    expect(() =>
      extractSlideHtml('<div style="background:url(http://x)">y</div>'),
    ).toThrow();
    expect(() => extractSlideHtml('<div onclick="x()">y</div>')).toThrow();
    expect(() => extractSlideHtml("<div><svg></svg></div>")).toThrow();
  });

  it("extractSlideHtml accepts a clean inline-styled slide", () => {
    const good =
      '<div style="width:100%;height:100%"><h1 style="color:#6ea8fe">Hi</h1></div>';
    expect(extractSlideHtml(good)).toBe(good);
  });

  it("extractSlideHtml accepts code TEXT that merely mentions href/url()/data:", () => {
    // "copy code verbatim": these are text/code nodes, not real markup — the CSP
    // is the boundary, so the validator must not reject them.
    const cases = [
      "<div><pre>&lt;a href=&quot;/docs&quot;&gt;</pre></div>",
      "<div><pre>background: url(/hero.png)</pre></div>",
      "<div><code>data:text/plain,hi</code></div>",
      "<div><code>curl https://api.example/v1</code></div>",
    ];
    for (const c of cases) expect(extractSlideHtml(c)).toBe(c);
  });

  it("extractSlideHtml treats a '>' inside a quoted attribute as one root", () => {
    // The quote-aware tokenizer keeps the tag intact, so the single-root check
    // isn't fooled into seeing a sibling.
    const good = `<div style="content:'a>b'"><span style="color:#6ea8fe">x</span></div>`;
    expect(extractSlideHtml(good)).toBe(good);
  });
});
