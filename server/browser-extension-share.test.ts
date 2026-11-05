// Share page with agent (task 68da3968): the extension sends the page of its
// popup's tab to an agent the member reaches. The office writes the message
// and delivers it as the member's; the agent gets no control of the tab.
import { expect, test } from "bun:test";
import {
  BrowserExtensionBridge,
  browserCredentialHash,
} from "./browser-extension-bridge";
import type { Fields } from "../shared/browser-extension-protocol";
import { formatSharedPage } from "../shared/browser-share";

// ann reaches the agents of room r1; bob reaches r1 and r2. Room names sort
// the other way round from their ids.
const ROOM: Record<string, string> = {
  "ann-agent": "r1",
  "bob-agent": "r1",
  "far-agent": "r2",
  zed: "r1",
};
const ROOM_NAME: Record<string, string> = { r1: "Beta", r2: "Alpha" };
const NAME: Record<string, string> = {
  "ann-agent": "Ann's agent",
  "bob-agent": "Bob's agent",
  "far-agent": "Far agent",
  zed: "Aaron",
};
const ROOMS: Record<string, Set<string>> = {
  ann: new Set(["r1"]),
  bob: new Set(["r1", "r2"]),
};

type Wire = {
  messages: Fields[];
  closed: number;
  send(m: Fields): void;
  close(): void;
};
const wire = (): Wire => ({
  messages: [],
  closed: 0,
  send(m) {
    this.messages.push(m);
  },
  close() {
    this.closed++;
  },
});
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

type Delivery = { member: string; agentId: string; text: string };
function office(
  answer: (
    d: Delivery,
  ) => Promise<{ ok: true } | { ok: false; code: string }> = async () => ({
    ok: true,
  }),
) {
  const delivered: Delivery[] = [];
  const reach = (member: string, agent: string) =>
    agent in ROOM && !!ROOMS[member]?.has(ROOM[agent]);
  const bridge = new BrowserExtensionBridge({
    memberForCredentialHash: (hash) =>
      ({
        [browserCredentialHash("ann-laptop")]: "ann",
        [browserCredentialHash("bob-desk")]: "bob",
      })[hash],
    mayUse: (member, agent) => reach(member, agent) && agent.startsWith(member),
    mayReach: reach,
    agents: () => Object.keys(ROOM),
    memberDisplay: (member) => ({ id: member, name: member }),
    agentDisplay: (agent) => ({ id: agent, name: NAME[agent] ?? agent }),
    agentRoom: (agent) => ROOM_NAME[ROOM[agent]],
    share: (member, agentId, text) => {
      const d = { member, agentId, text };
      delivered.push(d);
      return answer(d);
    },
  });
  const open = (credential: string) => {
    const peer = wire();
    const connection = bridge.connect(credential, peer);
    let next = 0;
    // Sends a share frame and returns the office's answer to it.
    const share = async (frame: Record<string, unknown>) => {
      const id = `share-${++next}`;
      const sent = peer.messages.length;
      connection.receive({
        kind: "share",
        generation: connection.generation,
        id,
        ...frame,
      });
      await settle();
      return peer.messages
        .slice(sent)
        .filter((m) => m.kind === "shareResult" && m.id === id);
    };
    return { peer, connection, share };
  };
  return { bridge, delivered, open };
}

const PAGE = {
  agentId: "ann-agent",
  url: "https://example.com/post?id=7#top",
  title: "A post",
  selection: "Read this",
};

test("ready offers share, and metadata lists every agent the member reaches, by room name, then name", () => {
  const o = office();
  for (const [credential, expected] of [
    [
      "ann-laptop",
      [
        { id: "zed", name: "Aaron", room: "Beta" },
        { id: "ann-agent", name: "Ann's agent", room: "Beta" },
        { id: "bob-agent", name: "Bob's agent", room: "Beta" },
      ],
    ],
    [
      "bob-desk",
      [
        { id: "far-agent", name: "Far agent", room: "Alpha" },
        { id: "zed", name: "Aaron", room: "Beta" },
        { id: "ann-agent", name: "Ann's agent", room: "Beta" },
        { id: "bob-agent", name: "Bob's agent", room: "Beta" },
      ],
    ],
  ] as const) {
    const { peer } = o.open(credential);
    expect(peer.messages.find((m) => m.kind === "ready")?.share).toBe(true);
    const metadata = peer.messages.findLast((m) => m.kind === "metadata")!;
    expect(metadata.shareAgents).toStrictEqual(expected);
  }
});

test("a share reaches the agent as the office's text for the page, answered with no error, and opens no tab grant", async () => {
  const o = office();
  const { peer, share } = o.open("ann-laptop");
  const before = peer.messages.length;
  const answers = await share(PAGE);
  expect(answers).toHaveLength(1);
  expect(answers[0].error).toBeUndefined();
  expect(o.delivered).toStrictEqual([
    {
      member: "ann",
      agentId: "ann-agent",
      text: formatSharedPage({
        url: PAGE.url,
        title: PAGE.title,
        selection: PAGE.selection,
      }),
    },
  ]);
  // The text names the page, so the stub formatter cannot pass for it.
  expect(o.delivered[0].text).toContain(PAGE.url);
  // Only the answer went out: no attach or other command, no grant.
  expect(peer.messages.slice(before).map((m) => m.kind)).toEqual([
    "shareResult",
  ]);
  expect(o.bridge.targets("ann", "ann-agent")).toEqual([]);
  expect(peer.closed).toBe(0);
});

test("the office sends the parsed URL, not the raw string", async () => {
  const o = office();
  const { share } = o.open("ann-laptop");
  const answers = await share({
    ...PAGE,
    url: "HTTPS://Example.COM/a b?q=1",
    selection: undefined,
  });
  expect(answers[0]?.error).toBeUndefined();
  expect(o.delivered[0].text).toBe(
    formatSharedPage({ url: "https://example.com/a%20b?q=1", title: "A post" }),
  );
});

test("a share to an agent the member does not reach is refused before delivery", async () => {
  const o = office();
  const { peer, share } = o.open("ann-laptop");
  for (const agentId of ["far-agent", "no-such-agent"]) {
    const answers = await share({ ...PAGE, agentId });
    expect(answers.map((m) => m.error)).toEqual(["agent_unavailable"]);
  }
  expect(o.delivered).toEqual([]);
  expect(peer.closed).toBe(0);
  // The same connection still delivers a share it may send.
  expect((await share(PAGE))[0].error).toBeUndefined();
  expect(o.delivered.map((d) => d.agentId)).toEqual(["ann-agent"]);
});

test("a malformed share is answered invalid_share and the socket stays open", async () => {
  const o = office();
  const { peer, share } = o.open("ann-laptop");
  const bad: Record<string, unknown>[] = [
    { ...PAGE, agentId: 7 },
    { ...PAGE, url: 42 },
    { ...PAGE, url: "javascript:alert(1)" },
    { ...PAGE, url: "file:///etc/passwd" },
    { ...PAGE, url: "chrome://settings" },
    { ...PAGE, url: "not a url" },
    { ...PAGE, url: "https://user:pass@example.com/" },
    { ...PAGE, url: "https://user@example.com/" },
    { ...PAGE, url: "https://example.com/" + "a".repeat(4096) },
    // Under 4096 characters as sent, over it once parsed.
    { ...PAGE, url: "https://example.com/" + " ".repeat(1400) + "x" },
    { ...PAGE, title: null },
    { ...PAGE, title: undefined },
    { ...PAGE, selection: 3 },
  ];
  for (const frame of bad) {
    // The frame rides along, so a failure names the case.
    const frameText = JSON.stringify(frame).slice(0, 80);
    const errors = (await share(frame)).map((m) => m.error);
    expect({ frameText, errors }).toEqual({
      frameText,
      errors: ["invalid_share"],
    });
  }
  expect(o.delivered).toEqual([]);
  expect(peer.closed).toBe(0);
  // The longest URL that passes is delivered.
  const longest = "https://example.com/" + "a".repeat(4096 - 20);
  expect(longest).toHaveLength(4096);
  expect((await share({ ...PAGE, url: longest }))[0].error).toBeUndefined();
  expect(o.delivered).toHaveLength(1);
});

test("a refused delivery passes its code back, and a delivery that throws is answered too", async () => {
  let mode: "refuse" | "throw" = "refuse";
  const o = office(async () => {
    if (mode === "throw") throw new Error("delivery failed");
    return { ok: false, code: "awaits_member_answer" };
  });
  const { peer, share } = o.open("ann-laptop");
  expect((await share(PAGE)).map((m) => m.error)).toEqual([
    "awaits_member_answer",
  ]);
  mode = "throw";
  const thrown = await share(PAGE);
  expect(thrown).toHaveLength(1);
  expect(typeof thrown[0].error).toBe("string");
  expect(thrown[0].error).not.toBe("");
  expect(o.delivered).toHaveLength(2);
  expect(peer.closed).toBe(0);
});

test("a share from an earlier generation is not delivered", async () => {
  const o = office();
  const { peer, connection } = o.open("ann-laptop");
  connection.receive({
    kind: "share",
    generation: "an-earlier-generation",
    id: "old",
    ...PAGE,
  });
  await settle();
  expect(o.delivered).toEqual([]);
  expect(peer.messages.filter((m) => m.kind === "shareResult")).toEqual([]);
  // The enabling condition: the same frame on this generation is delivered.
  connection.receive({
    kind: "share",
    generation: connection.generation,
    id: "now",
    ...PAGE,
  });
  await settle();
  expect(o.delivered).toHaveLength(1);
});
