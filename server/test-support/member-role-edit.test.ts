import { afterEach, expect, it } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { getUserByName } from "../users.ts";
import { validateSession } from "../auth.ts";
let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

it("only an owner can edit roles; the edit updates live sessions and cannot remove the last owner", async () => {
  const srv = (server = await startTestServer());
  const boss = await srv.seedOwner("Boss");
  const member = await srv.seedMember("Member");
  const patch = (name: string, cookie: string, body: unknown) =>
    srv.http(`/api/users/${name}`, {
      method: "PATCH",
      rawSessionId: cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const socket = await srv.connectWs(member.rawSessionId);
  try {
    expect(
      (await patch("Member", member.rawSessionId, { role: "owner" })).status,
    ).toBe(403);
    expect(getUserByName("Member")?.role).toBe("member");
    expect(
      (await patch("Boss", boss.rawSessionId, { role: "member" })).status,
    ).toBe(409);
    expect(
      (
        await patch("Member", boss.rawSessionId, {
          role: "owner",
          name: "Boss",
        })
      ).status,
    ).toBe(409);
    expect(getUserByName("Member")?.role).toBe("member");
    await socket.waitFor("session_context");
    socket.messages.length = 0;
    expect(
      (await patch("Member", boss.rawSessionId, { role: "owner" })).status,
    ).toBe(200);
    expect((await socket.waitFor("session_context")).context).toMatchObject({
      role: "owner",
    });
    expect(validateSession(member.rawSessionId)?.role).toBe("owner");
    expect(
      (await srv.http("/api/invites", { rawSessionId: member.rawSessionId }))
        .status,
    ).toBe(200);
    socket.messages.length = 0;
    expect(
      (await patch("Member", boss.rawSessionId, { role: "member" })).status,
    ).toBe(200);
    expect((await socket.waitFor("session_context")).context).toMatchObject({
      role: "member",
    });
    expect(validateSession(member.rawSessionId)?.role).toBe("member");
    expect(
      (
        await srv.http("/api/invites", {
          method: "POST",
          rawSessionId: member.rawSessionId,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: "member" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (await patch("Boss", boss.rawSessionId, { role: "member" })).status,
    ).toBe(409);
    expect(
      (await patch("Member", boss.rawSessionId, { role: "invalid" })).status,
    ).toBe(422);
  } finally {
    socket.close();
  }
});
