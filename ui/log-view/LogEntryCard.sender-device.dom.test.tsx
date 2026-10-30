// Task 0a911d08: a member message carries a device label ("Windows", "Phone",
// or an app widget's app, page and title). The header shows the member's name
// in caps, but the device part keeps its own case: a page path and a title
// shouted in caps read badly. One case per surface that shows the header: the
// delivered bubble, the edit-in-place header, and the queued chip.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render } = await import("@testing-library/react");
const { LogEntryCard } = await import("./LogEntryCard.tsx");
const { LogView } = await import("./LogView.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
type AgentInfo = import("../../shared/types.ts").AgentInfo;

setApiShim(async () => ({ counts: {} }));

const DEVICE =
  'App nilmamano, page "/blog/isomux-backstory", title "Isomux backstory"';
// A part of DEVICE in mixed case that only the device text contains.
const DEVICE_MARK = 'title "Isomux backstory"';

function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

// The text-transform a reader sees on a text node: the nearest inline one.
function transformOf(node: Node): string {
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (el.style.textTransform) return el.style.textTransform;
  }
  return "none";
}

// The name is shown in caps (by the string or by the style), and the device
// part keeps the case it was sent in, in the same header.
function expectNameShoutedDeviceNot(container: HTMLElement) {
  const nodes = textNodes(container);
  const device = nodes.find((n) => n.data.includes(DEVICE_MARK));
  expect(device, "device text in its own case").toBeDefined();
  expect(transformOf(device!)).not.toBe("uppercase");
  // "nilmamano" in the device does not match \bnil\b.
  const name = nodes.find((n) => /\bnil\b/i.test(n.data));
  expect(name, "member name").toBeDefined();
  expect(
    /\bNIL\b/.test(name!.data) || transformOf(name!) === "uppercase",
    "name shown in caps",
  ).toBe(true);
  // One header, read as the agent reads the label: the name, then the device
  // in parentheses.
  let header = device!.parentElement!;
  while (!header.contains(name!)) header = header.parentElement!;
  expect((header.textContent ?? "").toLowerCase()).toContain(
    `nil (${DEVICE.toLowerCase()})`,
  );
}

const message = {
  id: "m1",
  agentId: "a1",
  timestamp: 1,
  kind: "user_message" as const,
  content: "What do you think of this post?",
  metadata: { username: "Nil", device: DEVICE },
};

it("keeps the device part's case in the delivered bubble", () => {
  const view = render(onLanguage("en", <LogEntryCard entry={message} />));
  expectNameShoutedDeviceNot(view.container);
  view.unmount();
});

it("keeps the device part's case in the edit header", () => {
  const view = render(
    onLanguage("en", <LogEntryCard entry={message} isEditing />),
  );
  // The edit header, not the bubble: the textarea is up.
  expect(view.container.querySelector("textarea")).not.toBeNull();
  expectNameShoutedDeviceNot(view.container);
  view.unmount();
});

it("keeps the device part's case in the queued chip", () => {
  const agent = {
    id: "a1",
    name: "Tester",
    desk: 0,
    roomId: "r1",
    cwd: "~",
    state: "thinking",
    agentType: "claude",
    modelFamily: "opus",
    topic: null,
    userId: "u1",
    username: "Tester",
    queue: [
      {
        id: "q1",
        sender: { kind: "user", username: "Nil", device: DEVICE },
        text: "What do you think of this post?",
        queuedAt: 1,
      },
    ],
    contextUsage: null,
    outfit: {
      color: "#4A90D9",
      hair: "#222",
      hairStyle: "short",
      skin: "#FFD5B8",
      beard: "none",
      accessory: "none",
      hat: "none",
    },
    capabilities: {},
  } as unknown as AgentInfo;
  const view = render(
    onLanguage(
      "en",
      <LogView
        agent={agent}
        logs={[]}
        onBack={() => {}}
        onEditAgent={() => {}}
      />,
      {
        agents: [agent],
        rooms: [
          { id: "r1", name: "Room", prompt: null, canCloseWhenEmpty: true },
        ],
        hasReceivedInitialState: true,
        connected: true,
      },
    ),
  );
  expectNameShoutedDeviceNot(view.container);
  view.unmount();
});
