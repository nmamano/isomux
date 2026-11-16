// Voice input on an ask card's reply field (task 33f33910): the composer's
// mic (useComposerVoice) on ReplyAskCard, so the Inbox, the chat's ask stack
// and the pinned ask all have it. Dictation from an untouched field replaces
// the default; a spoken "submit" answers the ask; no dictated write lands on
// a card that holds or sends its answer; on the OpenAI path the card does not
// answer while a clip records or transcribes; Ctrl+Space stays the chat
// composer's; and one mic runs at a time on the page (card and card, card and
// composer).
import { afterAll, afterEach, beforeEach, expect, it, jest } from "bun:test";
import { setUpDomTestFile, stubGlobal } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement, useReducer } = await import("react");
const { ASK_UNDO_MS } = await import("../components/AsksView.tsx");
const { LogView } = await import("./LogView.tsx");
const { StateCtx, DispatchCtx, reducer } = await import("../store.tsx");
const { LanguageProvider } = await import("../i18n.tsx");
const { setApiShim } = await import("../api.ts");
const { ask, mount } = await import("../test-support/asks-view.ts");
const { stateWithSelfUser, selfUserRecord } =
  await import("../test-support/language-fixture.tsx");
const { FakeRecorder, installBrowser, voice, realSetTimeout } =
  await import("../test-support/openai-voice-fixture.tsx");

type AppState = import("../store.tsx").AppState;
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type AskEntry = import("../../shared/types.ts").AskEntry;
type VoiceInput = import("../../shared/voice.ts").VoiceInput;
type View = ReturnType<typeof render>;

// --- the browser recognizer ---------------------------------------------------

type ResultHandler = ((event: SpeechRecognitionEvent) => void) | null;

// As a browser: stop() ends with onend after the pending result; abort()
// drops it. Both end here at once.
class Recognition {
  static instances: Recognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ResultHandler = null;
  onend: (() => void) | null = null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null = null;
  startCalls = 0;
  stopCalls = 0;
  abortCalls = 0;
  constructor() {
    Recognition.instances.push(this);
  }
  start() {
    this.startCalls++;
  }
  stop() {
    this.stopCalls++;
    this.onend?.();
  }
  abort() {
    this.abortCalls++;
    this.onend?.();
  }
  result(transcript: string, isFinal = true) {
    const result = Object.assign([{ transcript }], { isFinal });
    act(() =>
      this.onresult?.({
        resultIndex: 0,
        results: [result],
      } as unknown as SpeechRecognitionEvent),
    );
  }
}

function installRecognition(value: unknown) {
  stubGlobal("SpeechRecognition", value);
  stubGlobal("webkitSpeechRecognition", undefined);
  stubGlobal("isSecureContext", true);
}

// --- the office -----------------------------------------------------------------

let posts: { path: string; body: unknown }[] = [];
beforeEach(() => {
  posts = [];
  Recognition.instances = [];
  voice.uploads = [];
  voice.replies = [];
  voice.tracksStopped = 0;
  FakeRecorder.instances = [];
  FakeRecorder.supported = ["audio/webm"];
  setApiShim(async (method, path, body) => {
    if (method === "GET" && path === "/api/voice")
      return { keySource: "member_variable", keyName: "OPENAI_VOICE_API_KEY" };
    if (method === "POST") posts.push({ path, body });
    return {};
  });
});
afterEach(() => jest.useRealTimers());
afterAll(() => setApiShim(null));

// The signed-in member, who picked `voiceInput` in Integrations > Voice.
function self(voiceInput: VoiceInput = "browser"): Partial<AppState> {
  const record = { ...selfUserRecord(null), voiceInput };
  const state = stateWithSelfUser(null);
  return {
    users: new Map([[record.name.toLowerCase(), record]]),
    sessionContext: state.sessionContext,
  };
}

// The Inbox over the real reducer, its answers held for Undo.
function inbox(asks: AskEntry[], voiceInput?: VoiceInput) {
  return mount(asks, self(voiceInput)).view;
}

const card = (view: View, id: string) =>
  view.container.querySelector<HTMLElement>(`[data-ask="${id}"]`);
// The card's mic, by its icon (MicIcon), as the composer's.
const micOf = (root: Element | null) => {
  const button = root?.querySelector('svg rect[x="9"]')?.closest("button");
  return button instanceof HTMLButtonElement ? button : null;
};
const fieldOf = (view: View, id: string) =>
  card(view, id)!.querySelector<HTMLTextAreaElement>("[data-ask-reply-input]")!;
const replyOf = (view: View, id: string) =>
  card(view, id)!.querySelector<HTMLButtonElement>('button[type="submit"]')!;

// Moves the fake clock, then lets the shim's promise and its dispatch land.
async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await act(async () => {});
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => realSetTimeout(r, 0));
    });
  }
}

// --- tests ----------------------------------------------------------------------

it("shows a mic on each card when this browser has one, and none when it has not", () => {
  installRecognition(Recognition);
  const shown = inbox([ask("q1", "a1", 5), ask("q2", "a2", 3)]);
  expect(micOf(card(shown, "q1")) !== null).toBe(true);
  expect(micOf(card(shown, "q2")) !== null).toBe(true);
  // The mic is the field's: it sits in the reply form.
  expect(micOf(card(shown, "q1"))!.closest("form") !== null).toBe(true);
  shown.unmount();

  installRecognition(undefined);
  expect(window.SpeechRecognition ?? window.webkitSpeechRecognition).toBe(
    undefined,
  );
  const hidden = inbox([ask("q1", "a1", 5)]);
  // The card itself is drawn: the mic alone is missing.
  expect(fieldOf(hidden, "q1") !== null).toBe(true);
  expect(micOf(card(hidden, "q1"))).toBeNull();
  hidden.unmount();
});

it("dictates over an untouched default, and after a typed draft", () => {
  installRecognition(Recognition);
  const view = inbox([
    ask("plain", "a1", 5),
    { ...ask("one", "a1", 4), options: ["Ship it"] },
    ask("typed", "a2", 3),
  ]);
  // Enabling condition: each field starts with a default.
  expect(fieldOf(view, "plain").value.trim() !== "").toBe(true);
  expect(fieldOf(view, "one").value).toBe("Ship it");

  fireEvent.click(micOf(card(view, "plain"))!);
  Recognition.instances.at(-1)!.result("hello there");
  expect(fieldOf(view, "plain").value).toBe("hello there");

  fireEvent.click(micOf(card(view, "one"))!);
  Recognition.instances.at(-1)!.result("not yet");
  expect(fieldOf(view, "one").value).toBe("not yet");

  fireEvent.change(fieldOf(view, "typed"), { target: { value: "my note" } });
  fireEvent.click(micOf(card(view, "typed"))!);
  Recognition.instances.at(-1)!.result("and more");
  expect(fieldOf(view, "typed").value).toBe("my note and more");
  view.unmount();
});

it("keeps what the member types while the mic listens", () => {
  installRecognition(Recognition);
  const view = inbox([ask("q1", "a1", 5)]);
  fireEvent.click(micOf(card(view, "q1"))!);
  const recognition = Recognition.instances.at(-1)!;
  recognition.result("first");
  expect(fieldOf(view, "q1").value).toBe("first");
  fireEvent.change(fieldOf(view, "q1"), {
    target: { value: "first typed" },
  });
  recognition.result("second");
  expect(fieldOf(view, "q1").value).toBe("first typed second");
  view.unmount();
});

it("answers on a spoken submit, and Undo brings back the text it sent", async () => {
  installRecognition(Recognition);
  jest.useFakeTimers();
  const view = inbox([ask("q1", "a1", 5)]);
  fireEvent.click(micOf(card(view, "q1"))!);
  const first = Recognition.instances.at(-1)!;
  first.result("ship on Monday");
  first.result("submit");
  // Held for Undo: the card turned into its Undo line, and the recognizer
  // was dropped.
  expect(card(view, "q1")?.getAttribute("data-ask-pending")).toBe("reply");
  expect(card(view, "q1")!.querySelector("form")).toBeNull();
  expect(first.abortCalls).toBe(1);
  const undo =
    view.container.querySelector<HTMLButtonElement>("[data-ask-undo]");
  expect(undo !== null).toBe(true);
  await act(async () => fireEvent.click(undo!));
  expect(fieldOf(view, "q1").value).toBe("ship on Monday");
  expect(posts.length).toBe(0);

  // Again, to the end of the Undo time: the reply goes to the ask.
  fireEvent.click(micOf(card(view, "q1"))!);
  const second = Recognition.instances.at(-1)!;
  second.result("submit");
  await advance(ASK_UNDO_MS);
  expect(posts.map((p) => p.path)).toEqual(["/api/asks/q1/reply"]);
  expect((posts[0].body as { text: string }).text).toBe("ship on Monday");
  view.unmount();
});

it("drops the mic when the member answers with a click", async () => {
  installRecognition(Recognition);
  jest.useFakeTimers();
  const view = inbox([ask("q1", "a1", 5), ask("q2", "a2", 3)]);
  fireEvent.click(micOf(card(view, "q1"))!);
  const recognition = Recognition.instances.at(-1)!;
  recognition.result("go ahead");
  await act(async () => fireEvent.click(replyOf(view, "q1")));
  expect(recognition.abortCalls).toBe(1);
  await advance(ASK_UNDO_MS);
  expect(posts.map((p) => p.path)).toEqual(["/api/asks/q1/reply"]);
  expect((posts[0].body as { text: string }).text).toBe("go ahead");

  fireEvent.click(micOf(card(view, "q2"))!);
  const other = Recognition.instances.at(-1)!;
  const dismiss = card(view, "q2")!.querySelector<HTMLButtonElement>(
    "[data-ask-dismiss]",
  )!;
  await act(async () => fireEvent.click(dismiss));
  expect(other.abortCalls).toBe(1);
  view.unmount();
});

it("leaves Ctrl+Space to the chat composer", () => {
  installRecognition(Recognition);
  const view = inbox([ask("q1", "a1", 5)]);
  // Enabling conditions: a secure page with a mic on the card.
  expect(window.isSecureContext).toBe(true);
  expect(micOf(card(view, "q1")) !== null).toBe(true);
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "Space", ctrlKey: true }),
    );
  });
  expect(Recognition.instances.length).toBe(0);
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space" }));
  });
  // The click starts it.
  fireEvent.click(micOf(card(view, "q1"))!);
  expect(Recognition.instances.length).toBe(1);
  expect(Recognition.instances[0].startCalls).toBe(1);
  view.unmount();
});

it("runs one card's mic at a time, and the stopped card keeps its words", () => {
  installRecognition(Recognition);
  const view = inbox([ask("q1", "a1", 5), ask("q2", "a2", 3)]);
  fireEvent.click(micOf(card(view, "q1"))!);
  const first = Recognition.instances.at(-1)!;
  first.result("alpha");
  expect(micOf(card(view, "q1"))!.getAttribute("aria-pressed")).toBe("true");

  fireEvent.click(micOf(card(view, "q2"))!);
  const second = Recognition.instances.at(-1)!;
  expect(Recognition.instances.length).toBe(2);
  expect(second.startCalls).toBe(1);
  // Stopped, not dropped: its words stay on its own field.
  expect(first.stopCalls).toBe(1);
  expect(first.abortCalls).toBe(0);
  expect(micOf(card(view, "q1"))!.getAttribute("aria-pressed")).toBe("false");
  expect(micOf(card(view, "q2"))!.getAttribute("aria-pressed")).toBe("true");
  expect(fieldOf(view, "q1").value).toBe("alpha");
  second.result("beta");
  expect(fieldOf(view, "q2").value).toBe("beta");
  expect(fieldOf(view, "q1").value).toBe("alpha");
  view.unmount();
});

// --- the chat: the ask stack above the composer ---------------------------------

const agent = {
  id: "a1",
  name: "Worker",
  desk: 0,
  roomId: "r1",
  cwd: "/tmp",
  state: "idle",
  agentType: "claude",
  modelFamily: "opus",
  topic: null,
  queue: [],
  pendingPrompt: null,
  contextUsage: null,
  capabilities: {},
  outfit: {
    color: "#4A90D9",
    hair: "#222",
    hairStyle: "short",
    skin: "#FFD5B8",
    beard: "none",
    accessory: "none",
    hat: "none",
  },
} as unknown as AgentInfo;

function chat(asks: AskEntry[]) {
  const initial = stateWithSelfUser(null, {
    ...self(),
    agents: [agent],
    asks,
    rooms: [{ id: "r1", name: "Room", prompt: null, canCloseWhenEmpty: false }],
    connected: true,
    hasReceivedInitialState: true,
    drafts: new Map([[agent.id, ""]]),
  });
  function Live() {
    const [state, dispatch] = useReducer(reducer, initial);
    return createElement(
      StateCtx.Provider,
      { value: state },
      createElement(
        DispatchCtx.Provider,
        { value: dispatch },
        createElement(
          LanguageProvider,
          null,
          createElement(LogView, {
            agent,
            logs: [],
            onBack() {},
            onEditAgent() {},
          }),
        ),
      ),
    );
  }
  return render(createElement(Live));
}

// The composer's mic: the one outside every ask card.
function composerMic(view: View) {
  for (const rect of view.container.querySelectorAll('svg rect[x="9"]')) {
    const button = rect.closest("button");
    if (button && !button.closest("[data-ask]")) return button;
  }
  return null;
}

it("stops the composer's mic when a card's mic starts, and the card's when the composer's starts", () => {
  installRecognition(Recognition);
  const view = chat([ask("q1", "a1", 5)]);
  // Enabling condition: both mics are on the page.
  expect(composerMic(view) !== null).toBe(true);
  expect(micOf(card(view, "q1")) !== null).toBe(true);

  fireEvent.click(composerMic(view)!);
  const composer = Recognition.instances.at(-1)!;
  fireEvent.click(micOf(card(view, "q1"))!);
  const onCard = Recognition.instances.at(-1)!;
  expect(Recognition.instances.length).toBe(2);
  expect(composer.stopCalls).toBe(1);
  expect(onCard.startCalls).toBe(1);

  // Ctrl+Space holds the composer's mic: the card's stops.
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "Space", ctrlKey: true }),
    );
  });
  expect(Recognition.instances.length).toBe(3);
  expect(onCard.stopCalls).toBe(1);
  expect(micOf(card(view, "q1"))!.getAttribute("aria-pressed")).toBe("false");
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space" }));
  });
  view.unmount();
});

// --- the OpenAI path --------------------------------------------------------------

it("does not answer while an OpenAI clip records or transcribes, then sends the words", async () => {
  installBrowser({ speechRecognition: false });
  const view = inbox(
    [{ ...ask("q1", "a1", 5), options: ["Yes", "No"] }],
    "openai",
  );
  const answerButtons = () => [
    replyOf(view, "q1"),
    card(view, "q1")!.querySelector<HTMLButtonElement>("[data-ask-dismiss]")!,
    card(view, "q1")!.querySelector<HTMLButtonElement>("[data-ask-file-task]")!,
    ...card(view, "q1")!.querySelectorAll<HTMLButtonElement>(
      "[data-ask-option]",
    ),
  ];
  fireEvent.change(fieldOf(view, "q1"), { target: { value: "Yes" } });
  // Enabling condition: before the mic, each answer button works, and the
  // option the field holds sends.
  expect(answerButtons().map((b) => b.disabled)).toEqual([
    false,
    false,
    false,
    false,
    false,
  ]);
  expect(
    card(view, "q1")!.querySelector("[data-ask-option-sends]") !== null,
  ).toBe(true);

  fireEvent.click(micOf(card(view, "q1"))!);
  await settle();
  expect(FakeRecorder.instances.length).toBe(1);
  expect(FakeRecorder.instances[0].state).toBe("recording");
  expect(answerButtons().map((b) => b.disabled)).toEqual([
    true,
    true,
    true,
    true,
    true,
  ]);
  // Enter's path: the form's submit answers nothing. On the Inbox an answer
  // is held first, so the card itself says whether it answered.
  const held = () => card(view, "q1")!.hasAttribute("data-ask-pending");
  await act(async () =>
    fireEvent.submit(card(view, "q1")!.querySelector("form")!),
  );
  expect(held()).toBe(false);
  expect(posts.length).toBe(0);

  let release: (r: Response) => void = () => {};
  voice.replies.push(
    () => new Promise<Response>((resolve) => (release = resolve)),
  );
  fireEvent.click(micOf(card(view, "q1"))!);
  await settle();
  expect(voice.uploads.length).toBe(1);
  expect(micOf(card(view, "q1"))!.getAttribute("aria-busy")).toBe("true");
  expect(answerButtons().every((b) => b.disabled)).toBe(true);
  await act(async () =>
    fireEvent.submit(card(view, "q1")!.querySelector("form")!),
  );
  expect(held()).toBe(false);
  expect(posts.length).toBe(0);

  await act(async () => release(Response.json({ text: "on Friday" })));
  await settle();
  expect(fieldOf(view, "q1").value).toBe("Yes on Friday");
  expect(replyOf(view, "q1").disabled).toBe(false);
  jest.useFakeTimers();
  await act(async () => fireEvent.click(replyOf(view, "q1")));
  await advance(ASK_UNDO_MS);
  expect(posts.map((p) => p.path)).toEqual(["/api/asks/q1/reply"]);
  expect((posts[0].body as { text: string }).text).toBe("Yes on Friday");
  view.unmount();
});

it("answers on a spoken submit at the end of an OpenAI clip", async () => {
  installBrowser({ speechRecognition: false });
  const view = inbox([ask("q1", "a1", 5)], "openai");
  fireEvent.click(micOf(card(view, "q1"))!);
  await settle();
  expect(FakeRecorder.instances[0].state).toBe("recording");
  voice.replies.push(() =>
    Promise.resolve(Response.json({ text: "ship it on Monday submit" })),
  );
  fireEvent.click(micOf(card(view, "q1"))!);
  await settle();
  expect(voice.uploads.length).toBe(1);
  // Held for Undo with the spoken words, the command left out.
  expect(card(view, "q1")?.getAttribute("data-ask-pending")).toBe("reply");
  expect(posts.length).toBe(0);
  // Leaving the Inbox sends the held answer at once.
  await act(async () => view.unmount());
  expect(posts.map((p) => p.path)).toEqual(["/api/asks/q1/reply"]);
  expect((posts[0].body as { text: string }).text).toBe("ship it on Monday");
});

it("runs one OpenAI recording at a time: a second card's mic ends the first's, which is transcribed", async () => {
  installBrowser({ speechRecognition: false });
  const view = inbox([ask("q1", "a1", 5), ask("q2", "a2", 3)], "openai");
  fireEvent.click(micOf(card(view, "q1"))!);
  await settle();
  expect(FakeRecorder.instances.length).toBe(1);
  expect(FakeRecorder.instances[0].state).toBe("recording");
  voice.replies.push(() => Promise.resolve(Response.json({ text: "alpha" })));
  fireEvent.click(micOf(card(view, "q2"))!);
  await settle();
  expect(FakeRecorder.instances.length).toBe(2);
  expect(FakeRecorder.instances[1].state).toBe("recording");
  expect(FakeRecorder.instances[0].state).toBe("inactive");
  // Stopped, not dropped: the first clip's words land on its own card.
  expect(voice.uploads.length).toBe(1);
  expect(fieldOf(view, "q1").value).toBe("alpha");
  expect(micOf(card(view, "q2"))!.getAttribute("aria-pressed")).toBe("true");
  view.unmount();
});
