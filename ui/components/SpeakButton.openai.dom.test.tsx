// Read aloud on OpenAI (task 4481e64b), through SpeakButton: with the member's
// voiceOutput on openai, the reply goes to POST /api/voice/speak in pieces,
// the first piece plays while the next loads, Stop ends it all, and one reply
// plays at a time. Every failure shows a line that offers the browser voices,
// never silence (Nil, 2026-10-21: the speech API shuts down 2027-01-06).
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { SpeakButton } = await import("./SpeakButton.tsx");
const { onLanguage, selfUserRecord } =
  await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { createElement, Fragment } = await import("react");
const { DEFAULT_VOICE_NAME, MAX_SPEAK_CHARS } =
  await import("../../shared/voice.ts");

type VoiceOutput = import("../../shared/voice.ts").VoiceOutput;
type VoiceName = import("../../shared/voice.ts").VoiceName;

// --- browser stand-ins ------------------------------------------------------

interface SpeakCall {
  text: string;
  voice: unknown;
  signal: AbortSignal | null | undefined;
  release(res: Response): void;
}

let speakCalls: SpeakCall[] = [];
let patches: unknown[] = [];
let plays: Array<{ el: HTMLMediaElement; src: string }> = [];
let pauses: HTMLMediaElement[] = [];
let created: string[] = [];
let revoked: string[] = [];
let browserSpoke = 0;
// When set, play() refuses a piece (not the silent unlock clip), as iOS does
// when the tap did not unlock the element.
let refusePieces = false;

const realFetch = globalThis.fetch;
const proto = window.HTMLMediaElement.prototype;
// Descriptors, so the originals go back exactly as they were.
// An absent own property is deleted again, not defined.
const saved = (
  [
    [proto, "play"],
    [proto, "pause"],
    [URL, "createObjectURL"],
    [URL, "revokeObjectURL"],
  ] as const
).map(([target, name]) => ({
  target,
  name,
  descriptor: Object.getOwnPropertyDescriptor(target, name),
}));

function fakeFetch(input: unknown, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.includes("/api/voice/speak"))
    return Promise.resolve(Response.json({}));
  const body = JSON.parse(init?.body as string) as {
    text: string;
    voice?: unknown;
  };
  return new Promise<Response>((resolve, reject) => {
    const call: SpeakCall = {
      text: body.text,
      voice: body.voice,
      signal: init?.signal,
      release: resolve,
    };
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("aborted", "AbortError")),
    );
    speakCalls.push(call);
  });
}

const mp3 = () =>
  new Response(new Uint8Array([0x49, 0x44, 0x33, 1]), {
    headers: { "Content-Type": "audio/mpeg" },
  });
const failure = (status: number, code: string, extra = {}) =>
  Response.json({ error: { code, message: "x", ...extra } }, { status });

function install(opts: { speechSynthesis: boolean }) {
  globalThis.fetch = fakeFetch as typeof fetch;
  window.fetch = fakeFetch as typeof fetch;
  proto.play = function (this: HTMLMediaElement) {
    plays.push({ el: this, src: this.src });
    if (refusePieces && this.src.startsWith("blob:")) {
      return Promise.reject(new DOMException("not allowed", "NotAllowedError"));
    }
    return Promise.resolve();
  };
  proto.pause = function (this: HTMLMediaElement) {
    pauses.push(this);
  };
  let n = 0;
  URL.createObjectURL = () => {
    const url = `blob:speech-${++n}`;
    created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
    configurable: true,
    writable: true,
    value: class {
      lang = "";
      voice = null;
      onend = null;
      onerror = null;
      constructor(public text: string) {}
    },
  });
  if (opts.speechSynthesis) {
    Object.defineProperty(globalThis, "speechSynthesis", {
      configurable: true,
      writable: true,
      value: {
        getVoices: () => [],
        speak() {
          browserSpoke++;
        },
        cancel() {},
        addEventListener() {},
        removeEventListener() {},
      },
    });
  } else {
    delete (globalThis as unknown as Record<string, unknown>).speechSynthesis;
  }
}

beforeEach(() => {
  speakCalls = [];
  patches = [];
  plays = [];
  pauses = [];
  created = [];
  revoked = [];
  browserSpoke = 0;
  refusePieces = false;
  setApiShim(async (method, path, body) => {
    if (method === "PATCH" && path === "/api/me/preferences")
      patches.push(body);
    return undefined;
  });
});

afterAll(() => {
  setApiShim(null);
  globalThis.fetch = realFetch;
  for (const { target, name, descriptor } of saved) {
    if (descriptor) Object.defineProperty(target, name, descriptor);
    else delete (target as unknown as Record<string, unknown>)[name];
  }
  delete (globalThis as unknown as Record<string, unknown>).speechSynthesis;
  delete (globalThis as unknown as Record<string, unknown>)
    .SpeechSynthesisUtterance;
});

function page(
  texts: string[],
  voiceOutput: VoiceOutput | undefined,
  voiceName?: VoiceName,
) {
  const self = { ...selfUserRecord(null), voiceOutput, voiceName };
  return onLanguage(
    null,
    createElement(
      Fragment,
      null,
      ...texts.map((text, i) =>
        createElement(
          "div",
          { key: i, "data-reply": String(i) },
          createElement(SpeakButton, { getText: () => text }),
        ),
      ),
    ),
    { users: new Map([[self.name.toLowerCase(), self]]) },
  );
}

function buttonOf(container: HTMLElement, reply = 0): HTMLButtonElement {
  const button = container.querySelector(`[data-reply="${reply}"] button`);
  if (!(button instanceof HTMLButtonElement)) throw new Error("no button");
  return button;
}

// The stop icon is the square; the speak icon has none.
const isStopShown = (button: HTMLButtonElement) =>
  button.querySelector("rect") !== null;

async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const lastPlayed = () => plays.at(-1)!;
async function endChunk() {
  await act(async () => {
    lastPlayed().el.dispatchEvent(new Event("ended"));
  });
  await settle();
}

const longReply = "This sentence is part of a long reply. ".repeat(300).trim();

// --- tests --------------------------------------------------------------------

it("shows read aloud without speechSynthesis only when the member picked OpenAI", () => {
  install({ speechSynthesis: false });
  expect(
    typeof (globalThis as { speechSynthesis?: unknown }).speechSynthesis,
  ).toBe("undefined");
  for (const voiceOutput of [undefined, "browser"] as const) {
    const view = render(page(["Hi."], voiceOutput));
    expect({
      voiceOutput,
      button: view.container.querySelector("button") !== null,
    }).toEqual({ voiceOutput, button: false });
    view.unmount();
  }
  const view = render(page(["Hi."], "openai"));
  expect(view.container.querySelector("button") !== null).toBe(true);
  view.unmount();
});

it("starts the audio element inside the click, before any answer (iOS)", () => {
  install({ speechSynthesis: true });
  const view = render(page(["Hello there."], "openai"));
  fireEvent.click(buttonOf(view.container));
  // No await: the click handler itself played the silent unlock clip, before
  // any piece came back.
  expect(plays[0]?.src.startsWith("data:audio/wav")).toBe(true);
  expect(created).toHaveLength(0);
  view.unmount();
});

it("reads a long reply in pieces: the first plays while the next loads, then the next plays", async () => {
  install({ speechSynthesis: true });
  const view = render(page([longReply], "openai", "cedar"));
  const button = buttonOf(view.container);
  fireEvent.click(button);
  await settle();
  expect(speakCalls).toHaveLength(1);
  expect(isStopShown(button)).toBe(true);

  await act(async () => speakCalls[0].release(mp3()));
  await settle();
  // Chunk 1 is playing and chunk 2 is already on its way.
  expect(lastPlayed().src).toBe(created[0]);
  expect(speakCalls).toHaveLength(2);

  // Play to the end. Pieces are filled up to the limit. Piece i is on its way
  // at the latest when piece i-1 starts playing.
  const pieces = Math.ceil(longReply.length / MAX_SPEAK_CHARS);
  expect(pieces).toBeGreaterThan(2);
  for (let i = 1; i < pieces; i++) {
    expect(speakCalls.length).toBeGreaterThan(i);
    await act(async () => speakCalls[i].release(mp3()));
    await settle();
    await endChunk();
    expect(lastPlayed().src).toBe(created[i]);
  }
  await endChunk();
  expect(speakCalls).toHaveLength(pieces);

  expect(speakCalls.map((c) => c.voice)).toEqual(speakCalls.map(() => "cedar"));
  // Each request carries its own piece, in order.
  expect(speakCalls.map((c) => c.text).join(" ")).toBe(longReply);
  expect(isStopShown(button)).toBe(false);
  expect(new Set(revoked)).toEqual(new Set(created));
  // The browser voices never spoke: the reply went to OpenAI only.
  expect(browserSpoke).toBe(0);
  view.unmount();
});

it("uses the default voice when the member chose none", async () => {
  install({ speechSynthesis: true });
  const view = render(page(["Hi."], "openai"));
  fireEvent.click(buttonOf(view.container));
  await settle();
  expect(speakCalls[0].voice).toBe(DEFAULT_VOICE_NAME);
  view.unmount();
});

it("Stop pauses, aborts the piece that is loading, and plays nothing more", async () => {
  install({ speechSynthesis: true });
  const view = render(page([longReply], "openai"));
  const button = buttonOf(view.container);
  fireEvent.click(button);
  await settle();
  await act(async () => speakCalls[0].release(mp3()));
  await settle();
  expect(speakCalls).toHaveLength(2);
  const playing = lastPlayed().el;

  fireEvent.click(button);
  await settle();
  expect(pauses).toContain(playing);
  expect(speakCalls[1].signal?.aborted).toBe(true);
  expect(isStopShown(button)).toBe(false);

  // Stop frees every piece it had loaded.
  expect(new Set(revoked)).toEqual(new Set(created));
  const playsAtStop = plays.length;
  await act(async () => playing.dispatchEvent(new Event("ended")));
  await settle();
  expect(plays.length).toBe(playsAtStop);
  expect(speakCalls).toHaveLength(2);
  view.unmount();
});

it("one reply plays at a time: starting another stops the first", async () => {
  install({ speechSynthesis: true });
  const view = render(page(["First reply.", "Second reply."], "openai"));
  const first = buttonOf(view.container, 0);
  const second = buttonOf(view.container, 1);
  fireEvent.click(first);
  await settle();
  await act(async () => speakCalls[0].release(mp3()));
  await settle();
  const firstEl = lastPlayed().el;

  fireEvent.click(second);
  await settle();
  expect(pauses).toContain(firstEl);
  expect(isStopShown(first)).toBe(false);
  expect(isStopShown(second)).toBe(true);
  expect(speakCalls.at(-1)!.text).toBe("Second reply.");
  view.unmount();
});

it("leaving the page stops playback", async () => {
  install({ speechSynthesis: true });
  const view = render(page(["Hello."], "openai"));
  fireEvent.click(buttonOf(view.container));
  await settle();
  await act(async () => speakCalls[0].release(mp3()));
  await settle();
  const el = lastPlayed().el;
  view.unmount();
  await settle();
  expect(pauses).toContain(el);
});

it("with no key: an error line with Variables in a new tab and a switch to browser voices", async () => {
  install({ speechSynthesis: false });
  const view = render(page(["Hello."], "openai"));
  fireEvent.click(buttonOf(view.container));
  await settle();
  await act(async () =>
    speakCalls[0].release(failure(409, "voice_key_missing")),
  );
  await settle();

  const alert = view.getByRole("alert");
  const link = alert.querySelector('a[href="/integrations/variables"]');
  expect(link).not.toBeNull();
  expect(link!.getAttribute("target")).toBe("_blank");
  const useBrowser = alert.querySelector('[data-voice-action="use-browser"]');
  expect(useBrowser).not.toBeNull();
  fireEvent.click(useBrowser!);
  await settle();
  expect(patches).toEqual([{ voiceOutput: "browser" }]);
  view.unmount();
});

// What every member on OpenAI sees once the speech API is gone.
it("a refused request offers browser voices and no Variables link", async () => {
  install({ speechSynthesis: true });
  const view = render(page(["Hello."], "openai"));
  fireEvent.click(buttonOf(view.container));
  await settle();
  await act(async () =>
    speakCalls[0].release(
      failure(502, "voice_provider_rejected", { status: 404 }),
    ),
  );
  await settle();
  const alert = view.getByRole("alert");
  expect(
    alert.querySelector('[data-voice-action="use-browser"]'),
  ).not.toBeNull();
  expect(alert.querySelector('a[href="/integrations/variables"]')).toBeNull();
  expect(isStopShown(buttonOf(view.container))).toBe(false);
  view.unmount();
});

it("a piece that fails mid-reply stops playback and shows the error", async () => {
  install({ speechSynthesis: true });
  const view = render(page([longReply], "openai"));
  fireEvent.click(buttonOf(view.container));
  await settle();
  await act(async () => speakCalls[0].release(mp3()));
  await settle();
  await act(async () =>
    speakCalls[1].release(
      failure(502, "voice_provider_failed", { status: 503 }),
    ),
  );
  await settle();
  expect(isStopShown(buttonOf(view.container))).toBe(false);
  // The first piece ending plays nothing more.
  const playsAtFailure = plays.length;
  await endChunk();
  expect(plays.length).toBe(playsAtFailure);
  expect(created).toHaveLength(1);
  expect(view.queryByRole("alert")).not.toBeNull();
  expect(
    view.getByRole("alert").querySelector('[data-voice-action="use-browser"]'),
  ).not.toBeNull();
  expect(speakCalls).toHaveLength(2);
  view.unmount();
});

// "Never silence" covers the audio element too: a piece the browser will not
// play, or cannot decode, ends the reading with the error line.
it("a piece the browser refuses to play ends the reading with the error line", async () => {
  install({ speechSynthesis: true });
  refusePieces = true;
  const view = render(page(["Hello."], "openai"));
  const button = buttonOf(view.container);
  fireEvent.click(button);
  await settle();
  await act(async () => speakCalls[0].release(mp3()));
  await settle();
  // Enabling condition: the piece reached play().
  expect(plays.some((p) => p.src === created[0])).toBe(true);
  expect(view.queryByRole("alert")).not.toBeNull();
  expect(
    view.getByRole("alert").querySelector('[data-voice-action="use-browser"]'),
  ).not.toBeNull();
  expect(isStopShown(button)).toBe(false);
  view.unmount();
});

it("a piece the element cannot decode ends the reading with the error line", async () => {
  install({ speechSynthesis: true });
  const view = render(page(["Hello."], "openai"));
  const button = buttonOf(view.container);
  fireEvent.click(button);
  await settle();
  await act(async () => speakCalls[0].release(mp3()));
  await settle();
  expect(lastPlayed().src).toBe(created[0]);
  await act(async () => {
    lastPlayed().el.dispatchEvent(new Event("error"));
  });
  await settle();
  expect(view.queryByRole("alert")).not.toBeNull();
  expect(isStopShown(button)).toBe(false);
  view.unmount();
});
