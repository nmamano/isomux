// The composer mic on OpenAI (task 4481e64b), through LogView: the member's
// voiceInput picks the path; the browser records a clip, the clip goes to
// POST /api/voice/transcribe on stop, and the text lands on the draft. A failed
// upload keeps the clip for Retry. The browser recognizer never starts on this
// path, because it would send the audio to Google.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { VOICE_MAX_RECORDING_MS } = await import("../../shared/voice.ts");
const {
  CountingRecognition,
  FakeRecorder,
  bytesOf,
  draftOf,
  failure,
  installBrowser,
  micButton,
  ok,
  page,
  realSetTimeout,
  setUpOpenAIVoice,
  settle,
  voice,
} = await import("../test-support/openai-voice-fixture.tsx");

setUpOpenAIVoice();

// --- tests --------------------------------------------------------------------

it("shows the mic without SpeechRecognition (Firefox) only when the member picked OpenAI", () => {
  installBrowser({ speechRecognition: false });
  // Enabling condition: this browser has no recognizer at all.
  expect(window.SpeechRecognition ?? window.webkitSpeechRecognition).toBe(
    undefined,
  );
  for (const voiceInput of [undefined, "browser"] as const) {
    const view = render(page(voiceInput));
    expect({ voiceInput, mic: micButton(view.container) !== null }).toEqual({
      voiceInput,
      mic: false,
    });
    view.unmount();
  }
  const view = render(page("openai"));
  expect(micButton(view.container) !== null).toBe(true);
  view.unmount();
});

it("records on click, uploads on the second click, and puts the text on the draft", async () => {
  installBrowser({ speechRecognition: true });
  const view = render(page("openai", "first"));
  const mic = micButton(view.container)!;

  fireEvent.click(mic);
  await settle();
  expect(FakeRecorder.instances).toHaveLength(1);
  expect(FakeRecorder.instances[0].state).toBe("recording");

  let release: (r: Response) => void = () => {};
  voice.replies.push(
    () => new Promise<Response>((resolve) => (release = resolve)),
  );
  fireEvent.click(mic);
  await settle();
  // While OpenAI works, the button says so, and the browser's mic is off.
  expect(voice.uploads).toHaveLength(1);
  expect(micButton(view.container)!.getAttribute("aria-busy")).toBe("true");
  expect(voice.tracksStopped).toBeGreaterThan(0);

  const [upload] = voice.uploads;
  expect(upload.audio.name.endsWith(".webm")).toBe(true);
  expect(await bytesOf(upload.audio)).toEqual([
    ...FakeRecorder.instances[0].bytes,
  ]);
  expect(typeof upload.language).toBe("string");
  expect((upload.language as string).toLowerCase().startsWith("en")).toBe(true);
  expect(upload.keywords).toContain("Worker");

  await act(async () => release(Response.json({ text: "hello world" })));
  await settle();
  expect(draftOf(view.container)).toBe("first hello world");
  expect(micButton(view.container)!.getAttribute("aria-busy")).not.toBe("true");
  // The whole path ran without the browser recognizer.
  expect(CountingRecognition.constructed).toBe(0);
  view.unmount();
});

it("names the clip after the type the browser records (Safari: mp4)", async () => {
  installBrowser({ speechRecognition: false });
  FakeRecorder.supported = ["audio/mp4"];
  const view = render(page("openai"));
  const mic = micButton(view.container)!;
  voice.replies.push(ok("hi"));
  fireEvent.click(mic);
  await settle();
  expect(FakeRecorder.instances[0].mimeType.startsWith("audio/mp4")).toBe(true);
  fireEvent.click(mic);
  await settle();
  expect(voice.uploads[0].audio.name.endsWith(".mp4")).toBe(true);
  view.unmount();
});

it("keeps a clip whose upload failed, and Retry sends the same bytes", async () => {
  installBrowser({ speechRecognition: true });
  const view = render(page("openai", "draft"));
  const mic = micButton(view.container)!;
  voice.replies.push(failure(502, "voice_provider_failed", { status: 503 }));
  fireEvent.click(mic);
  await settle();
  fireEvent.click(mic);
  await settle();

  expect(voice.uploads).toHaveLength(1);
  const alert = view.getByRole("alert");
  expect(draftOf(view.container)).toBe("draft");

  voice.replies.push(ok("saved words"));
  const retry = alert.querySelector('[data-voice-action="retry"]');
  expect(retry).not.toBeNull();
  fireEvent.click(retry!);
  await settle();

  expect(voice.uploads).toHaveLength(2);
  expect(await bytesOf(voice.uploads[1].audio)).toEqual(
    await bytesOf(voice.uploads[0].audio),
  );
  expect(voice.uploads[1].audio.name).toBe(voice.uploads[0].audio.name);
  expect(draftOf(view.container)).toBe("draft saved words");
  expect(view.queryByRole("alert")).toBeNull();
  // One recording in all: Retry did not record again.
  expect(FakeRecorder.instances).toHaveLength(1);
  view.unmount();
});

it("Discard drops the kept clip; the next recording is a new one", async () => {
  installBrowser({ speechRecognition: true });
  const view = render(page("openai"));
  const mic = micButton(view.container)!;
  voice.replies.push(failure(502, "voice_provider_failed", { status: 500 }));
  fireEvent.click(mic);
  await settle();
  fireEvent.click(mic);
  await settle();

  const discard = view
    .getByRole("alert")
    .querySelector('[data-voice-action="discard"]');
  expect(discard).not.toBeNull();
  fireEvent.click(discard!);
  await settle();
  expect(view.queryByRole("alert")).toBeNull();
  expect(voice.uploads).toHaveLength(1);

  voice.replies.push(ok("fresh"));
  fireEvent.click(micButton(view.container)!);
  await settle();
  fireEvent.click(micButton(view.container)!);
  await settle();
  expect(FakeRecorder.instances).toHaveLength(2);
  expect(voice.uploads).toHaveLength(2);
  expect(await bytesOf(voice.uploads[1].audio)).toEqual([
    ...FakeRecorder.instances[1].bytes,
  ]);
  view.unmount();
});

// A kept clip may be minutes of dictation: a click on the mic (or a habitual
// Ctrl+Space) must not throw it away. Retry or Discard decides.
it("the mic does not record over a kept clip", async () => {
  installBrowser({ speechRecognition: false });
  const view = render(page("openai"));
  const mic = micButton(view.container)!;
  voice.replies.push(failure(502, "voice_provider_failed", { status: 503 }));
  fireEvent.click(mic);
  await settle();
  fireEvent.click(mic);
  await settle();
  // Enabling condition: the clip is kept, with Retry.
  expect(
    view.getByRole("alert").querySelector('[data-voice-action="retry"]'),
  ).not.toBeNull();

  fireEvent.click(micButton(view.container)!);
  await settle();
  fireEvent.keyDown(window, { code: "Space", key: " ", ctrlKey: true });
  await settle();
  fireEvent.keyUp(window, { code: "Space", key: " " });
  await settle();
  expect(FakeRecorder.instances).toHaveLength(1);
  expect(voice.uploads).toHaveLength(1);

  voice.replies.push(ok("kept words"));
  fireEvent.click(
    view.getByRole("alert").querySelector('[data-voice-action="retry"]')!,
  );
  await settle();
  expect(await bytesOf(voice.uploads[1].audio)).toEqual([
    ...FakeRecorder.instances[0].bytes,
  ]);
  expect(draftOf(view.container)).toBe("kept words");
  view.unmount();
});

// The Variables link opens in a new tab: leaving this page would drop the clip
// the member is about to retry.
it("with no key, keeps the clip, links to Variables in a new tab, and never falls back to the browser", async () => {
  installBrowser({ speechRecognition: true });
  const view = render(page("openai"));
  const mic = micButton(view.container)!;
  voice.replies.push(failure(409, "voice_key_missing"));
  fireEvent.click(mic);
  await settle();
  fireEvent.click(mic);
  await settle();

  const alert = view.getByRole("alert");
  const link = alert.querySelector('a[href="/integrations/variables"]');
  expect(link).not.toBeNull();
  expect(link!.getAttribute("target")).toBe("_blank");
  expect(alert.querySelector('[data-voice-action="retry"]')).not.toBeNull();
  expect(CountingRecognition.constructed).toBe(0);
  view.unmount();
});

it("a key OpenAI refused also links to Variables", async () => {
  installBrowser({ speechRecognition: false });
  const view = render(page("openai"));
  const mic = micButton(view.container)!;
  voice.replies.push(
    failure(502, "voice_provider_failed", { status: 401, keyRejected: true }),
  );
  fireEvent.click(mic);
  await settle();
  fireEvent.click(mic);
  await settle();
  const alert = view.getByRole("alert");
  expect(
    alert.querySelector('a[href="/integrations/variables"]'),
  ).not.toBeNull();
  view.unmount();
});

it("a clip OpenAI refused offers no Retry, and an outage does", async () => {
  installBrowser({ speechRecognition: false });
  for (const [reply, retry] of [
    [failure(502, "voice_provider_rejected", { status: 400 }), false],
    [failure(502, "voice_provider_failed", { status: 503 }), true],
  ] as const) {
    voice.uploads = [];
    FakeRecorder.instances = [];
    const view = render(page("openai"));
    const mic = micButton(view.container)!;
    voice.replies.push(reply);
    fireEvent.click(mic);
    await settle();
    fireEvent.click(mic);
    await settle();
    const alert = view.getByRole("alert");
    expect({
      retry,
      shown: alert.querySelector('[data-voice-action="retry"]') !== null,
    }).toEqual({ retry, shown: retry });
    view.unmount();
  }
});

it("a spoken submit at the end of the clip sends the text before it", async () => {
  installBrowser({ speechRecognition: true });
  const view = render(page("openai", "first"));
  const mic = micButton(view.container)!;
  voice.replies.push(ok("Fix the bug. Submit."));
  fireEvent.click(mic);
  await settle();
  fireEvent.click(mic);
  await settle();
  expect(voice.sent).toEqual(["first Fix the bug."]);
  view.unmount();
});

it("Ctrl+Space records while held, on Firefox too", async () => {
  installBrowser({ speechRecognition: false });
  const view = render(page("openai"));
  voice.replies.push(ok("held words"));
  fireEvent.keyDown(window, { code: "Space", key: " ", ctrlKey: true });
  await settle();
  expect(FakeRecorder.instances).toHaveLength(1);
  expect(FakeRecorder.instances[0].state).toBe("recording");
  fireEvent.keyUp(window, { code: "Space", key: " " });
  await settle();
  expect(voice.uploads).toHaveLength(1);
  expect(draftOf(view.container)).toBe("held words");
  view.unmount();
});

it("stops itself at the recording limit, says so at once, and transcribes what it has", async () => {
  installBrowser({ speechRecognition: false });
  let limitTimer: (() => void) | null = null;
  window.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms === VOICE_MAX_RECORDING_MS) {
      limitTimer = fn;
      return 0;
    }
    return realSetTimeout(fn, ms, ...rest);
  }) as typeof window.setTimeout;
  const view = render(page("openai"));
  voice.replies.push(() => new Promise<Response>(() => {}));
  fireEvent.click(micButton(view.container)!);
  await settle();
  // Enabling condition: recording armed the limit.
  expect(limitTimer).not.toBeNull();
  expect(view.queryByRole("alert")).toBeNull();

  await act(async () => limitTimer!());
  await settle();
  expect(FakeRecorder.instances[0].state).toBe("inactive");
  expect(voice.uploads).toHaveLength(1);
  // The upload has not answered, and the member already knows.
  expect(view.queryByRole("alert")).not.toBeNull();
  view.unmount();
});

it("a denied mic shows an error and records nothing", async () => {
  installBrowser({ speechRecognition: false });
  voice.micDenied = true;
  const view = render(page("openai"));
  fireEvent.click(micButton(view.container)!);
  await settle();
  expect(view.queryByRole("alert")).not.toBeNull();
  expect(FakeRecorder.instances).toHaveLength(0);
  expect(voice.uploads).toHaveLength(0);
  view.unmount();
});
