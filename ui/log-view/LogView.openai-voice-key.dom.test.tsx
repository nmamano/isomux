// The OpenAI mic's key check at the press (task 69a9b325), through LogView:
// each press asks GET /api/voice in parallel with the mic, so a member with no
// usable key learns it before talking, and a status line shows while the mic
// records and while OpenAI transcribes. Split from
// LogView.openai-voice.dom.test.tsx to keep each file under the DOM time cap.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const {
  FakeRecorder,
  draftOf,
  installBrowser,
  micButton,
  ok,
  page,
  heldStatus,
  setUpOpenAIVoice,
  status,
  settle,
  voice,
} = await import("../test-support/openai-voice-fixture.tsx");
const { asMember } = await import("../test-support/language-fixture.tsx");

setUpOpenAIVoice();

// --- the key check at press (task 69a9b325) ------------------------------------

function variablesLink(alert: HTMLElement): Element | null {
  return alert.querySelector('a[href="/integrations/variables"]');
}

function keptClipActions(container: HTMLElement): number {
  return container.querySelectorAll("[data-voice-action]").length;
}

// Nil, 2026-11-01: the error came only after he finished talking. Both orders:
// the answer comes before the mic opens, or while the recorder already runs.
it("with no key, says so at the press, records nothing and keeps no clip", async () => {
  installBrowser({ speechRecognition: false });
  for (const order of ["answer first", "recording first"] as const) {
    voice.tracksStopped = 0;
    voice.uploads = [];
    FakeRecorder.instances = [];
    const view = render(page("openai"));
    const answer = heldStatus({ keySource: null, keyName: null });
    voice.statusReplies.push(answer.reply);
    voice.holdMic = order === "answer first";
    fireEvent.click(micButton(view.container)!);
    await settle();
    // Enabling condition: in this order the recorder runs before the answer.
    if (order === "recording first") {
      expect(FakeRecorder.instances.map((r) => r.state)).toEqual(["recording"]);
    }
    answer.release();
    await settle();
    if (order === "answer first") {
      // The member already sees why, while the mic grant is still pending.
      expect(variablesLink(view.getByRole("alert"))).not.toBeNull();
      voice.releaseMic();
      await settle();
    }

    const alert = view.getByRole("alert");
    expect({ order, link: variablesLink(alert) !== null }).toEqual({
      order,
      link: true,
    });
    expect(keptClipActions(view.container)).toBe(0);
    expect(FakeRecorder.instances.every((r) => r.state === "inactive")).toBe(
      true,
    );
    expect(voice.tracksStopped).toBeGreaterThan(0);
    expect(voice.uploads).toHaveLength(0);
    view.unmount();
  }
});

it("asks again at each press: once the key is added, the next press records", async () => {
  installBrowser({ speechRecognition: false });
  const view = render(page("openai"));
  voice.statusReplies.push(status({ keySource: null, keyName: null }));
  fireEvent.click(micButton(view.container)!);
  await settle();
  expect(variablesLink(view.getByRole("alert"))).not.toBeNull();

  // The member adds the key in Variables (a new tab) and presses again.
  fireEvent.click(micButton(view.container)!);
  await settle();
  expect(voice.statusRequests).toBe(2);
  expect(FakeRecorder.instances.at(-1)!.state).toBe("recording");
  expect(view.queryByRole("alert")).toBeNull();

  voice.replies.push(ok("now it works"));
  fireEvent.click(micButton(view.container)!);
  await settle();
  expect(voice.uploads).toHaveLength(1);
  expect(draftOf(view.container)).toBe("now it works");
  view.unmount();
});

// A secret's value stays with the secret proxy, so the voice routes cannot
// send it. The member already added the key: the line names the variable and
// links to Variables, and is not the "add the key" line.
it("a key saved as a secret is reported at the press with its name", async () => {
  installBrowser({ speechRecognition: false });
  for (const keySource of ["member_secret", "office_secret"] as const) {
    voice.uploads = [];
    FakeRecorder.instances = [];
    const view = render(page("openai"));
    voice.statusReplies.push(status({ keySource, keyName: "OPENAI_API_KEY" }));
    fireEvent.click(micButton(view.container)!);
    await settle();
    const alert = view.getByRole("alert");
    expect({
      keySource,
      named: alert.textContent.includes("OPENAI_API_KEY"),
      link: variablesLink(alert) !== null,
      recording: FakeRecorder.instances.some((r) => r.state === "recording"),
    }).toEqual({ keySource, named: true, link: true, recording: false });
    expect(keptClipActions(view.container)).toBe(0);
    view.unmount();
  }
});

it("a usable key from the office or the server records as before", async () => {
  installBrowser({ speechRecognition: false });
  for (const keySource of ["office_variable", "server"] as const) {
    voice.uploads = [];
    FakeRecorder.instances = [];
    const view = render(page("openai"));
    voice.statusReplies.push(
      status({ keySource, keyName: "OPENAI_VOICE_API_KEY" }),
    );
    voice.replies.push(ok(`from ${keySource}`));
    fireEvent.click(micButton(view.container)!);
    await settle();
    expect({ keySource, state: FakeRecorder.instances[0]?.state }).toEqual({
      keySource,
      state: "recording",
    });
    fireEvent.click(micButton(view.container)!);
    await settle();
    expect(draftOf(view.container)).toBe(`from ${keySource}`);
    view.unmount();
  }
});

// A check that fails must not cost the member the recording: the upload
// reports the key as it did before the check existed.
it("records as before when the key check fails or errors", async () => {
  installBrowser({ speechRecognition: false });
  const broken = [
    ["server error", () => Promise.resolve(new Response("x", { status: 500 }))],
    ["network error", () => Promise.reject(new TypeError("offline"))],
    // A sign-in page of a proxy in front of the office answers 200 with HTML.
    ["page, not JSON", () => Promise.resolve(new Response("<html></html>"))],
  ] as const;
  for (const [label, reply] of broken) {
    voice.uploads = [];
    FakeRecorder.instances = [];
    const view = render(page("openai"));
    voice.statusReplies.push(reply);
    voice.replies.push(ok(`after ${label}`));
    fireEvent.click(micButton(view.container)!);
    await settle();
    expect({ label, state: FakeRecorder.instances[0]?.state }).toEqual({
      label,
      state: "recording",
    });
    expect(view.queryByRole("alert")).toBeNull();
    fireEvent.click(micButton(view.container)!);
    await settle();
    expect({ label, draft: draftOf(view.container) }).toEqual({
      label,
      draft: `after ${label}`,
    });
    view.unmount();
  }
});

// An answer that comes after its press is over belongs to no recording: one
// that arrives after the member stopped, and one that arrives while a later
// press records.
it("ignores a late answer: after stop, and during the next press's recording", async () => {
  installBrowser({ speechRecognition: false });
  const view = render(page("openai"));
  const record = async (text: string) => {
    voice.replies.push(ok(text));
    fireEvent.click(micButton(view.container)!);
    await settle();
    fireEvent.click(micButton(view.container)!);
    await settle();
  };
  const stale = heldStatus({ keySource: null, keyName: null });
  const afterStop = heldStatus({ keySource: null, keyName: null });
  voice.statusReplies.push(stale.reply, afterStop.reply);
  await record("one");
  await record("two");
  expect(draftOf(view.container)).toBe("one two");

  // Press 2 is over, and no press came after it.
  afterStop.release();
  await settle();
  expect(view.queryByRole("alert")).toBeNull();

  // Press 3 gets its own (usable) answer and records.
  fireEvent.click(micButton(view.container)!);
  await settle();
  expect(voice.statusRequests).toBe(3);
  expect(FakeRecorder.instances.map((r) => r.state)).toEqual([
    "inactive",
    "inactive",
    "recording",
  ]);

  stale.release();
  await settle();
  expect(FakeRecorder.instances[2].state).toBe("recording");
  expect(view.queryByRole("alert")).toBeNull();

  voice.replies.push(ok("three"));
  fireEvent.click(micButton(view.container)!);
  await settle();
  expect(voice.uploads).toHaveLength(3);
  expect(draftOf(view.container)).toBe("one two three");
  view.unmount();
});

// A mic grant cannot help without the key, so the key is what the member reads.
it("with no key and a denied mic, the line is about the key, in either order", async () => {
  installBrowser({ speechRecognition: false });
  for (const order of ["denied first", "answer first"] as const) {
    voice.micDenied = true;
    voice.holdMic = order === "answer first";
    const answer = heldStatus({ keySource: null, keyName: null });
    voice.statusReplies.push(answer.reply);
    const view = render(page("openai"));
    fireEvent.click(micButton(view.container)!);
    await settle();
    if (order === "denied first") {
      // Enabling condition: the denial showed before the answer.
      expect(view.queryByRole("alert")).not.toBeNull();
      answer.release();
    } else {
      answer.release();
      await settle();
      voice.releaseMic();
    }
    await settle();
    expect({
      order,
      link: variablesLink(view.getByRole("alert")) !== null,
    }).toEqual({ order, link: true });
    view.unmount();
  }
});

// Nil, 2026-11-01: "nothing happens when I try to start talking". The OpenAI
// path writes no live words, so a status line says the mic records, then that
// OpenAI transcribes.
it("a status line shows while recording and while transcribing", async () => {
  installBrowser({ speechRecognition: false });
  const view = render(page("openai"));
  const idle = view.queryAllByRole("status").length;
  fireEvent.click(micButton(view.container)!);
  await settle();
  const whileRecording = view.queryAllByRole("status");
  expect(whileRecording).toHaveLength(idle + 1);
  const recordingText = whileRecording.at(-1)!.textContent.trim();
  expect(recordingText.length).toBeGreaterThan(0);

  let release: (r: Response) => void = () => {};
  voice.replies.push(
    () => new Promise<Response>((resolve) => (release = resolve)),
  );
  fireEvent.click(micButton(view.container)!);
  await settle();
  const whileTranscribing = view.queryAllByRole("status");
  expect(whileTranscribing).toHaveLength(idle + 1);
  const transcribingText = whileTranscribing.at(-1)!.textContent.trim();
  expect(transcribingText.length).toBeGreaterThan(0);
  expect(transcribingText).not.toBe(recordingText);

  await act(async () => release(Response.json({ text: "done" })));
  await settle();
  expect(view.queryAllByRole("status")).toHaveLength(idle);
  expect(draftOf(view.container)).toBe("done");
  view.unmount();
});

// Nil at sign-off of task a1d3fa5f (task 93191798): the mic's key line links
// to Variables only for a member who can read it, and sends a member who
// cannot add the key (no environment write) to an owner. The other key lines
// follow the same link (VoiceSection.dom.test.tsx shows one keeps its text).
it("the key line links to Variables with environment read, and names an owner without environment write", async () => {
  installBrowser({ speechRecognition: false });
  const lineFor = async (environment?: "read" | "write" | "none") => {
    FakeRecorder.instances = [];
    const view = render(page("openai", "", asMember(environment)));
    voice.statusReplies.push(status({ keySource: null, keyName: null }));
    fireEvent.click(micButton(view.container)!);
    await settle();
    const alert = view.getByRole("alert");
    const bare = alert.cloneNode(true) as HTMLElement;
    for (const a of bare.querySelectorAll("a")) a.remove();
    const row = {
      environment: environment ?? "no pack",
      text: bare.textContent.trim(),
      link: variablesLink(alert) !== null,
    };
    view.unmount();
    return row;
  };

  const full = await lineFor();
  const writer = await lineFor("write");
  const reader = await lineFor("read");
  const without = await lineFor("none");
  expect(full.link).toBe(true);
  expect(writer).toEqual({ ...full, environment: "write" });
  expect(reader.link).toBe(true);
  expect(reader.text).not.toBe(full.text);
  expect(reader.text).toContain("OPENAI_VOICE_API_KEY");
  expect(without).toEqual({ ...reader, environment: "none", link: false });
});
