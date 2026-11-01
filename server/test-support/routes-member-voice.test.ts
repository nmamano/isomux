// A member's voice choices, set for them (task 7a3b4114, Nil 2026-11-01:
// "make owners able to set Integrations for other users, including the voice
// selector"): GET/PATCH /api/users/:username/voice through the real route
// table and server.
//
// Pins: an office owner, their API token and their privileged agent set any
// member's mic and read aloud engine and voice name, and the member and their
// own privileged agent set their own; nobody else does. The write lands on the
// subject's record and reaches the subject's open tabs. The key line describes
// the SUBJECT's key, never a value. A bad body gets the same answer as
// prefs.update.
//
// Seam: startTestServer(). Zero LLM.

import { afterEach, describe, expect, it } from "bun:test";
import { mintApiToken } from "../api-tokens.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { DEFAULT_VOICE_NAME } from "../../shared/voice.ts";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";

const KEY_VALUE = "sk-member-voice-key-FAKE-7a3b";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

interface Res {
  status: number;
  body: unknown;
  text: string;
}

type Auth = { session?: string; bearer?: string };

async function call(
  srv: TestServer,
  method: string,
  path: string,
  init: Auth & { body?: unknown } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  const response = await srv.http(path, {
    method,
    headers,
    rawSessionId: init.session,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // 204 has no body.
  }
  return { status: response.status, body, text };
}

const code = (r: Res) =>
  (r.body as { error?: { code?: string } } | null)?.error?.code;

async function office() {
  const srv = await startTestServer();
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const member = await srv.seedMember("Mia");
  const other = await srv.seedMember("Olly");
  const ownerId = getUserByName(owner.username)!.id;
  const memberId = getUserByName(member.username)!.id;
  const otherId = getUserByName(other.username)!.id;
  const api = async (userId: string) =>
    (await mintApiToken({ userId, name: "API", expiresInDays: null })).token;
  return {
    srv,
    owner,
    member,
    other,
    ownerApi: await api(ownerId),
    memberApi: await api(memberId),
    otherApi: await api(otherId),
    plainAgent: mintAgentToken("voice-plain", ownerId, false),
    privilegedAgent: mintAgentToken("voice-privileged", ownerId, true),
    memberAgent: mintAgentToken("voice-member-privileged", memberId, true),
    otherAgent: mintAgentToken("voice-other-privileged", otherId, true),
    path: `/api/users/${member.username}/voice`,
  };
}

const voiceOf = (username: string) => {
  const rec = getUserByName(username)!;
  return [rec.voiceInput, rec.voiceOutput, rec.voiceName];
};

describe("member voice: who sets it", () => {
  it("an owner by cookie, API token or privileged agent sets the member's voice, and the owner's stays", async () => {
    const o = await office();
    const writes: [string, Auth, Record<string, string>][] = [
      ["cookie", { session: o.owner.rawSessionId }, { voiceInput: "openai" }],
      ["api token", { bearer: o.ownerApi }, { voiceOutput: "openai" }],
      ["privileged agent", { bearer: o.privilegedAgent }, { voiceName: "ash" }],
    ];
    for (const [who, auth, body] of writes) {
      const r = await call(o.srv, "PATCH", o.path, { ...auth, body });
      expect({ who, status: r.status }).toEqual({ who, status: 204 });
    }
    expect(voiceOf(o.member.username)).toEqual(["openai", "openai", "ash"]);
    // The caller's own record is not the subject.
    expect(voiceOf(o.owner.username)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    for (const [who, auth] of writes) {
      const r = await call(o.srv, "GET", o.path, auth);
      expect({ who, status: r.status }).toEqual({ who, status: 200 });
      expect(r.body).toMatchObject({
        voiceInput: "openai",
        voiceOutput: "openai",
        voiceName: "ash",
      });
    }
  });

  it("the member and their own privileged agent set their own", async () => {
    const o = await office();
    for (const [who, auth, body] of [
      ["cookie", { session: o.member.rawSessionId }, { voiceInput: "openai" }],
      ["api token", { bearer: o.memberApi }, { voiceOutput: "openai" }],
      ["own agent", { bearer: o.memberAgent }, { voiceName: "cedar" }],
    ] as const) {
      const r = await call(o.srv, "PATCH", o.path, { ...auth, body });
      expect({ who, status: r.status }).toEqual({ who, status: 204 });
    }
    expect(voiceOf(o.member.username)).toEqual(["openai", "openai", "cedar"]);
  });

  it("refuses an ordinary agent, another member and their proxies, and changes nothing", async () => {
    const o = await office();
    for (const [who, auth] of [
      ["owner's ordinary agent", { bearer: o.plainAgent }],
      ["other member", { session: o.other.rawSessionId }],
      ["other member's token", { bearer: o.otherApi }],
      ["other member's privileged agent", { bearer: o.otherAgent }],
    ] as const) {
      for (const method of ["GET", "PATCH"]) {
        const r = await call(o.srv, method, o.path, {
          ...auth,
          body: method === "PATCH" ? { voiceInput: "openai" } : undefined,
        });
        expect({ who, method, status: r.status, code: code(r) }).toEqual({
          who,
          method,
          status: 403,
          code: "forbidden",
        });
      }
    }
    expect(voiceOf(o.member.username)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("answers 404 for a member that does not exist", async () => {
    const o = await office();
    for (const method of ["GET", "PATCH"]) {
      const r = await call(o.srv, method, "/api/users/nobody-here/voice", {
        session: o.owner.rawSessionId,
        body: method === "PATCH" ? { voiceInput: "openai" } : undefined,
      });
      expect({ method, status: r.status }).toEqual({ method, status: 404 });
    }
  });

  // The voice area limits a token: a token with only the environment area
  // does not reach the voice choice.
  it("a limited API token needs the voice area", async () => {
    const o = await office();
    const ownerId = getUserByName(o.owner.username)!.id;
    const limited = async (areas: Record<string, "read" | "write">) =>
      (
        await mintApiToken({
          userId: ownerId,
          name: "Limited",
          expiresInDays: null,
          limits: { areas },
        })
      ).token;
    const envOnly = await limited({ environment: "write" });
    const voiceRead = await limited({ voice: "read" });
    const voiceWrite = await limited({ voice: "write" });
    expect((await call(o.srv, "GET", o.path, { bearer: envOnly })).status).toBe(
      403,
    );
    expect(
      (await call(o.srv, "GET", o.path, { bearer: voiceRead })).status,
    ).toBe(200);
    expect(
      (
        await call(o.srv, "PATCH", o.path, {
          bearer: voiceRead,
          body: { voiceInput: "openai" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(o.srv, "PATCH", o.path, {
          bearer: voiceWrite,
          body: { voiceInput: "openai" },
        })
      ).status,
    ).toBe(204);
    expect(voiceOf(o.member.username)[0]).toBe("openai");
  });
});

describe("member voice: what the owner reads", () => {
  it("reads the defaults when nothing is saved", async () => {
    const o = await office();
    const r = await call(o.srv, "GET", o.path, {
      session: o.owner.rawSessionId,
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      voiceInput: "browser",
      voiceOutput: "browser",
      voiceName: DEFAULT_VOICE_NAME,
      keySource: null,
      keyName: null,
    });
  });

  // The key line names where the SUBJECT's key comes from: here the member
  // has one and the owner has none.
  it("names the member's key source, never its value", async () => {
    const o = await office();
    const set = await call(
      o.srv,
      "PUT",
      `/api/users/${o.member.username}/env/OPENAI_VOICE_API_KEY`,
      { session: o.owner.rawSessionId, body: { value: KEY_VALUE } },
    );
    expect(set.status).toBe(204);
    for (const auth of [
      { session: o.owner.rawSessionId },
      { bearer: o.privilegedAgent },
    ]) {
      const r = await call(o.srv, "GET", o.path, auth);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        keySource: "member_variable",
        keyName: "OPENAI_VOICE_API_KEY",
      });
      expect(r.text).not.toContain(KEY_VALUE);
    }
    const own = await call(
      o.srv,
      "GET",
      `/api/users/${o.owner.username}/voice`,
      { session: o.owner.rawSessionId },
    );
    expect(own.body).toMatchObject({ keySource: null, keyName: null });
  });
});

describe("member voice: a bad body", () => {
  // The same parser as prefs.update: the same status and code for each bad
  // voice body, and language stays a member's own Settings preference.
  it("answers each bad body as prefs.update does, and writes nothing", async () => {
    const o = await office();
    for (const body of [
      { voiceInput: "google" },
      { voiceInput: null },
      { voiceOutput: "OpenAI" },
      { voiceName: "robot" },
      { voiceOutput: "openai", voiceName: "robot" },
      { voiceNmae: "ash" },
      {},
      7,
      ["voiceInput"],
    ]) {
      const self = await call(o.srv, "PATCH", "/api/me/preferences", {
        session: o.member.rawSessionId,
        body,
      });
      const forMember = await call(o.srv, "PATCH", o.path, {
        session: o.owner.rawSessionId,
        body,
      });
      expect(self.status).toBe(422);
      expect({ body, status: forMember.status, code: code(forMember) }).toEqual(
        { body, status: self.status, code: code(self) },
      );
    }
    const language = await call(o.srv, "PATCH", o.path, {
      session: o.owner.rawSessionId,
      body: { language: "es" },
    });
    expect(language.status).toBe(422);
    expect(getUserByName(o.member.username)!.language).toBe(null);
    expect(voiceOf(o.member.username)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("member voice: the member's open tabs", () => {
  const bag = (sock: TestSocket, type: string): Record<string, unknown>[] =>
    (sock.messages as Record<string, unknown>[]).filter((m) => m.type === type);
  async function fence(sock: TestSocket): Promise<void> {
    const before = bag(sock, "pong").length;
    sock.send({ type: "ping" });
    const deadline = Date.now() + 2000;
    while (bag(sock, "pong").length <= before) {
      if (Date.now() > deadline) throw new Error("fence timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  // The member's Voice tab and mic read the record from the store, so an
  // owner's write that does not reach the member's socket looks like nothing
  // changed until a reload.
  it("an owner's write reaches the member's socket with the new record, and no public event carries it", async () => {
    const o = await office();
    const memberSock = await o.srv.connectWs(o.member.rawSessionId);
    const ownerSock = await o.srv.connectWs(o.owner.rawSessionId);
    await memberSock.waitFor("presence_list");
    await ownerSock.waitFor("presence_list");
    // Each socket gets its own record once at connect; count only what the
    // write sends.
    await fence(memberSock);
    await fence(ownerSock);
    const since = (sock: TestSocket, type: string) => {
      const before = bag(sock, type).length;
      return () => bag(sock, type).slice(before);
    };
    const memberSelf = since(memberSock, "user_self_updated");
    const memberPublic = since(memberSock, "user_updated");
    const ownerSelf = since(ownerSock, "user_self_updated");
    const ownerAdmin = since(ownerSock, "user_admin_updated");
    const ownerPublic = since(ownerSock, "user_updated");
    const r = await call(o.srv, "PATCH", o.path, {
      session: o.owner.rawSessionId,
      body: { voiceInput: "openai", voiceName: "cedar" },
    });
    expect(r.status).toBe(204);
    await fence(memberSock);
    await fence(ownerSock);
    const selfEvents = memberSelf();
    expect(selfEvents).toHaveLength(1);
    expect(selfEvents[0].user).toMatchObject({
      name: "Mia",
      voiceInput: "openai",
      voiceName: "cedar",
    });
    // The owner's socket is not the subject's.
    expect(ownerSelf()).toHaveLength(0);
    expect(ownerAdmin()).toHaveLength(1);
    expect(ownerAdmin()[0].user).toMatchObject({ voiceInput: "openai" });
    expect(ownerPublic()).toHaveLength(0);
    expect(memberPublic()).toHaveLength(0);
    memberSock.close();
    ownerSock.close();
  });
});
