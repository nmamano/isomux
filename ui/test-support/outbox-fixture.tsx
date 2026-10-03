// Shared page for the composer outbox DOM tests (task 51de8814). Import it
// after setUpDomTestFile() and call setupOutboxTests() in each file: bun
// caches this module, so hooks registered at import would serve the first
// file only. The API shim records every POST /messages and answers it with
// `outboxFixture.answer`.
import { afterAll, beforeEach } from "bun:test";
const { act, render, fireEvent } = await import("@testing-library/react");
const { LogView } = await import("../log-view/LogView.tsx");
const { StateCtx, StoreProvider, useAppState } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { _resetOutboxForTests } = await import("../log-view/outbox.ts");
type AgentInfo = import("../../shared/types.ts").AgentInfo;

const agent = {
  id: "a1",
  name: "Tester",
  desk: 0,
  roomId: "r1",
  cwd: "~",
  state: "waiting_for_response",
  agentType: "claude",
  modelFamily: "opus",
  topic: null,
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

export interface Post {
  text: string;
  clientMessageId: string;
  attachments?: unknown[];
}

// Each POST /messages is recorded and answered by `answer`.
export const outboxFixture: {
  posts: Post[];
  answer: (post: Post) => Promise<unknown>;
} = { posts: [], answer: async () => ({}) };
export function setupOutboxTests() {
  setShim(() => {});
  afterAll(() => {
    connect(
      () => {},
      () => {},
    );
    setShim(null);
    setApiShim(null);
  });
  beforeEach(() => {
    _resetOutboxForTests();
    outboxFixture.posts = [];
    outboxFixture.answer = async () => ({});
    setApiShim(async (method, path, body) => {
      if (method === "POST" && path.endsWith("/messages")) {
        const post = body as Post;
        outboxFixture.posts.push(post);
        return outboxFixture.answer(post);
      }
      return { counts: {} };
    });
  });
}

// Real store drafts and dispatch; `connected` is pinned.
function Page({ connected = true }: { connected?: boolean }) {
  const state = useAppState();
  return (
    <StateCtx.Provider
      value={{
        ...state,
        connected,
        slashCommands: new Map([
          [
            agent.id,
            { commands: [{ name: "clear", autoRun: true }], skills: [] },
          ],
        ]),
      }}
    >
      <LogView
        agent={agent}
        logs={[]}
        onBack={() => {}}
        onEditAgent={() => {}}
      />
    </StateCtx.Provider>
  );
}

export function mount(connected = true) {
  return render(
    <StoreProvider>
      <Page connected={connected} />
    </StoreProvider>,
  );
}

export function composer(container: HTMLElement): HTMLTextAreaElement {
  const all = container.querySelectorAll("textarea");
  return all[all.length - 1];
}

export function rows(container: HTMLElement, status?: "pending" | "failed") {
  return [
    ...container.querySelectorAll<HTMLElement>(
      status ? `[data-outbox-attempt="${status}"]` : "[data-outbox-attempt]",
    ),
  ];
}

export function rowButton(row: HTMLElement, label: string): HTMLButtonElement {
  const button = [...row.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  );
  if (!button) throw new Error(`no ${label} button`);
  return button;
}

export async function type(container: HTMLElement, text: string) {
  fireEvent.change(composer(container), { target: { value: text } });
}

export async function send(container: HTMLElement) {
  await act(async () => {
    fireEvent.keyDown(composer(container), { key: "Enter" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
