// The record player's engine and its lobby control, over a fake AudioContext
// that keeps the audio graph: a note is audible while its source is not
// stopped and a path of connections still reaches the destination. A stop
// that only suspends the context leaves every queued note audible, because
// those notes play the moment the context runs again.
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "../../test-support/dom.ts";
setUpDomTestFile();
const { act, render, renderHook } = await import("@testing-library/react");
const { createElement } = await import("react");
const { LobbyScene } = await import("./LobbyScene.tsx");
const { STYLES, stopJukebox, toggleJukebox, useJukebox } =
  await import("./jukebox.ts");

class FakeNode {
  out = new Set<FakeNode>();
  connect<T extends FakeNode>(next: T): T {
    this.out.add(next);
    return next;
  }
  disconnect() {
    this.out.clear();
  }
}

const param = () => ({
  value: 0,
  setValueAtTime() {},
  linearRampToValueAtTime() {},
  exponentialRampToValueAtTime() {},
  cancelScheduledValues() {},
  setTargetAtTime() {},
});

class FakeSource extends FakeNode {
  frequency = param();
  buffer: unknown = null;
  loop = false;
  onended: (() => void) | null = null;
  startAt: number | null = null;
  stops: number[] = [];
  constructor(readonly ctx: FakeAudioContext) {
    super();
    ctx.sources.push(this);
  }
  setPeriodicWave() {}
  start(at = 0) {
    this.startAt = at;
  }
  stop(at?: number) {
    this.stops.push(at ?? this.ctx.currentTime);
  }
}

const contexts: FakeAudioContext[] = [];

class FakeAudioContext {
  state: "suspended" | "running" | "closed" = "suspended";
  currentTime = 0;
  sampleRate = 8000;
  destination = new FakeNode();
  sources: FakeSource[] = [];
  resumes: { resolve: () => void; reject: (e: Error) => void }[] = [];
  constructor() {
    contexts.push(this);
  }
  resume(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.resumes.push({
        resolve: () => {
          if (this.state !== "closed") this.state = "running";
          resolve();
        },
        reject,
      });
    });
  }
  suspend(): Promise<void> {
    if (this.state === "running") this.state = "suspended";
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = "closed";
    return Promise.resolve();
  }
  createBuffer(_channels: number, length: number) {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }
  createPeriodicWave() {
    return {};
  }
  createOscillator() {
    return new FakeSource(this);
  }
  createBufferSource() {
    return new FakeSource(this);
  }
  createGain() {
    return Object.assign(new FakeNode(), { gain: param() });
  }
  createBiquadFilter() {
    return Object.assign(new FakeNode(), { type: "", frequency: param() });
  }
}

(globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;

const reaches = (from: FakeNode, to: FakeNode, seen = new Set<FakeNode>()) => {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  for (const next of from.out) if (reaches(next, to, seen)) return true;
  return false;
};

// A stop counts when it is the source's second stop call (the first one is
// scheduled with the note) and lands within a short fade of now.
const audible = (s: FakeSource) => {
  if (s.ctx.state === "closed" || s.startAt === null) return false;
  const silenced = s.stops.slice(1).some((at) => at <= s.ctx.currentTime + 0.5);
  return !silenced && reaches(s, s.ctx.destination);
};

const allSources = () => contexts.flatMap((c) => c.sources);
const audibleSources = () => allSources().filter(audible);

// Settles every resume the engine waits on (or rejects them), then lets the
// engine's resume callbacks run.
async function settleResumes(fail = false) {
  await act(async () => {
    for (const c of contexts) {
      for (const r of c.resumes.splice(0)) {
        if (fail) r.reject(new Error("resume refused"));
        else r.resolve();
      }
    }
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function press() {
  act(() => toggleJukebox());
}

afterEach(async () => {
  act(() => stopJukebox());
  await settleResumes();
});

describe("record player engine", () => {
  it("a press plays the take, and the next press silences every queued note", async () => {
    const state = renderHook(() => useJukebox());
    press();
    await settleResumes();
    expect(state.result.current.playing).toBe(true);
    const queued = audibleSources();
    // Notes are queued ahead of the clock, so a stop has notes to silence.
    expect(queued.some((s) => (s.startAt ?? 0) > 1)).toBe(true);
    press();
    expect(state.result.current.playing).toBe(false);
    expect(audibleSources().length).toBe(0);
    state.unmount();
  });

  it("stopJukebox silences every queued note", async () => {
    press();
    await settleResumes();
    expect(audibleSources().length).toBeGreaterThan(0);
    act(() => stopJukebox());
    expect(audibleSources().length).toBe(0);
  });

  it("a stop before the audio starts leaves nothing to play", async () => {
    const state = renderHook(() => useJukebox());
    const before = allSources().length;
    press();
    expect(state.result.current.playing).toBe(true);
    press();
    await settleResumes();
    expect(state.result.current.playing).toBe(false);
    expect(allSources().length).toBe(before);
    state.unmount();
  });

  it("a press, a stop and a press before the audio starts play the take once", async () => {
    // One seed for every take, so the same style gives the same take.
    const seed = spyOn(crypto, "getRandomValues").mockImplementation(
      <T extends ArrayBufferView | null>(array: T) => {
        if (array instanceof Uint32Array) array[0] = 4242;
        return array;
      },
    );
    const state = renderHook(() => useJukebox());
    press();
    press();
    press();
    const raced = state.result.current.style;
    // The first resume settles first: it must not schedule the new take.
    await settleResumes();
    const racedCount = audibleSources().length;
    press();
    for (let i = 1; i < STYLES.length; i += 1) {
      press();
      press();
    }
    await settleResumes();
    expect(audibleSources().length).toBe(0);
    press();
    await settleResumes();
    expect(state.result.current.style).toBe(raced);
    const cleanCount = audibleSources().length;
    expect(cleanCount).toBeGreaterThan(0);
    expect(racedCount).toBe(cleanCount);
    seed.mockRestore();
    state.unmount();
  });

  it("a refused resume goes back to stopped", async () => {
    const state = renderHook(() => useJukebox());
    press();
    expect(state.result.current.playing).toBe(true);
    await settleResumes(true);
    expect(state.result.current.playing).toBe(false);
    expect(state.result.current.style).toBeNull();
    state.unmount();
  });

  it("each press plays another style until every style has played", async () => {
    const state = renderHook(() => useJukebox());
    const seen = new Set<string>();
    for (let i = 0; i < STYLES.length; i += 1) {
      press();
      await settleResumes();
      const { playing, style } = state.result.current;
      expect(playing).toBe(true);
      expect(style).not.toBeNull();
      seen.add(style!);
      press();
      expect(state.result.current.style).toBeNull();
    }
    expect([...seen].sort()).toEqual([...STYLES].sort());
    state.unmount();
  });
});

// The scene's props layer: the svg that holds the lobby's own gradients.
function propsLayer(container: HTMLElement) {
  return container.querySelector("#lobby-fire-glow")!.closest("svg")!;
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const scene = (jukebox: boolean) =>
  createElement(LobbyScene, {
    rooms: [],
    officeName: null,
    mode: "dark",
    layout: "nilo",
    jukebox,
  });

describe("record player in the lobby", () => {
  it("is a control only in the live lobby", () => {
    for (const [jukebox, controls] of [
      [false, 0],
      [true, 1],
    ] as const) {
      const view = render(scene(jukebox));
      expect(
        propsLayer(view.container).querySelectorAll("[data-no-pan]").length,
      ).toBe(controls);
      view.unmount();
    }
  });

  it("spins while it plays and stops spinning when pressed again", async () => {
    const view = render(scene(true));
    const player = propsLayer(view.container).querySelector("[data-no-pan]")!;
    // The disc turns inside the control; other props animate on their own.
    const spinning = () =>
      propsLayer(view.container).querySelector(
        "[data-no-pan] animateTransform",
      ) !== null;
    expect(spinning()).toBe(false);
    click(player);
    await settleResumes();
    expect(spinning()).toBe(true);
    click(player);
    expect(spinning()).toBe(false);
    view.unmount();
  });

  it("leaving the lobby stops the music", async () => {
    const view = render(scene(true));
    const player = propsLayer(view.container).querySelector("[data-no-pan]")!;
    click(player);
    await settleResumes();
    const state = renderHook(() => useJukebox());
    expect(state.result.current.playing).toBe(true);
    view.unmount();
    expect(state.result.current.playing).toBe(false);
    expect(audibleSources().length).toBe(0);
    state.unmount();
  });
});
