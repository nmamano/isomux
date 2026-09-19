import { buildPublicOrigin } from "../auth";
import type { TestServer, SeededIdentity } from "./harness";
import { getUserByName } from "../users";
import { EXTENSION_SOCKET_PATH } from "../browser-extension-service";
export const origin = "chrome-extension://" + "a".repeat(32);
export async function memberRequest(
  s: TestServer,
  member: SeededIdentity,
  method: string,
  path: string,
  body?: unknown,
) {
  return s.http(path, {
    method,
    rawSessionId: member.rawSessionId,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
export async function ownedAgent(
  s: TestServer,
  member: SeededIdentity,
  name: string,
) {
  const user = getUserByName(member.username)!;
  const agent = await s.agentManager.spawn(
    name,
    s.stateRoot,
    "default",
    undefined,
    undefined,
    s.agentManager.getOrdinaryRooms()[0].id,
    undefined,
    undefined,
    undefined,
    member.username,
    "claude",
    undefined,
    user.id,
  );
  if (!agent) throw new Error("spawn failed");
  return agent;
}
export async function extensionSocket(
  s: TestServer,
  hello: unknown,
  socketOrigin = origin,
) {
  const ws = new WebSocket(
    buildPublicOrigin().origin.replace("http:", "ws:") + EXTENSION_SOCKET_PATH,
    { headers: { Origin: socketOrigin } } as unknown as string[],
  );
  const messages: Record<string, unknown>[] = [];
  let closed = false;
  ws.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
  ws.onclose = () => {
    closed = true;
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => {
      ws.send(JSON.stringify(hello));
      resolve();
    };
    ws.onerror = () => reject(new Error("socket failed"));
  });
  const wait = async (kind: string) => {
    for (let i = 0; i < 200; i++) {
      const found = messages.find((m) => m.kind === kind);
      if (found) return found;
      if (closed) break;
      await Bun.sleep(5);
    }
    throw new Error("Missing socket frame " + kind);
  };
  return { ws, messages, wait, closed: () => closed };
}
