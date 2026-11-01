// The turn-end chime and the click that unlocks it, over a fake AudioContext.
// On iOS a running AudioContext pauses audio from other apps (task a9920df0),
// so a context exists only once a room can sound, and it runs only while a
// chime plays.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { StoreProvider } = await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
const { connect, setShim, shimEmit } = await import("./ws.ts");
const { createNotificationSound } = await import("./notification-sound.ts");
const { LOBBY_ROOM_ID } = await import("../shared/types.ts");

type AgentInfo = import("../shared/types.ts").AgentInfo;
type UserRecord = import("../shared/types.ts").UserRecord;

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
});

class FakeOscillator extends FakeNode {
  frequency = param();
  type = "sine";
  started = false;
  ended = false;
  onended: ((e: Event) => void) | null = null;
  private listeners: ((e: Event) => void)[] = [];
  addEventListener(type: string, fn: (e: Event) => void) {
    if (type === "ended") this.listeners.push(fn);
  }
  removeEventListener(type: string, fn: (e: Event) => void) {
    if (type === "ended")
      this.listeners = this.listeners.filter((f) => f !== fn);
  }
  start() {
    this.started = true;
  }
  stop() {}
  // What the browser does when the scheduled stop time has passed.
  end() {
    this.ended = true;
    const e = new Event("ended");
    this.onended?.call(this, e);
    for (const fn of [...this.listeners]) fn.call(this, e);
  }
}

const contexts: FakeAudioContext[] = [];

// resume() and suspend() take effect in call order, a microtask later, as in a
// browser: a suspend still pending leaves state "running".
class FakeAudioContext {
  // Made inside a click, so the browser starts it at once.
  state: "suspended" | "running" | "closed" = "running";
  currentTime = 0;
  destination = new FakeNode();
  oscillators: FakeOscillator[] = [];
  constructor() {
    contexts.push(this);
  }
  resume(): Promise<void> {
    return Promise.resolve().then(() => {
      if (this.state !== "closed") this.state = "running";
    });
  }
  suspend(): Promise<void> {
    return Promise.resolve().then(() => {
      if (this.state !== "closed") this.state = "suspended";
    });
  }
  close(): Promise<void> {
    this.state = "closed";
    return Promise.resolve();
  }
  createOscillator() {
    const osc = new FakeOscillator();
    this.oscillators.push(osc);
    return osc;
  }
  createGain() {
    return Object.assign(new FakeNode(), { gain: param() });
  }
}

const reaches = (from: FakeNode, to: FakeNode): boolean =>
  from === to || [...from.out].some((n) => reaches(n, to));
// Chimes that sound now: started, not ended, wired to a running context's
// speakers.
const sounding = () =>
  contexts.flatMap((ctx) =>
    ctx.state !== "running"
      ? []
      : ctx.oscillators.filter(
          (o) => o.started && !o.ended && reaches(o, ctx.destination),
        ),
  );
const lastOscillator = () => contexts.at(-1)!.oscillators.at(-1)!;
const settle = () => act(async () => {});

const g = globalThis as { AudioContext?: unknown };
const browserAudio = g.AudioContext;
let hidden = false;
// Kept: the DOM harness unregisters the global document before this file's
// afterAll runs.
const doc = document;
Object.defineProperty(doc, "hidden", {
  configurable: true,
  get: () => hidden,
});
const noop = () => {};
setApiShim(async () => ({}));
afterAll(() => {
  g.AudioContext = browserAudio;
  delete (doc as { hidden?: boolean }).hidden;
  setApiShim(null);
  setShim(noop);
  connect(noop, noop);
});
beforeEach(() => {
  contexts.length = 0;
  g.AudioContext = FakeAudioContext;
  hidden = false;
  localStorage.clear();
});

// --- The sound on its own ---

it("a prime makes one context and leaves it suspended, and a second prime makes none", async () => {
  const sound = createNotificationSound();
  sound.prime();
  await settle();
  expect(contexts.map((c) => c.state)).toEqual(["suspended"]);
  expect(contexts[0].oscillators).toHaveLength(0);
  sound.prime();
  await settle();
  expect(contexts.map((c) => c.state)).toEqual(["suspended"]);
});

it("a chime runs its context only while it plays, and the next chime uses the same context", async () => {
  const sound = createNotificationSound();
  for (const round of [1, 2]) {
    sound.play();
    await settle();
    expect({
      round,
      contexts: contexts.length,
      sounding: sounding().length,
    }).toEqual({
      round,
      contexts: 1,
      sounding: 1,
    });
    lastOscillator().end();
    await settle();
    expect({ round, state: contexts[0].state }).toEqual({
      round,
      state: "suspended",
    });
  }
});

it("two overlapping chimes keep the context running until the last one ends", async () => {
  const sound = createNotificationSound();
  sound.play();
  sound.play();
  await settle();
  const [first, second] = contexts[0].oscillators;
  first.end();
  await settle();
  expect(contexts[0].state).toBe("running");
  expect(sounding()).toEqual([second]);
  second.end();
  await settle();
  expect(contexts[0].state).toBe("suspended");
});

it("a chime that starts while a suspend is still pending plays", async () => {
  // After a chime ends...
  const sound = createNotificationSound();
  sound.play();
  await settle();
  lastOscillator().end();
  sound.play();
  await settle();
  expect(sounding()).toHaveLength(1);
  // ...and right after a prime.
  contexts.length = 0;
  const fresh = createNotificationSound();
  fresh.prime();
  fresh.play();
  await settle();
  expect(contexts).toHaveLength(1);
  expect(sounding()).toHaveLength(1);
});

it("without an AudioContext in the browser, a prime and a chime do nothing, and a later chime still plays and stops", async () => {
  g.AudioContext = undefined;
  const sound = createNotificationSound();
  // Called directly: a throw fails the test.
  sound.prime();
  sound.play();
  g.AudioContext = FakeAudioContext;
  sound.play();
  await settle();
  expect(sounding()).toHaveLength(1);
  lastOscillator().end();
  await settle();
  // A chime that never started is not counted as playing.
  expect(contexts.map((c) => c.state)).toEqual(["suspended"]);
});

// --- Through the store: the member's rooms decide ---

const SELF = "u-self";
function self(notifRooms: string[]): UserRecord {
  return {
    id: SELF,
    name: "Tester",
    notifRooms,
    createdAt: 0,
    role: "member",
    avatarColor: "#4a90d9",
    avatarVariant: "classic",
    allowedRooms: [],
    hidden: [],
    order: [],
    tucked: [],
    pushRooms: [],
    memberPrompt: null,
    language: null,
  };
}
// One agent per room, each in a turn this member started.
const AGENTS = { r1: "a-r1", r2: "a-r2", [LOBBY_ROOM_ID]: "a-lobby" };
function mount(notifRooms: string[]) {
  setShim(noop);
  render(createElement(StoreProvider, null, null));
  act(() => {
    shimEmit({
      type: "session_context",
      context: {
        userId: SELF,
        username: "Tester",
        role: "member",
        currentSessionPrefix: "s",
        connectionId: "c-self",
      },
    });
    shimEmit({
      type: "full_state",
      agents: Object.entries(AGENTS).map(
        ([roomId, id]) =>
          ({
            id,
            roomId,
            state: "thinking",
            turnMemberIds: [SELF],
          }) as unknown as AgentInfo,
      ),
      rooms: ["r1", "r2"].map((id) => ({
        id,
        name: `Room ${id}`,
        prompt: null,
        canCloseWhenEmpty: false,
      })),
      office: { name: "Sound test", prompt: null },
      recentCwds: [],
      killedAgents: [],
      interactions: [],
    });
  });
  setRooms(notifRooms);
}
const setRooms = (notifRooms: string[]) =>
  act(() => shimEmit({ type: "user_self_updated", user: self(notifRooms) }));
const click = async () => {
  fireEvent.click(document.body);
  await settle();
};
// The agent in `roomId` ends its turn, then starts the next one.
const turnEnd = async (roomId: keyof typeof AGENTS) => {
  const agentId = AGENTS[roomId];
  act(() =>
    shimEmit({
      type: "agent_updated",
      agentId,
      changes: { state: "waiting_for_response" },
    }),
  );
  await settle();
  const chimes = sounding().length;
  act(() =>
    shimEmit({
      type: "agent_updated",
      agentId,
      changes: { state: "thinking" },
    }),
  );
  return chimes;
};

it("clicks make no AudioContext while no room can sound; once one can, the next click primes", async () => {
  mount([]);
  await click();
  await click();
  setRooms([LOBBY_ROOM_ID]);
  await click();
  expect(contexts).toHaveLength(0);
  // A sound turned on after those clicks.
  setRooms(["r1"]);
  await click();
  expect(contexts.map((c) => c.state)).toEqual(["suspended"]);
  await click();
  expect(contexts).toHaveLength(1);
  expect(sounding()).toHaveLength(0);
});

it("a turn end chimes only while the page is hidden and its room can sound", async () => {
  mount(["r1"]);
  const visible = await turnEnd("r1");
  hidden = true;
  const seen = {
    visible,
    hiddenLobby: await turnEnd(LOBBY_ROOM_ID),
    hiddenOtherRoom: await turnEnd("r2"),
    hiddenSoundingRoom: await turnEnd("r1"),
  };
  expect(seen).toEqual({
    visible: 0,
    hiddenLobby: 0,
    hiddenOtherRoom: 0,
    hiddenSoundingRoom: 1,
  });
  lastOscillator().end();
  await settle();
  expect(contexts.map((c) => c.state)).toEqual(["suspended"]);
});
