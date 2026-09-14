import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { LogView } = await import("./LogView.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { createElement } = await import("react");

type AgentInfo = import("../../shared/types.ts").AgentInfo;

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

type ResultHandler = ((event: SpeechRecognitionEvent) => void) | null;

class WorkingRecognition {
  static instances: WorkingRecognition[] = [];
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
    WorkingRecognition.instances.push(this);
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
    this.onresult?.({
      resultIndex: 0,
      results: [result],
    } as unknown as SpeechRecognitionEvent);
  }
}

function installRecognition(value: unknown) {
  Object.defineProperty(window, "SpeechRecognition", {
    configurable: true,
    writable: true,
    value,
  });
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
}

function page(draft = "") {
  return onLanguage(
    "en",
    createElement(LogView, {
      agent,
      logs: [],
      onBack() {},
      onEditAgent() {},
    }),
    {
      agents: [agent],
      rooms: [
        { id: "r1", name: "Room", prompt: null, canCloseWhenEmpty: false },
      ],
      connected: true,
      hasReceivedInitialState: true,
      drafts: new Map([[agent.id, draft]]),
    },
  );
}

function micButton(container: HTMLElement): HTMLButtonElement {
  const micBody = container.querySelector('svg rect[x="9"]');
  const button = micBody?.closest("button");
  if (!(button instanceof HTMLButtonElement)) throw new Error("mic absent");
  return button;
}

afterAll(() => {
  setApiShim(null);
  delete (globalThis as unknown as Record<string, unknown>).SpeechRecognition;
});

it("can start on the second click after the first recognition start throws", () => {
  let throwingStarts = 0;
  class ThrowingRecognition extends WorkingRecognition {
    override start() {
      throwingStarts++;
      throw new Error("start failed");
    }
  }

  installRecognition(ThrowingRecognition);
  const view = render(page());
  fireEvent.click(micButton(view.container));
  expect(throwingStarts).toBe(1);
  expect(view.queryByRole("alert") !== null).toBe(true);

  WorkingRecognition.instances = [];
  installRecognition(WorkingRecognition);
  view.rerender(page());
  fireEvent.click(micButton(view.container));
  expect(WorkingRecognition.instances.at(-1)?.startCalls).toBe(1);
  view.unmount();
});

it("submits only finalized stand-alone commands and keeps dictation open", () => {
  const sent: string[] = [];
  setApiShim(async (method, path, body) => {
    if (method === "POST" && path.endsWith("/messages")) {
      sent.push((body as { text: string }).text);
    }
    return {};
  });
  WorkingRecognition.instances = [];
  installRecognition(WorkingRecognition);
  const view = render(page("first"));
  fireEvent.click(micButton(view.container));
  const recognition = WorkingRecognition.instances.at(-1)!;

  act(() => recognition.result("submit", false));
  expect(sent).toEqual([]);
  act(() => recognition.result("submit the form", false));
  expect(sent).toEqual([]);
  act(() => recognition.result("submit", true));
  expect(sent).toEqual(["first"]);

  act(() => recognition.result("second", true));
  act(() => recognition.result("submit", true));
  expect(sent).toEqual(["first", "second"]);
  expect(recognition.startCalls).toBe(1);
  expect(recognition.stopCalls).toBe(0);
  expect(recognition.abortCalls).toBe(0);
  view.unmount();
});

it("keeps listening when submit arrives on an empty draft", () => {
  const sent: string[] = [];
  setApiShim(async (method, path, body) => {
    if (method === "POST" && path.endsWith("/messages")) {
      sent.push((body as { text: string }).text);
    }
    return {};
  });
  WorkingRecognition.instances = [];
  installRecognition(WorkingRecognition);
  const view = render(page("   "));
  fireEvent.click(micButton(view.container));
  const recognition = WorkingRecognition.instances.at(-1)!;

  act(() => recognition.result("submit", true));
  expect(sent).toEqual([]);
  act(() => recognition.result("after", true));
  act(() => recognition.result("submit", true));
  expect(sent).toEqual(["after"]);
  expect(recognition.startCalls).toBe(1);
  expect(recognition.stopCalls).toBe(0);
  expect(recognition.abortCalls).toBe(0);
  view.unmount();
});
