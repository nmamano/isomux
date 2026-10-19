// A selection copied from the chat goes on the clipboard as plain text only, so
// it pastes unformatted (into Gmail, for example). The handler must leave an
// editable field's own copy alone, and must not wipe the clipboard when there
// is nothing to copy. Each negative case runs next to a positive control on the
// same selection, so a handler that never fires cannot pass it.

import { afterAll, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render, cleanup } = await import("@testing-library/react");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { ChatTranscript, useChatTranscript } =
  await import("./ChatTranscript.tsx");
const { MembersChatPanel } =
  await import("../members-chat/MembersChatPanel.tsx");
const { setApiShim } = await import("../api.ts");
type LogEntry = import("../../shared/types.ts").LogEntry;
type ReactNode = import("react").ReactNode;
afterAll(() => setApiShim(null));

function reply(id: string, content: string): LogEntry {
  return { id, agentId: "a", timestamp: 1, kind: "text", content };
}

function Transcript({
  logs,
  afterEntry,
}: {
  logs: LogEntry[];
  afterEntry?: (entry: LogEntry) => ReactNode;
}) {
  const view = useChatTranscript(logs, false);
  return (
    <ChatTranscript
      logs={logs}
      view={view}
      isMobile={false}
      afterEntry={afterEntry}
    />
  );
}

function textNodeOf(root: Element, text: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    if (n.textContent?.includes(text)) return n as Text;
  throw new Error(`no text node holds ${text}`);
}

function select(start: Text, end: Text = start): string {
  const range = document.createRange();
  range.setStart(start, 0);
  range.setEnd(end, end.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection.toString();
}

// What a browser does on Ctrl+C: a cancelable copy event at the element that
// holds the start of the selection (or the focused field).
function copyAt(target: Element) {
  const writes: Array<[string, string]> = [];
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      setData: (type: string, value: string) => writes.push([type, value]),
    },
  });
  target.dispatchEvent(event);
  return { writes, prevented: event.defaultPrevented };
}

describe("agent chat", () => {
  it("copies a selection across replies as plain text only", () => {
    const view = render(
      onLanguage(
        "en",
        <Transcript
          logs={[
            reply("r1", String.raw`It costs **\$5** today.`),
            reply("r2", "Second reply."),
          ]}
        />,
      ),
    );
    const first = textNodeOf(view.container, "It costs");
    const last = textNodeOf(view.container, "Second reply.");
    const selected = select(first, last);
    expect(selected).toContain("$5");
    expect(selected).toContain("Second reply.");
    const copy = copyAt(first.parentElement!);
    expect(copy.writes).toEqual([["text/plain", selected]]);
    expect(copy.prevented).toBe(true);
    cleanup();
  });

  it("leaves a copy alone when nothing is selected or the selection holds no text", () => {
    const view = render(
      onLanguage(
        "en",
        <Transcript
          logs={[reply("r1", "Some reply.")]}
          afterEntry={() => <span data-empty="" />}
        />,
      ),
    );
    const text = textNodeOf(view.container, "Some reply.");
    expect(select(text)).toBe("Some reply.");
    expect(copyAt(text.parentElement!).prevented).toBe(true);

    window.getSelection()!.collapse(text, 2);
    expect(window.getSelection()!.isCollapsed).toBe(true);
    const collapsed = copyAt(text.parentElement!);
    expect(collapsed.writes).toEqual([]);
    expect(collapsed.prevented).toBe(false);

    const empty = view.container.querySelector("[data-empty]")!;
    const range = document.createRange();
    range.selectNode(empty);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(window.getSelection()!.isCollapsed).toBe(false);
    expect(window.getSelection()!.toString()).toBe("");
    const blank = copyAt(empty);
    expect(blank.writes).toEqual([]);
    expect(blank.prevented).toBe(false);
    cleanup();
  });

  it("leaves an editable field's copy, and an inner handler's copy, to them", () => {
    const view = render(
      onLanguage(
        "en",
        <Transcript
          logs={[reply("r1", "Some reply.")]}
          afterEntry={() => (
            <>
              <textarea defaultValue="draft" />
              <input defaultValue="field" />
              <div contentEditable suppressContentEditableWarning>
                <b data-editable-child="">edit me</b>
              </div>
              <span data-own-copy="" onCopy={(e) => e.preventDefault()}>
                own
              </span>
            </>
          )}
        />,
      ),
    );
    const text = textNodeOf(view.container, "Some reply.");
    select(text);
    const control = copyAt(text.parentElement!);
    expect(control.writes).toEqual([["text/plain", "Some reply."]]);
    for (const selector of [
      "textarea",
      "input",
      "[data-editable-child]",
      "[data-own-copy]",
    ]) {
      select(text);
      const copy = copyAt(view.container.querySelector(selector)!);
      expect({ selector, writes: copy.writes }).toEqual({
        selector,
        writes: [],
      });
    }
    cleanup();
  });
});

describe("members chat", () => {
  it("copies a selection in the message list as plain text only", () => {
    setApiShim(async () => ({ readPointer: null, unread: 0 }));
    const view = render(
      onLanguage("en", <MembersChatPanel />, {
        membersChat: {
          loaded: true,
          messages: [
            {
              id: "01",
              kind: "user" as const,
              userId: "other",
              userName: "Sam",
              content: "See **this** note.",
              attachments: [],
              timestamp: 1,
            },
          ],
          hasMore: false,
          unread: 0,
          readPointer: null,
        },
      }),
    );
    const list = view.container.querySelector("[data-members-chat-list]")!;
    const text = textNodeOf(list, "this");
    const selected = select(text);
    expect(selected).toBe("this");
    const copy = copyAt(text.parentElement!);
    expect(copy.writes).toEqual([["text/plain", "this"]]);
    expect(copy.prevented).toBe(true);
    cleanup();
  });
});
