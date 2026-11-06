// Personal preferences (task 49d4e2f6): PATCH /api/me/preferences, exercised
// through the real REST surface.
//
// The four things worth pinning:
//   - the round trip actually reaches disk (asserted through a COLD RESTART,
//     not just the in-memory record - a preference that doesn't survive a
//     restart is worse than no preference);
//   - the write is SELF-scoped (no :username param exists, so one user's call
//     can never land on another's record);
//   - malformed / unsupported values are rejected rather than silently
//     clamped. Unlike view.*, there's no no-oracle concern here: a language
//     code says nothing about the office's contents;
//   - the write FANS OUT on the right channels. The UI reads these preferences
//     off the record it holds in its store, so persistence alone is not enough
//     for the feature to work.

import { describe, it, expect, afterEach } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { getUserByName } from "../users.ts";
import { mintApiToken } from "../api-tokens.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { defaultRecordingWords } from "../../shared/recording-redact.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function putPrefs(
  srv: TestServer,
  rawSessionId: string,
  body: unknown,
): Promise<number> {
  const resp = await srv.http("/api/me/preferences", {
    method: "PATCH",
    rawSessionId,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return resp.status;
}

describe("prefs.update - persistence", () => {
  it("round-trips every preference through a cold restart, each write leaving the others alone", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
    const session = owner.rawSessionId;
    for (const body of [
      { language: "es" },
      { voiceInput: "openai" },
      { voiceOutput: "openai", voiceName: "cedar" },
    ])
      expect({ body, status: await putPrefs(server, session, body) }).toEqual({
        body,
        status: 204,
      });

    // Cold reload re-runs the real boot path against persisted users.json.
    server = await server.restart();
    const reloaded = getUserByName("Morgan")!;
    expect([
      reloaded.language,
      reloaded.voiceInput,
      reloaded.voiceOutput,
      reloaded.voiceName,
    ]).toEqual(["es", "openai", "openai", "cedar"]);

    expect(await putPrefs(server, session, { voiceInput: "browser" })).toBe(
      204,
    );
    expect(await putPrefs(server, session, { voiceOutput: "browser" })).toBe(
      204,
    );
    const rec = getUserByName("Morgan")!;
    expect([
      rec.language,
      rec.voiceInput,
      rec.voiceOutput,
      rec.voiceName,
    ]).toEqual(["es", "browser", "browser", "cedar"]);
  });

  // Recording mode (task 6e08239a): the word list follows the member to
  // every device, so it lives on their record and must survive a restart.
  it("round-trips the recording mode word list through a cold restart, and leaves the other preferences alone", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
    await putPrefs(server, owner.rawSessionId, { language: "es" });
    const words = [
      { word: "Acme", standIn: "Client" },
      { word: "Jo Park", standIn: "Sam" },
    ];
    expect(
      await putPrefs(server, owner.rawSessionId, { recordingWords: words }),
    ).toBe(204);
    server = await server.restart();
    const rec = getUserByName("Morgan")!;
    expect(rec.recordingWords).toEqual(words);
    expect(rec.language).toBe("es");
    // An empty list is a choice too (the member removed the office row), not
    // "never saved".
    expect(
      await putPrefs(server, owner.rawSessionId, { recordingWords: [] }),
    ).toBe(204);
    expect(getUserByName("Morgan")!.recordingWords).toEqual([]);
  });

  it("language: null clears an earlier pick", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
    await putPrefs(server, owner.rawSessionId, { language: "es" });

    // An explicit null clears it.
    expect(await putPrefs(server, owner.rawSessionId, { language: null })).toBe(
      204,
    );
    expect(getUserByName("Morgan")!.language).toBe(null);
  });
});

describe("prefs.update - self scoping", () => {
  it("a member's write lands on their own record, never the owner's", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
    const member = await server.seedMember("Mia");

    expect(
      await putPrefs(server, member.rawSessionId, { language: "es" }),
    ).toBe(204);
    expect(getUserByName(member.username)!.language).toBe("es");
    expect(getUserByName("Morgan")!.language).toBe(null);
    // And the owner's own write doesn't touch the member's.
    await putPrefs(server, owner.rawSessionId, { language: "en" });
    expect(getUserByName("Morgan")!.language).toBe("en");
    expect(getUserByName(member.username)!.language).toBe("es");
  });
});

describe("prefs.update - value validation", () => {
  it("rejects an unsupported language code", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");

    expect(await putPrefs(server, owner.rawSessionId, { language: "fr" })).toBe(
      422,
    );
    expect(await putPrefs(server, owner.rawSessionId, { language: 7 })).toBe(
      422,
    );
    // Nothing was written by any of the rejected calls.
    const rec = getUserByName("Morgan")!;
    expect(rec.language).toBe(null);
  });

  // A primitive body is legal JSON, and `"language" in body` THROWS on one -
  // a 500 where a 422 belongs. An array is an object but never a valid update.
  it("rejects primitive and array bodies with 422, not 500", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
    for (const body of [7, "x", true, ["language"], null]) {
      expect(await putPrefs(server, owner.rawSessionId, body)).toBe(422);
    }
  });

  // The worst answer to a typo is 204: the user watches Save succeed and
  // nothing happen. turnEndPush is a retired key (task 0c3fa26f), refused like
  // any unknown one.
  it("rejects an unknown key and an empty update", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
    for (const body of [
      { langauge: "es" },
      { language: "es", nope: 1 },
      { turnEndPush: true },
      {},
    ])
      expect({
        body,
        status: await putPrefs(server, owner.rawSessionId, body),
      }).toEqual({ body, status: 422 });
    expect(getUserByName("Morgan")!.language).toBe(null);
  });

  // The store drops a bad voice value silently, so only the route stands
  // between a typo and a 204 that saved nothing.
  it("rejects a voice value it does not know, and writes nothing", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
    for (const body of [
      { voiceInput: "google" },
      { voiceInput: "OpenAI" },
      { voiceInput: null },
      { voiceInput: 1 },
      { voiceOutput: "google" },
      { voiceOutput: null },
      { voiceName: "robot" },
      { voiceName: "Cedar" },
      { voiceName: null },
      // A bad field refuses the whole write.
      { language: "es", voiceInput: "google" },
      { voiceOutput: "openai", voiceName: "robot" },
    ]) {
      expect({
        body,
        status: await putPrefs(server, owner.rawSessionId, body),
      }).toEqual({ body, status: 422 });
    }
    const rec = getUserByName("Morgan")!;
    expect(rec.language).toBe(null);
    expect(rec.voiceInput ?? "browser").toBe("browser");
    expect(rec.voiceOutput ?? "browser").toBe("browser");
    expect(rec.voiceName).toBeUndefined();
  });
});

describe("prefs.update - recording mode words", () => {
  async function putWords(
    srv: TestServer,
    rawSessionId: string,
    recordingWords: unknown,
  ) {
    const resp = await srv.http("/api/me/preferences", {
      method: "PATCH",
      rawSessionId,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recordingWords }),
    });
    const body = (await resp.json().catch(() => null)) as {
      error?: { code?: string };
    } | null;
    return { status: resp.status, code: body?.error?.code };
  }

  // The same check as the Settings card (recordingWordsProblem): a chain or
  // a duplicate the browser refuses must not land through the API either.
  it("refuses a bad shape or a bad list with invalid_recording_words, and writes nothing", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
    const saved = [{ word: "Acme", standIn: "Client" }];
    expect((await putWords(server, owner.rawSessionId, saved)).status).toBe(
      204,
    );
    for (const recordingWords of [
      "Acme",
      null,
      [{ word: "Acme" }],
      [{ word: 1, standIn: "Client" }],
      [["Acme", "Client"]],
      [{ word: "", standIn: "Client" }],
      [{ word: "Acme", standIn: "" }],
      [
        { word: "Acme", standIn: "Client" },
        { word: "ACME", standIn: "Other" },
      ],
      [
        { word: "Acme", standIn: "Bolt" },
        { word: "Bolt", standIn: "Crux" },
      ],
      Array.from({ length: 201 }, (_, i) => ({
        word: `w${i}`,
        standIn: `s${i}`,
      })),
    ]) {
      const got = await putWords(server, owner.rawSessionId, recordingWords);
      expect({ recordingWords, got }).toEqual({
        recordingWords,
        got: { status: 422, code: "invalid_recording_words" },
      });
    }
    expect(getUserByName("Morgan")!.recordingWords).toEqual(saved);
  });
});

// The UI is event-authoritative: PreferencesPane reads the record out of the
// store, so a write that persists but never fans out looks like a Save that
// did nothing. These pin the audiences.
describe("prefs.update - live event contract", () => {
  const bag = (sock: TestSocket, type: string): Record<string, unknown>[] =>
    (sock.messages as Record<string, unknown>[]).filter((m) => m.type === type);
  // The write emits before it answers, and a socket keeps order: once the
  // pong for a later ping is in, every event of the write is too.
  async function fence(sock: TestSocket): Promise<void> {
    const before = bag(sock, "pong").length;
    sock.send({ type: "ping" });
    const deadline = Date.now() + 2000;
    while (bag(sock, "pong").length <= before) {
      if (Date.now() > deadline) throw new Error("fence timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  it("subject gets user_self_updated, owners get user_admin_updated, and the private fields never ride a public event", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
    const member = await server.seedMember("Mia");
    const ownerSock = await server.connectWs(owner.rawSessionId);
    const memberSock = await server.connectWs(member.rawSessionId);
    await ownerSock.waitFor("presence_list");
    await memberSock.waitFor("presence_list");

    for (const [field, value] of [
      ["language", "es"],
      ["voiceInput", "openai"],
      ["recordingWords", [{ word: "Zyxquorp", standIn: "Client" }]],
    ] as const) {
      // Ignore earlier events; only events caused by this write count.
      const beforeSelf = bag(memberSock, "user_self_updated").length;
      const beforeAdmin = bag(ownerSock, "user_admin_updated").length;
      expect(
        await putPrefs(server, member.rawSessionId, { [field]: value }),
      ).toBe(204);
      await fence(memberSock);
      await fence(ownerSock);

      // The subject's own sockets get their full record - this is what makes
      // the pane authoritative on their other devices.
      const selfEvents = bag(memberSock, "user_self_updated").slice(beforeSelf);
      expect(selfEvents.length).toBe(1);
      expect((selfEvents[0].user as Record<string, unknown>)[field]).toEqual(
        value,
      );

      // Owners get it on the owners-only admin channel.
      const adminEvents = bag(ownerSock, "user_admin_updated").slice(
        beforeAdmin,
      );
      expect(adminEvents.length).toBe(1);
      expect((adminEvents[0].user as Record<string, unknown>)[field]).toEqual(
        value,
      );
    }

    // And NOTHING rides the all-audience public channels: no preference is in
    // UserPublicWire, so a public event would carry no delta and would only
    // broadcast the timing of someone's private edit.
    expect(bag(ownerSock, "user_updated").length).toBe(0);
    expect(bag(memberSock, "user_updated").length).toBe(0);
    // users_list arrives once at connect hydration; the writes must not add one.
    expect(bag(ownerSock, "users_list").length).toBe(1);
    expect(bag(memberSock, "users_list").length).toBe(1);
    // The word list names customers and people: a member who connects after
    // the write sees the roster, never the list.
    const bystander = await server.seedMember("Olly");
    const bystanderSock = await server.connectWs(bystander.rawSessionId);
    const roster = await bystanderSock.waitFor("users_list");
    expect(JSON.stringify(roster)).toContain(member.username);
    expect(JSON.stringify(roster)).not.toContain("Zyxquorp");
    bystanderSock.close();
    ownerSock.close();
    memberSock.close();
  });
});

// GET /api/users/:username/recording-words (task 6e08239a): the OCR check of
// a demo video reads the member's list. The list names customers and people,
// so it has the secrets gate of memberVoice.get: the member, an owner, and
// their API tokens and privileged agents; nobody else.
describe("memberRecordingWords.get", () => {
  async function get(srv: TestServer, path: string, auth: Auth) {
    const resp = await srv.http(path, {
      method: "GET",
      rawSessionId: auth.session,
      headers: auth.bearer ? { Authorization: `Bearer ${auth.bearer}` } : {},
    });
    const text = await resp.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // An error page.
    }
    return { status: resp.status, body };
  }
  type Auth = { session?: string; bearer?: string };

  async function office() {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Mia");
    const other = await srv.seedMember("Olly");
    const idOf = (name: string) => getUserByName(name)!.id;
    const api = async (name: string) =>
      (
        await mintApiToken({
          userId: idOf(name),
          name: "API",
          expiresInDays: null,
        })
      ).token;
    return {
      srv,
      owner,
      member,
      other,
      memberApi: await api(member.username),
      ownerApi: await api(owner.username),
      otherApi: await api(other.username),
      memberAgent: mintAgentToken("rec-member", idOf(member.username), true),
      memberPlainAgent: mintAgentToken(
        "rec-plain",
        idOf(member.username),
        false,
      ),
      ownerAgent: mintAgentToken("rec-owner", idOf(owner.username), true),
      otherAgent: mintAgentToken("rec-other", idOf(other.username), true),
      path: `/api/users/${member.username}/recording-words`,
    };
  }

  async function setOfficeName(srv: TestServer, session: string, name: string) {
    const read = await srv.http("/api/office/settings", {
      rawSessionId: session,
    });
    const { version } = (await read.json()) as { version: string };
    const put = await srv.http("/api/office/settings", {
      method: "PUT",
      rawSessionId: session,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version, name }),
    });
    expect(put.status).toBe(204);
  }

  it("gives the member's saved list to the member, an owner, and their tokens and privileged agents", async () => {
    const o = await office();
    const words = [{ word: "Acme", standIn: "Client" }];
    expect(
      await putPrefs(o.srv, o.member.rawSessionId, { recordingWords: words }),
    ).toBe(204);
    for (const [who, auth] of [
      ["member cookie", { session: o.member.rawSessionId }],
      ["member api token", { bearer: o.memberApi }],
      ["member privileged agent", { bearer: o.memberAgent }],
      ["owner cookie", { session: o.owner.rawSessionId }],
      ["owner api token", { bearer: o.ownerApi }],
      ["owner privileged agent", { bearer: o.ownerAgent }],
    ] as const) {
      const r = await get(o.srv, o.path, auth);
      expect({ who, r }).toEqual({ who, r: { status: 200, body: { words } } });
    }
  });

  it("refuses another member, their agent and an agent that is not privileged, and 404s an unknown member", async () => {
    const o = await office();
    expect(
      await putPrefs(o.srv, o.member.rawSessionId, {
        recordingWords: [{ word: "Zyxquorp", standIn: "Client" }],
      }),
    ).toBe(204);
    for (const [who, auth] of [
      ["other member cookie", { session: o.other.rawSessionId }],
      ["other member api token", { bearer: o.otherApi }],
      ["other member privileged agent", { bearer: o.otherAgent }],
      ["member plain agent", { bearer: o.memberPlainAgent }],
    ] as const) {
      const r = await get(o.srv, o.path, auth);
      expect({ who, status: r.status }).toEqual({ who, status: 403 });
      expect(JSON.stringify(r.body)).not.toContain("Zyxquorp");
    }
    const unknown = await get(o.srv, "/api/users/Nobody/recording-words", {
      session: o.owner.rawSessionId,
    });
    expect(unknown.status).toBe(404);
  });

  it("gives the default list, the office name row, to a member who never saved one", async () => {
    const o = await office();
    await setOfficeName(o.srv, o.owner.rawSessionId, "Quillfern Works");
    const r = await get(o.srv, o.path, { session: o.member.rawSessionId });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ words: defaultRecordingWords("Quillfern Works") });
    expect((r.body as { words: unknown[] }).words).toHaveLength(1);
    // A saved empty list is not "never saved".
    expect(
      await putPrefs(o.srv, o.member.rawSessionId, { recordingWords: [] }),
    ).toBe(204);
    const after = await get(o.srv, o.path, { session: o.member.rawSessionId });
    expect(after.body).toEqual({ words: [] });
  });
});
