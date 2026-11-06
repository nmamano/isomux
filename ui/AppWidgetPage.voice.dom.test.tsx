// Voice input in the widget's chat (task 4e18b327): WidgetChat, the chat of
// the app page and of the Inbox's chat panel, gets the full chat's mic. The
// voice engine is the one LogView uses; its own rules (dictation sessions, the
// recorder, error lines) are tested through LogView. These tests hold what the
// widget adds: where the mic shows, where its words go, and how a send meets a
// dictation that goes on while the message is in flight.
import { expect, it } from "bun:test";
import { setUpDomTestFile, stubGlobal } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement, useState } = await import("react");
const { WidgetChat } = await import("./AppWidgetPage.tsx");
const { StateCtx, initialState } = await import("./store.tsx");
const { LanguageProvider } = await import("./i18n.tsx");
const { setApiShim } = await import("./api.ts");
const { selfUserRecord, stateWithSelfUser } =
  await import("./test-support/language-fixture.tsx");
const {
  FakeRecorder,
  draftOf,
  installBrowser,
  micButton,
  ok,
  setUpOpenAIVoice,
  settle,
  usableKey,
  voice,
} = await import("./test-support/openai-voice-fixture.tsx");

type AgentInfo = import("../shared/types.ts").AgentInfo;
type VoiceInput = import("../shared/voice.ts").VoiceInput;

// Resets the recorder and upload stand-ins before each test.
setUpOpenAIVoice();

const agent = {
  id: "one",
  name: "One",
  state: "idle",
  outfit: { color: "#218cff", hair: "#3e3025", skin: "#FFD5B8" },
  queue: [],
} as unknown as AgentInfo;
const boot = { name: "hello", registration: 1 };

// --- browser recognizer -------------------------------------------------------

class Recognition {
  static instances: Recognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((event: SpeechRecognitionEvent) => void) | null = null;
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
  }
  abort() {
    this.abortCalls++;
  }
  result(transcript: string, isFinal: boolean) {
    const result = Object.assign([{ transcript }], { isFinal });
    act(() =>
      this.onresult?.({
        resultIndex: 0,
        results: [result],
      } as unknown as SpeechRecognitionEvent),
    );
  }
}

function browserRecognizer() {
  installBrowser({ speechRecognition: false });
  Recognition.instances = [];
  stubGlobal("SpeechRecognition", Recognition);
}

function lastRecognition(): Recognition {
  const recognition = Recognition.instances.at(-1);
  if (!recognition) throw new Error("no recognizer started");
  return recognition;
}

// --- the message route ----------------------------------------------------------

// Each POST /messages takes the next queued reply; none queued answers at once.
const posts: { text: string; clientMessageId: string }[] = [];
const postReplies: Array<() => Promise<unknown>> = [];

function held() {
  let finish: (fail: boolean) => void = () => {};
  const reply = () =>
    new Promise<unknown>((resolve, reject) => {
      finish = (fail) => (fail ? reject(new Error("offline")) : resolve({}));
    });
  return {
    reply,
    resolve: () => act(async () => finish(false)),
    reject: () => act(async () => finish(true)),
  };
}

function routes() {
  posts.length = 0;
  postReplies.length = 0;
  setApiShim(async (method, path, body) => {
    if (method === "GET" && path === "/api/voice") return usableKey;
    if (method === "POST" && path.endsWith("/messages")) {
      posts.push(body as (typeof posts)[number]);
      const reply = postReplies.shift();
      return reply ? reply() : {};
    }
    return {};
  });
}

// --- the two surfaces -----------------------------------------------------------

// The store state: the member's own record with their voice input, or no
// record yet (before the socket hydrates it).
function state(voiceInput: VoiceInput | null) {
  if (voiceInput === null) return { ...initialState, agents: [agent] };
  const self = { ...selfUserRecord(null), voiceInput };
  return stateWithSelfUser(null, {
    agents: [agent],
    users: new Map([[self.name.toLowerCase(), self]]),
  });
}

function wrap(
  voiceInput: VoiceInput | null,
  element: import("react").ReactElement,
) {
  return createElement(
    StateCtx.Provider,
    { value: state(voiceInput) },
    createElement(LanguageProvider, null, element),
  );
}

// The app page: the widget keeps its own draft.
function appPage(
  voiceInput: VoiceInput | null,
  over: { open?: boolean; connected?: boolean } = {},
) {
  return wrap(
    voiceInput,
    createElement(WidgetChat, {
      boot,
      agent,
      logs: [],
      connected: over.connected ?? true,
      open: over.open ?? true,
      onRecheck() {},
    }),
  );
}

// The Inbox's chat panel: the draft is the agent's office draft, held outside.
const officeDraft: string[] = [];
function InboxPanel() {
  const [text, setText] = useState("");
  return createElement(WidgetChat, {
    agent,
    logs: [],
    connected: true,
    open: true,
    textDraft: {
      text,
      onChange(value: string) {
        officeDraft.push(value);
        setText(value);
      },
    },
  });
}
function inboxPanel(voiceInput: VoiceInput) {
  return wrap(voiceInput, createElement(InboxPanel));
}

function mic(container: HTMLElement): HTMLButtonElement {
  const button = micButton(container);
  if (!button) throw new Error("mic absent");
  return button;
}

function sendButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
}

// --- tests --------------------------------------------------------------------

it("shows the mic only with a recognizer, a secure context and the member's own record", () => {
  sessionStorage.clear();
  browserRecognizer();
  let view = render(appPage("browser"));
  expect(micButton(view.container) !== null).toBe(true);
  view.unmount();

  // Before the member's record arrives the choice is unknown: a browser mic
  // then could send the audio of a member who picked OpenAI to the vendor.
  view = render(appPage(null));
  expect(view.getByRole("textbox") !== null).toBe(true);
  expect(micButton(view.container)).toBe(null);
  view.unmount();

  stubGlobal("isSecureContext", false);
  view = render(appPage("browser"));
  expect(micButton(view.container)).toBe(null);
  view.unmount();

  installBrowser({ speechRecognition: false });
  expect(window.SpeechRecognition ?? window.webkitSpeechRecognition).toBe(
    undefined,
  );
  view = render(appPage("browser"));
  expect(micButton(view.container)).toBe(null);
  view.unmount();
  // The recorder path needs no recognizer.
  view = render(appPage("openai"));
  expect(micButton(view.container) !== null).toBe(true);
  view.unmount();
});

it("in the Inbox panel, dictation writes the agent's office draft and keeps a typed edit", () => {
  browserRecognizer();
  officeDraft.length = 0;
  const view = render(inboxPanel("browser"));
  expect(mic(view.container).getAttribute("aria-pressed")).not.toBe("true");
  fireEvent.click(mic(view.container));
  const recognition = lastRecognition();
  expect(recognition.startCalls).toBe(1);
  expect(recognition.continuous).toBe(true);
  expect(mic(view.container).getAttribute("aria-pressed")).toBe("true");

  recognition.result("hello", false);
  expect(draftOf(view.container)).toBe("hello");
  recognition.result("hello", true);
  expect(officeDraft.at(-1)).toBe("hello");

  // A keystroke while listening joins the session: the next result adds to
  // it instead of writing the dictated text over it.
  fireEvent.change(view.getByRole("textbox"), {
    target: { value: "hello there" },
  });
  recognition.result("again", true);
  expect(draftOf(view.container)).toBe("hello there again");
  expect(officeDraft.at(-1)).toBe("hello there again");

  fireEvent.click(mic(view.container));
  expect(recognition.stopCalls).toBe(1);
  act(() => recognition.onend?.());
  expect(mic(view.container).getAttribute("aria-pressed")).not.toBe("true");
  view.unmount();
});

it("a spoken submit sends the dictated text, keeps listening, and the reply keeps what was said meanwhile", async () => {
  sessionStorage.clear();
  browserRecognizer();
  routes();
  const post = held();
  postReplies.push(post.reply);
  const view = render(appPage("browser"));
  fireEvent.click(mic(view.container));
  const recognition = lastRecognition();

  recognition.result("first", true);
  // The recognizer shows the command as an interim word before it is final:
  // the send takes the dictated text, not what the composer shows.
  recognition.result("submit", false);
  expect(draftOf(view.container)).toBe("first submit");
  recognition.result("submit", true);
  await settle();
  expect(posts.map((p) => p.text)).toEqual(["first"]);

  // The member goes on talking while the message is in flight.
  recognition.result("second", true);
  expect(draftOf(view.container)).toBe("second");
  await post.resolve();
  await settle();
  expect(draftOf(view.container)).toBe("second");

  recognition.result("submit", true);
  await settle();
  expect(posts.map((p) => p.text)).toEqual(["first", "second"]);
  expect(recognition.startCalls).toBe(1);
  expect(recognition.stopCalls).toBe(0);
  expect(recognition.abortCalls).toBe(0);
  view.unmount();
});

it("a failed spoken submit gives the text back, and a retry reuses its id", async () => {
  sessionStorage.clear();
  browserRecognizer();
  routes();
  const post = held();
  postReplies.push(post.reply);
  const view = render(appPage("browser"));
  fireEvent.click(mic(view.container));
  const recognition = lastRecognition();

  recognition.result("first", true);
  recognition.result("submit", true);
  await settle();
  expect(posts).toHaveLength(1);
  await post.reject();
  await settle();
  expect(draftOf(view.container)).toBe("first");

  fireEvent.click(sendButton(view.container));
  await settle();
  expect(posts.map((p) => p.text)).toEqual(["first", "first"]);
  expect(posts[1].clientMessageId).toBe(posts[0].clientMessageId);
  view.unmount();
});

it("a failed spoken submit puts the text back before what was said meanwhile, and dictation goes on after both", async () => {
  sessionStorage.clear();
  browserRecognizer();
  routes();
  const post = held();
  postReplies.push(post.reply);
  const view = render(appPage("browser"));
  fireEvent.click(mic(view.container));
  const recognition = lastRecognition();

  recognition.result("first", true);
  recognition.result("submit", true);
  await settle();
  recognition.result("later", true);
  await post.reject();
  await settle();
  expect(draftOf(view.container)).toBe("first later");
  recognition.result("again", true);
  expect(draftOf(view.container)).toBe("first later again");

  fireEvent.click(sendButton(view.container));
  await settle();
  expect(posts.map((p) => p.text)).toEqual(["first", "first later again"]);
  // New text, so a new id: the server must not take it for the first try.
  expect(posts[1].clientMessageId).not.toBe(posts[0].clientMessageId);
  view.unmount();
});

it("a click on Send drops the recognizer's pending words", async () => {
  sessionStorage.clear();
  browserRecognizer();
  routes();
  const view = render(appPage("browser"));
  fireEvent.click(mic(view.container));
  const recognition = lastRecognition();
  recognition.result("hello", true);
  fireEvent.click(sendButton(view.container));
  await settle();
  expect(posts.map((p) => p.text)).toEqual(["hello"]);
  expect(recognition.abortCalls).toBe(1);
  // A result the recognizer still delivers does not refill the composer.
  recognition.result("hello", true);
  expect(draftOf(view.container)).toBe("");
  view.unmount();
});

it("Ctrl+Space dictates only while the panel is open; closing it stops the mic and keeps its words", async () => {
  sessionStorage.clear();
  browserRecognizer();
  const view = render(appPage("browser", { open: false }));
  fireEvent.keyDown(window, { code: "Space", key: " ", ctrlKey: true });
  expect(Recognition.instances).toHaveLength(0);

  view.rerender(appPage("browser", { open: true }));
  fireEvent.keyDown(window, { code: "Space", key: " ", ctrlKey: true });
  const recognition = lastRecognition();
  expect(recognition.startCalls).toBe(1);
  recognition.result("kept", false);

  view.rerender(appPage("browser", { open: false }));
  expect(recognition.stopCalls).toBe(1);
  expect(recognition.abortCalls).toBe(0);
  recognition.result("kept words", true);
  act(() => recognition.onend?.());
  expect(draftOf(view.container)).toBe("kept words");

  fireEvent.keyDown(window, { code: "Space", key: " ", ctrlKey: true });
  expect(Recognition.instances).toHaveLength(1);
  view.unmount();
});

it("on OpenAI, the transcript fills the office draft in the Inbox panel", async () => {
  installBrowser({ speechRecognition: false });
  routes();
  officeDraft.length = 0;
  const view = render(inboxPanel("openai"));
  voice.replies.push(ok("hello world"));
  fireEvent.click(mic(view.container));
  await settle();
  expect(FakeRecorder.instances).toHaveLength(1);
  expect(mic(view.container).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(mic(view.container));
  await settle();
  expect(voice.uploads).toHaveLength(1);
  expect(voice.uploads[0].keywords).toContain("One");
  expect(draftOf(view.container)).toBe("hello world");
  expect(officeDraft.at(-1)).toBe("hello world");
  view.unmount();
});

it("on OpenAI, a transcript that lands while a message is in flight stays after it", async () => {
  sessionStorage.clear();
  installBrowser({ speechRecognition: false });
  routes();
  const view = render(appPage("openai"));
  fireEvent.change(view.getByRole("textbox"), { target: { value: "first" } });
  fireEvent.click(mic(view.container));
  await settle();
  let release: (r: Response) => void = () => {};
  voice.replies.push(
    () => new Promise<Response>((resolve) => (release = resolve)),
  );
  fireEvent.click(mic(view.container));
  await settle();
  expect(mic(view.container).getAttribute("aria-busy")).toBe("true");

  const post = held();
  postReplies.push(post.reply);
  fireEvent.click(sendButton(view.container));
  await settle();
  expect(posts.map((p) => p.text)).toEqual(["first"]);
  await act(async () => release(Response.json({ text: "spoken" })));
  await settle();
  await post.resolve();
  await settle();
  // The sent words leave the composer; the transcript stays, alone.
  expect(draftOf(view.container)).toBe("spoken");
  view.unmount();
});

it("on OpenAI, a spoken submit that cannot be sent leaves its text on the draft", async () => {
  sessionStorage.clear();
  installBrowser({ speechRecognition: false });
  routes();
  const view = render(appPage("openai", { connected: false }));
  voice.replies.push(ok("Fix the bug. Submit."));
  fireEvent.click(mic(view.container));
  await settle();
  fireEvent.click(mic(view.container));
  await settle();
  expect(voice.uploads).toHaveLength(1);
  expect(posts).toHaveLength(0);
  expect(draftOf(view.container)).toBe("Fix the bug.");
  view.unmount();
});
