import { describe, test, expect } from "bun:test";
import { BrowserExtensionBridge, browserCredentialHash } from "./browser-extension-bridge";
import { browserSocketURL, fields, type Fields } from "../shared/browser-extension-protocol";
import { browserExtensionFixture } from "./test-support/browser-extension-fixture";

function peer() {
  return { messages: [] as Fields[], closed: false,
    send(message: Fields) { this.messages.push(message); }, close() { this.closed = true; } };
}
function harness() {
  let authorized = true;
  const credential = "test-browser-credential";
  const extension = peer();
  const bridge = new BrowserExtensionBridge({
    memberForCredentialHash: hash => hash === browserCredentialHash(credential) && authorized ? "member" : undefined,
    mayUse: (member, agent) => authorized && member === "member" && ["agent", "other-agent"].includes(agent),
  });
  const connection = bridge.connect(credential, extension);
  const client = peer();
  const agent = connection.assign("agent", client);
  return { bridge, connection, client, agent, extension, credential, revoke: () => { authorized = false; } };
}
async function create(h: ReturnType<typeof harness>) {
  const work = h.agent.receive({ id: 1, method: "Target.createTarget", params: { url: "about:blank" } });
  const command = h.extension.messages.at(-1)!;
  h.connection.receive({ kind: "result", generation: h.connection.generation, id: command.id, result: { targetInfo: { targetId: "owned", type: "page", url: "about:blank" } } });
  await work;
  const attached = h.client.messages.find(msg => msg.method === "Target.attachedToTarget")!;
  return { sessionId: fields(attached.params).sessionId, assignment: command.assignment };
}

describe("browser extension isolation", () => {
  test("real fixture socket requires the browser credential before assignment", async () => {
    const fixture = browserExtensionFixture();
    const ws = new WebSocket(fixture.extensionURL);
    const received: string[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => ws.send(JSON.stringify({ kind: "hello", version: 1, credential: "wrong" }));
        ws.onmessage = event => received.push(String(event.data));
        ws.onclose = () => resolve();
        ws.onerror = () => reject(new Error("Fixture socket failed"));
      });
      expect(received).toHaveLength(0);
      expect(fixture.bridge.forMember("fixture-member")).toBeUndefined();
    } finally { ws.close(); fixture.stop(); }
  });
  test("structural transport URL checks", () => {
    for (const url of ["ws://127.0.0.1:123/extension", "ws://[::1]/extension", "ws://localhost/extension", "wss://office.example/extension"]) expect(browserSocketURL(url)).toBe(url);
    for (const url of ["ws://office.example/extension", "ws://127.0.0.1.evil.test/", "https://office.example/", "file:///tmp/x", "wss://user:secret@office.example/", "wss://office.example/?credential=x", "wss://office.example/#x"]) expect(() => browserSocketURL(url)).toThrow();
  });
  test("credential and member authorization gate assignment", () => {
    const h = harness();
    expect(() => h.bridge.connect("wrong", peer())).toThrow();
    expect(() => h.bridge.connect(h.credential, peer())).toThrow();
    expect(() => h.connection.assign("foreign-agent", peer())).toThrow();
    expect(() => h.connection.assign("agent", peer())).toThrow();
    h.connection.close();
  });
  test("target discovery filters and profile commands never leave the adapter", async () => {
    const h = harness();
    const { sessionId } = await create(h);
    const before = h.extension.messages.length;
    await h.agent.receive({ id: 2, method: "Target.getTargets" });
    expect(fields(h.client.messages.at(-1)!.result).targetInfos).toEqual([{ targetId: "owned", type: "page", url: "about:blank" }]);
    const rejected = [
      { method: "Target.createTarget", params: { url: "about:blank" } },
      { method: "Target.getTargetInfo", params: { targetId: "foreign" } },
      { method: "Target.attachToTarget", params: { targetId: "foreign" } },
      { method: "Target.createBrowserContext" }, { method: "Storage.getCookies" },
      { method: "Browser.close" }, { method: "Runtime.evaluate", sessionId: "foreign" },
      { method: "Network.getAllCookies", sessionId }, { method: "Storage.clearDataForOrigin", sessionId },
      { method: "Target.getTargets", sessionId },
    ];
    for (const command of rejected) {
      await h.agent.receive({ id: 3, ...command });
      expect(h.client.messages.at(-1)!.error).toBeDefined();
    }
    expect(h.extension.messages.length).toBe(before);
    h.connection.close();
  });
  test("cross-agent session and event routing stays assigned", async () => {
    const h = harness();
    const { sessionId, assignment } = await create(h);
    const other = peer();
    const otherAgent = h.connection.assign("other-agent", other);
    await otherAgent.receive({ id: 1, method: "Runtime.evaluate", sessionId });
    expect(other.messages.at(-1)!.error).toBeDefined();
    const count = h.client.messages.length;
    h.connection.receive({ kind: "event", generation: h.connection.generation, assignment: "foreign", method: "Runtime.consoleAPICalled", params: {} });
    h.connection.receive({ kind: "event", generation: h.connection.generation, assignment, sessionId: "foreign", method: "Runtime.consoleAPICalled", params: {} });
    expect(h.client.messages.length).toBe(count);
    h.connection.close();
  });
  test("disconnect rejects pending work and old generations cannot replay", async () => {
    const h = harness();
    const { sessionId } = await create(h);
    const work = h.agent.receive({ id: 5, method: "Runtime.evaluate", sessionId, params: { expression: "sideEffect()" } });
    const sent = h.extension.messages.at(-1)!;
    expect(sent.method).toBe("cdp");
    h.connection.close();
    await work;
    expect(h.client.closed).toBe(true);
    const count = h.extension.messages.length;
    await h.agent.receive({ id: 6, method: "Runtime.evaluate", sessionId, params: {} });
    expect(h.extension.messages.length).toBe(count);
    const nextPeer = peer();
    const fresh = h.bridge.connect(h.credential, nextPeer);
    const freshClient = peer();
    const freshAgent = fresh.assign("agent", freshClient);
    const newWork = freshAgent.receive({ id: 1, method: "Target.createTarget", params: { url: "about:blank" } });
    const freshSent = nextPeer.messages.at(-1)!;
    fresh.receive({ kind: "result", generation: h.connection.generation, id: freshSent.id, result: { targetInfo: { targetId: "old", type: "page" } } });
    await Promise.resolve();
    await Promise.resolve();
    expect(freshClient.messages).toHaveLength(0);
    expect(nextPeer.messages.filter(msg => msg.method === "cdp")).toHaveLength(0);
    fresh.close();
    await newWork;
  });
  test("authorization is rechecked before dispatch", async () => {
    const h = harness();
    const { sessionId } = await create(h);
    h.revoke();
    await h.agent.receive({ id: 8, method: "Runtime.evaluate", sessionId });
    expect(h.client.closed).toBe(true);
    expect(h.extension.messages.at(-1)!.method).toBe("detach");
    h.connection.close();
  });
  test("release and malformed responses settle in-flight work", async () => {
    for (const action of ["release", "malformed"]) {
      const h = harness();
      const { sessionId } = await create(h);
      const work = h.agent.receive({ id: 5, method: "Runtime.evaluate", sessionId, params: {} });
      if (action === "release") h.agent.close();
      else h.connection.receive({ kind: "result", generation: h.connection.generation, id: h.extension.messages.at(-1)!.id, result: null });
      await work;
      expect(h.client.closed).toBe(true);
      h.connection.close();
    }
  });
  test("a child target cannot claim another assignment's target", async () => {
    const h = harness();
    const { assignment } = await create(h);
    h.connection.receive({ kind: "event", generation: h.connection.generation, assignment, method: "Target.attachedToTarget", params: { sessionId: "child", targetInfo: { targetId: "owned", type: "iframe" } } });
    expect(h.client.closed).toBe(true);
    h.connection.close();
  });
});
