// The OpenAI mic through LogView, for DOM tests (tasks 4481e64b, 69a9b325):
// a fake MediaRecorder and getUserMedia, GET /api/voice and
// POST /api/voice/transcribe answered from queues, and a live store so the
// draft the mic writes reaches the textarea. It imports ui/store.tsx, which
// touches the window at module scope, so a test loads it with
// `await import(...)` after setUpDomTestFile(), never statically.

import { afterAll, afterEach, beforeEach } from "bun:test";
import { act } from "@testing-library/react";
import { createElement, useReducer } from "react";
import { LogView } from "../log-view/LogView.tsx";
import { selfUserRecord, stateWithSelfUser } from "./language-fixture.tsx";
import { StateCtx, DispatchCtx, reducer } from "../store.tsx";
import { LanguageProvider } from "../i18n.tsx";
import { setApiShim } from "../api.ts";

type AgentInfo = import("../../shared/types.ts").AgentInfo;
type VoiceInput = import("../../shared/voice.ts").VoiceInput;

const agent = {
  id: "voice-agent",
  name: "Worker",
  desk: 0,
  roomId: "r1",
  cwd: "/tmp",
  state: "idle",
  agentType: "claude",
  modelFamily: "opus",
  topic: null,
  userId: "u1",
  username: "Tester",
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

// --- browser stand-ins ------------------------------------------------------

export class CountingRecognition {
  static constructed = 0;
  continuous = false;
  interimResults = false;
  lang = "";
  onresult = null;
  onend = null;
  onerror = null;
  constructor() {
    CountingRecognition.constructed++;
  }
  start() {}
  stop() {}
  abort() {}
}

const stream = {
  getTracks: () => [
    {
      stop() {
        voice.tracksStopped++;
      },
    },
  ],
  getAudioTracks() {
    return this.getTracks();
  },
};

export class FakeRecorder extends EventTarget {
  static supported: string[] = ["audio/webm"];
  static instances: FakeRecorder[] = [];
  static isTypeSupported(type: string): boolean {
    return FakeRecorder.supported.some((s) => type.startsWith(s));
  }
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((e: Event) => void) | null = null;
  onstop: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  // Each recording has its own bytes, so a test can tell clips apart.
  bytes: Uint8Array<ArrayBuffer>;
  constructor(_stream: unknown, opts?: { mimeType?: string }) {
    super();
    this.mimeType = opts?.mimeType ?? "";
    FakeRecorder.instances.push(this);
    this.bytes = new Uint8Array([FakeRecorder.instances.length, 7, 7, 7]);
  }
  start() {
    this.state = "recording";
  }
  requestData() {
    this.emitData();
  }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    queueMicrotask(() => {
      this.emitData();
      this.dispatchEvent(new Event("stop"));
    });
  }
  private emitData() {
    const event = new Event("dataavailable");
    Object.defineProperty(event, "data", {
      value: new Blob([this.bytes], { type: this.mimeType || "audio/webm" }),
    });
    // dispatchEvent alone: happy-dom, like a browser, also runs the on<type>
    // property during it.
    this.dispatchEvent(event);
  }
}

interface Upload {
  url: string;
  audio: File;
  language: FormDataEntryValue | null;
  keywords: FormDataEntryValue[];
}

// What a test reads and sets. setUpOpenAIVoice resets it before each test.
export const voice = {
  tracksStopped: 0,
  micDenied: false,
  // When set, getUserMedia waits until the test calls voice.releaseMic().
  holdMic: false,
  releaseMic: (() => {}) as () => void,
  uploads: [] as Upload[],
  replies: [] as Array<() => Promise<Response>>,
  sent: [] as string[],
  // GET /api/voice answers, one per press; a usable member variable when none
  // is queued.
  statusReplies: [] as Array<() => Promise<Response>>,
  statusRequests: 0,
};

export const usableKey = {
  keySource: "member_variable",
  keyName: "OPENAI_VOICE_API_KEY",
};
export const status = (body: object) => () =>
  Promise.resolve(Response.json(body));
export function heldStatus(body: object) {
  let release: () => void = () => {};
  const reply = () =>
    new Promise<Response>((resolve) => {
      release = () => resolve(Response.json(body));
    });
  return { reply, release: () => release() };
}

function nextStatus(): Promise<Response> {
  voice.statusRequests++;
  const reply = voice.statusReplies.shift();
  return reply ? reply() : Promise.resolve(Response.json(usableKey));
}

export const ok = (text: string) => () =>
  Promise.resolve(Response.json({ text }));
export const failure =
  (status: number, code: string, extra = {}) =>
  () =>
    Promise.resolve(
      Response.json({ error: { code, message: "x", ...extra } }, { status }),
    );

async function fakeFetch(input: unknown, init?: RequestInit) {
  const url = String(input instanceof Request ? input.url : input);
  if (/\/api\/voice(\?|$)/.test(url)) return nextStatus();
  if (!url.includes("/api/voice/transcribe")) {
    return Response.json({});
  }
  const form = init?.body as FormData;
  voice.uploads.push({
    url,
    audio: form.get("audio") as File,
    language: form.get("language"),
    keywords: form.getAll("keywords"),
  });
  const reply = voice.replies.shift();
  if (!reply) throw new Error("no reply queued for the upload");
  return reply();
}

const realFetch = globalThis.fetch;
export const realSetTimeout = window.setTimeout;

export function installBrowser(opts: { speechRecognition: boolean }) {
  const set = (name: string, value: unknown) =>
    Object.defineProperty(window, name, {
      configurable: true,
      writable: true,
      value,
    });
  set(
    "SpeechRecognition",
    opts.speechRecognition ? CountingRecognition : undefined,
  );
  set("webkitSpeechRecognition", undefined);
  set("MediaRecorder", FakeRecorder);
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: () => {
        const answer = () =>
          voice.micDenied
            ? Promise.reject(
                Object.assign(new Error("denied"), {
                  name: "NotAllowedError",
                }),
              )
            : Promise.resolve(stream);
        if (!voice.holdMic) return answer();
        return new Promise((resolve, reject) => {
          voice.releaseMic = () => {
            answer().then(resolve, reject);
          };
        });
      },
    },
  });
  globalThis.fetch = fakeFetch as typeof fetch;
  window.fetch = fakeFetch as typeof fetch;
}

// Resets the stand-ins before each test and gives the browser back after the
// file. Call it once, in the test file's body.
export function setUpOpenAIVoice(): void {
  beforeEach(() => {
    voice.uploads = [];
    voice.replies = [];
    voice.sent = [];
    voice.tracksStopped = 0;
    voice.micDenied = false;
    voice.holdMic = false;
    voice.releaseMic = () => {};
    voice.statusReplies = [];
    voice.statusRequests = 0;
    FakeRecorder.instances = [];
    FakeRecorder.supported = ["audio/webm"];
    CountingRecognition.constructed = 0;
    setApiShim(async (method, path, body) => {
      // As apiFetch on the network: a non-2xx throws, and a body that is not
      // JSON reads as undefined.
      if (method === "GET" && path === "/api/voice") {
        const res = await nextStatus();
        if (!res.ok) throw new Error(`status ${res.status}`);
        const text = await res.text();
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return undefined;
        }
      }
      if (method === "POST" && path.endsWith("/messages")) {
        voice.sent.push((body as { text: string }).text);
      }
      return {};
    });
  });

  afterEach(() => {
    window.setTimeout = realSetTimeout;
  });

  afterAll(() => {
    setApiShim(null);
    globalThis.fetch = realFetch;
    for (const name of ["SpeechRecognition", "MediaRecorder"]) {
      delete (globalThis as unknown as Record<string, unknown>)[name];
    }
  });
}

// A live store (the real reducer), so the draft the mic writes reaches the
// textarea as it does in the app.
function LiveStore({
  initial,
  children,
}: {
  initial: import("../store.tsx").AppState;
  children?: import("react").ReactNode;
}) {
  const [state, dispatch] = useReducer(reducer, initial);
  return createElement(
    StateCtx.Provider,
    { value: state },
    createElement(
      DispatchCtx.Provider,
      { value: dispatch },
      createElement(LanguageProvider, null, children),
    ),
  );
}

export function page(voiceInput: VoiceInput | undefined, draft = "") {
  const self = { ...selfUserRecord(null), voiceInput };
  const initial = stateWithSelfUser(null, {
    agents: [agent],
    users: new Map([[self.name.toLowerCase(), self]]),
    rooms: [{ id: "r1", name: "Room", prompt: null, canCloseWhenEmpty: false }],
    connected: true,
    hasReceivedInitialState: true,
    drafts: new Map([[agent.id, draft]]),
  });
  return createElement(
    LiveStore,
    { initial },
    createElement(LogView, {
      agent,
      logs: [],
      onBack() {},
      onEditAgent() {},
    }),
  );
}

export function micButton(container: HTMLElement): HTMLButtonElement | null {
  const button = container.querySelector('svg rect[x="9"]')?.closest("button");
  return button instanceof HTMLButtonElement ? button : null;
}

export function draftOf(container: HTMLElement): string {
  return container.querySelector("textarea")!.value;
}

export async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => realSetTimeout(r, 0));
    });
  }
}

export async function bytesOf(file: File): Promise<number[]> {
  return [...new Uint8Array(await file.arrayBuffer())];
}
