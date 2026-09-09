import { afterEach, expect, it } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getUserByName } from "../users.ts";
import type { ServerMessage } from "../../shared/types.ts";
import { STATE_ROOT } from "../config.ts";

let server: TestServer | null = null;
afterEach(async () => { await server?.stop(); server = null; });

it("pushes a full fresh snapshot before auth guidance without rereading Codex", async () => {
  let connected = true;
  let codexReads = 0;
  const fake = new FakeBackend({ isAuthError: (text) => text.includes("Not logged in"), session: {
    onSend: (_text, _attachments, session) => {
      session.push({ kind: "system_text", text: "Not logged in" });
      session.push({ kind: "turn_completed", status: "failed", error: "Not logged in" });
    },
  } });
  server = await startTestServer({ fakeBackend: fake, startServer: {
    createClaudeAccountClient: () => ({ start: async () => {}, read: async () => ({ connected }), close: async () => {} }) as never,
    createCodexAccountClient: () => ({ start: async () => {}, read: async () => { codexReads++; return { connected: true }; }, close: async () => {} }) as never,
  } });
  const owner = await server.seedOwner("Owner");
  const uid = getUserByName("Owner")!.id;
  const info = await server.agentManager.spawn("Auth", STATE_ROOT, "default", 0, undefined,
    server.agentManager.getRooms()[0].id, undefined, "fake", "high", "Owner", "claude", undefined, uid);
  const socket = await server.connectWs(owner.rawSessionId);
  await socket.waitFor("provider_accounts_updated");
  const before = socket.messages.length;
  const oldCodexReads = codexReads;
  connected = false;
  await server.agentManager.sendMessage(info!.id, "hello", "Owner");
  const deadline = Date.now() + 1_000;
  while (!(socket.messages.slice(before) as ServerMessage[]).some((m) => m.type === "log_entry" && m.entry.metadata?.providerLogin) && Date.now() < deadline) await Bun.sleep(5);
  const updates = socket.messages.slice(before) as ServerMessage[];
  const freshIndex = updates.findIndex((m) => m.type === "provider_accounts_updated");
  const guidanceIndex = updates.findIndex((m) => m.type === "log_entry" && m.entry.metadata?.providerLogin === "claude");
  expect(freshIndex).toBeGreaterThanOrEqual(0);
  expect(guidanceIndex).toBeGreaterThan(freshIndex);
  const update = updates[freshIndex];
  if (update.type !== "provider_accounts_updated") throw new Error("Missing account snapshot");
  expect(update.accounts).toHaveLength(4);
  expect(update.accounts.find((a) => a.provider === "claude" && a.scope === "office")?.accountStatus).toBe("not_connected");
  expect(update.accounts.find((a) => a.provider === "codex" && a.scope === "office")?.accountStatus).toBe("connected");
  expect(codexReads).toBe(oldCodexReads);
  socket.close();
});
