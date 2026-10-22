// The plain-text form of the message routes (task dbc546b5): a text/plain body
// is the message text and steer, deliverAt and clientMessageId ride the query.
// Drives the real HTTP server, auth and /api executor. The query parser's
// edge cases are unit-tested in shared/plain-text-form.test.ts.

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./harness.ts";
import { getAgentTokenRaw, mintAgentToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import type { AgentInfo, ScheduledMessageEntry } from "../../shared/types.ts";
import type { ApiTokenCreateRes } from "../../shared/contract-shapes.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

// Quotes, backslashes, a tab, inner line breaks, non-ASCII and shell
// metacharacters: everything a JSON body or shell quoting would mangle.
const TEXT =
  'He said "ship it" \\o/ - C:\\new\\table\n\tsecond line ünï 日本 🚀\n$HOME `date` {"text":"not a field"}';

async function setup(): Promise<{
  srv: TestServer;
  ownerSession: string;
  sender: AgentInfo;
  receiver: AgentInfo;
}> {
  const srv = await startTestServer();
  server = srv;
  const owner = await srv.seedOwner("Nil");
  const room = srv.agentManager.getRooms()[0].id;
  const spawn = async (name: string) => {
    const info = await srv.agentManager.spawn(
      name,
      srv.stateRoot,
      "default",
      undefined,
      undefined,
      room,
    );
    if (!info) throw new Error(`spawn ${name} returned null`);
    return info;
  };
  return {
    srv,
    ownerSession: owner.rawSessionId,
    sender: await spawn("Sender"),
    receiver: await spawn("Receiver"),
  };
}

type Sent = {
  status: number;
  headers: Headers;
  body: Record<string, unknown> & {
    error?: { code: string; message?: string };
  };
};

async function post(
  srv: TestServer,
  path: string,
  init: {
    agentId?: string;
    bearer?: string;
    rawSessionId?: string;
    contentType?: string;
    body: string;
    headers?: Record<string, string>;
  },
): Promise<Sent> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.contentType !== undefined)
    headers["Content-Type"] = init.contentType;
  const bearer =
    init.bearer ??
    (init.agentId ? (getAgentTokenRaw(init.agentId) ?? undefined) : undefined);
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  // A Blob body keeps fetch from adding its own Content-Type, so a test can
  // send no Content-Type at all.
  const res = await srv.http(path, {
    method: "POST",
    headers,
    body: new Blob([init.body]),
    rawSessionId: init.rawSessionId,
  });
  let body: Sent["body"] = {};
  try {
    body = (await res.json()) as Sent["body"];
  } catch {
    body = {};
  }
  return { status: res.status, headers: res.headers, body };
}

function delivered(srv: TestServer, agentId: string): string[] {
  return (srv.fakeBackend.sessionForAgent(agentId)?.sent ?? []).map(
    (m) => m.text,
  );
}

async function waitForDelivery(
  srv: TestServer,
  agentId: string,
  count = 1,
): Promise<string[]> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const texts = delivered(srv, agentId);
    if (texts.length >= count) return texts;
    if (Date.now() > deadline) throw new Error("delivery timed out");
    await Bun.sleep(5);
  }
}

const inOneHour = () => new Date(Date.now() + 3_600_000).toISOString();

describe("POST /api/agents/:id/messages with Content-Type: text/plain", () => {
  it("delivers the body verbatim, minus the heredoc's one trailing line break", async () => {
    const { srv, sender, receiver } = await setup();
    const r = await post(srv, `/api/agents/${receiver.id}/messages`, {
      agentId: sender.id,
      contentType: "text/plain; charset=utf-8",
      body: `${TEXT}\n`,
    });
    expect(r.status).toBe(200);
    expect(r.body.messageId).toBeString();
    // A plain send carries no steer outcome.
    expect("steered" in r.body).toBe(false);
    const [prompt] = await waitForDelivery(srv, receiver.id);
    // The sender label is a prefix; the message itself ends the prompt.
    expect(prompt.endsWith(` ${TEXT}`)).toBe(true);
  });

  it("delivers a member's text/plain message too", async () => {
    const { srv, ownerSession, receiver } = await setup();
    const r = await post(srv, `/api/agents/${receiver.id}/messages`, {
      rawSessionId: ownerSession,
      contentType: "text/plain",
      body: TEXT,
    });
    expect(r.status).toBe(200);
    const [prompt] = await waitForDelivery(srv, receiver.id);
    expect(prompt.endsWith(TEXT)).toBe(true);
  });

  it("reads steer=1 from the query", async () => {
    const { srv, sender, receiver } = await setup();
    const r = await post(srv, `/api/agents/${receiver.id}/messages?steer=1`, {
      agentId: sender.id,
      contentType: "text/plain",
      body: "urgent",
    });
    expect(r.status).toBe(200);
    // Only a send that asked to steer reports a steer outcome (an idle
    // receiver: steered false).
    expect(r.body.steered).toBe(false);
  });

  it("schedules with deliverAt from the query, a raw + offset included", async () => {
    const { srv, sender, receiver } = await setup();
    const utc = new Date(Date.now() + 3_600_000);
    utc.setUTCMilliseconds(0);
    const offsetForm = new Date(utc.getTime() + 2 * 3_600_000)
      .toISOString()
      .replace("Z", "+02:00");
    expect(offsetForm).toContain("+");
    const r = await post(
      srv,
      `/api/agents/${receiver.id}/messages?deliverAt=${offsetForm}`,
      { agentId: sender.id, contentType: "text/plain", body: `${TEXT}\n` },
    );
    expect(r.status).toBe(200);
    expect(r.body.deliverAt).toBe(utc.toISOString());
    const persisted = JSON.parse(
      readFileSync(join(srv.stateRoot, "scheduled-messages.json"), "utf-8"),
    ) as ScheduledMessageEntry[];
    expect(persisted.map((e) => e.text)).toEqual([TEXT]);
  });

  it("dedupes a retry with the same clientMessageId from the query", async () => {
    const { srv, sender, receiver } = await setup();
    const send = () =>
      post(srv, `/api/agents/${receiver.id}/messages?clientMessageId=retry-1`, {
        agentId: sender.id,
        contentType: "text/plain",
        body: "once",
      });
    const first = await send();
    expect(first.status).toBe(200);
    expect("queued" in first.body).toBe(true);
    await waitForDelivery(srv, receiver.id);
    const second = await send();
    expect(second.status).toBe(200);
    // A deduped retry touched no queue, so its ack reports no queued state.
    expect("queued" in second.body).toBe(false);
    await Bun.sleep(50);
    expect(delivered(srv, receiver.id)).toHaveLength(1);
  });

  it("applies the handler's field rules to query options as to JSON fields", async () => {
    const { srv, ownerSession, sender, receiver } = await setup();
    const path = `/api/agents/${receiver.id}/messages`;
    const asAgent = (query: string) =>
      post(srv, `${path}${query}`, {
        agentId: sender.id,
        contentType: "text/plain",
        body: "x",
      });
    const both = await asAgent(`?steer=1&deliverAt=${inOneHour()}`);
    expect(both.status).toBe(400);
    expect(both.body.error?.code).toBe("steer_with_deliver_at");
    const badTime = await asAgent("?deliverAt=tomorrow");
    expect(badTime.status).toBe(400);
    expect(badTime.body.error?.code).toBe("invalid_deliver_at");
    const memberSteer = await post(srv, `${path}?steer=1`, {
      rawSessionId: ownerSession,
      contentType: "text/plain",
      body: "x",
    });
    expect(memberSteer.status).toBe(400);
    expect(memberSteer.body.error?.code).toBe("steer_not_supported");
  });

  it("refuses a malformed query with 422 invalid_request before sending", async () => {
    const { srv, sender, receiver } = await setup();
    for (const query of [
      "?steer=yes",
      "?steer",
      "?steer=1&steer=1",
      "?stear=1",
      "?deliverAt=%ZZ",
    ]) {
      const r = await post(srv, `/api/agents/${receiver.id}/messages${query}`, {
        agentId: sender.id,
        contentType: "text/plain",
        body: "x",
      });
      expect(r.status).toBe(422);
      expect(r.body.error?.code).toBe("invalid_request");
    }
    await Bun.sleep(50);
    expect(delivered(srv, receiver.id)).toHaveLength(0);
  });

  it("refuses an option in the query of a JSON, form-encoded or untyped request", async () => {
    const { srv, sender, receiver } = await setup();
    for (const contentType of [
      "application/json",
      "application/x-www-form-urlencoded",
      undefined,
    ]) {
      const r = await post(srv, `/api/agents/${receiver.id}/messages?steer=1`, {
        agentId: sender.id,
        contentType,
        body: JSON.stringify({ text: "x" }),
      });
      expect(r.status).toBe(422);
      expect(r.body.error?.code).toBe("invalid_request");
      expect(r.body.error?.message).toContain("text/plain");
    }
    await Bun.sleep(50);
    expect(delivered(srv, receiver.id)).toHaveLength(0);
  });

  it("still ignores an undeclared query parameter on JSON", async () => {
    const { srv, sender, receiver } = await setup();
    const r = await post(srv, `/api/agents/${receiver.id}/messages?foo=1`, {
      agentId: sender.id,
      contentType: "application/json",
      body: JSON.stringify({ text: "json still works" }),
    });
    expect(r.status).toBe(200);
    const [prompt] = await waitForDelivery(srv, receiver.id);
    expect(prompt.endsWith("json still works")).toBe(true);
  });

  it("gives an empty text/plain body the same outcome as an empty JSON text", async () => {
    const { srv, ownerSession, sender, receiver } = await setup();
    const path = `/api/agents/${receiver.id}/messages`;
    // An agent's empty JSON text is a 400 invalid_text. A member's is accepted
    // (the composer sends an image with no caption), so the member pins the
    // other outcome: the two forms agree either way.
    for (const [auth, status] of [
      [{ agentId: sender.id }, 400],
      [{ rawSessionId: ownerSession }, 200],
    ] as const) {
      const json = await post(srv, path, {
        ...auth,
        contentType: "application/json",
        body: JSON.stringify({ text: "" }),
      });
      expect(json.status).toBe(status);
      if (status === 400) expect(json.body.error?.code).toBe("invalid_text");
      for (const body of ["", "\n", "\r\n"]) {
        const plain = await post(srv, path, {
          ...auth,
          contentType: "text/plain",
          body,
        });
        expect(plain.status).toBe(json.status);
        expect(plain.body.error?.code).toBe(json.body.error?.code);
      }
    }
  });

  it("reads JSON sent as text/plain (fetch's default type) as JSON", async () => {
    const { srv, sender, receiver } = await setup();
    const r = await post(srv, `/api/agents/${receiver.id}/messages`, {
      agentId: sender.id,
      contentType: "text/plain;charset=UTF-8",
      body: JSON.stringify({ text: "inner text", steer: true }),
    });
    expect(r.status).toBe(200);
    // Every JSON field reaches the handler, steer included.
    expect(r.body.steered).toBe(false);
    const [prompt] = await waitForDelivery(srv, receiver.id);
    expect(prompt.endsWith(" inner text")).toBe(true);
  });

  it("keeps a JSON-looking body verbatim when an option is in the query or text is not a string", async () => {
    const { srv, sender, receiver } = await setup();
    const withOption = JSON.stringify({ text: "inner" });
    const notString = JSON.stringify({ text: 5 });
    const a = await post(srv, `/api/agents/${receiver.id}/messages?steer=1`, {
      agentId: sender.id,
      contentType: "text/plain",
      body: withOption,
    });
    expect(a.status).toBe(200);
    const b = await post(srv, `/api/agents/${receiver.id}/messages`, {
      agentId: sender.id,
      contentType: "text/plain",
      body: notString,
    });
    expect(b.status).toBe(200);
    // The receiver may coalesce the two sends into one prompt or take them in
    // two turns: wait until both texts arrived either way.
    const deadline = Date.now() + 2_000;
    let all = "";
    while (
      !(all.includes(` ${withOption}`) && all.includes(` ${notString}`)) &&
      Date.now() < deadline
    ) {
      await Bun.sleep(5);
      all = delivered(srv, receiver.id).join("\n");
    }
    expect(all).toContain(` ${withOption}`);
    expect(all).toContain(` ${notString}`);
  });

  it("fingerprints the options for Idempotency-Key: a changed steer conflicts, an identical request replays", async () => {
    const { srv, sender, receiver } = await setup();
    const send = (query: string) =>
      post(srv, `/api/agents/${receiver.id}/messages${query}`, {
        agentId: sender.id,
        contentType: "text/plain",
        body: "same text",
        headers: { "Idempotency-Key": "key-1" },
      });
    const first = await send("");
    expect(first.status).toBe(200);
    const changed = await send("?steer=1");
    expect(changed.status).toBe(409);
    expect(changed.body.error?.code).toBe("idempotency_conflict");
    const again = await send("");
    expect(again.status).toBe(200);
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    expect(again.body.messageId).toBe(first.body.messageId);
  });
});

describe("POST /api/api-token-inboxes/:tokenId/messages with Content-Type: text/plain", () => {
  async function inboxSetup() {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const ownerId = getUserByName(owner.username)!.id;
    const room = srv.agentManager.getRooms()[0].id;
    const sender = await srv.agentManager.spawn(
      "Worker",
      srv.stateRoot,
      "default",
      0,
      undefined,
      room,
      undefined,
      undefined,
      undefined,
      owner.username,
      "claude",
      undefined,
      ownerId,
    );
    if (!sender) throw new Error("spawn failed");
    const minted = await srv.http("/api/me/api-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Phone", expiresInDays: null }),
      rawSessionId: owner.rawSessionId,
    });
    const token = ((await minted.json()) as ApiTokenCreateRes).apiToken.id;
    return {
      srv,
      sender,
      bearer: mintAgentToken(sender.id, ownerId),
      path: `/api/api-token-inboxes/${token}/messages`,
    };
  }

  it("delivers the body verbatim", async () => {
    const { srv, sender, bearer, path } = await inboxSetup();
    const r = await post(srv, path, {
      bearer,
      contentType: "text/plain",
      body: `${TEXT}\n`,
    });
    expect(r.status).toBe(200);
    expect(srv.agentManager.getAgentLogs(sender.id).at(-1)).toMatchObject({
      kind: "api_token_outbound",
      content: TEXT,
    });
  });

  it("refuses any query parameter, the route declares none", async () => {
    const { srv, bearer, path } = await inboxSetup();
    const r = await post(srv, `${path}?steer=1`, {
      bearer,
      contentType: "text/plain",
      body: "x",
    });
    expect(r.status).toBe(422);
    expect(r.body.error?.code).toBe("invalid_request");
  });

  it("gives an empty text/plain body the same error as an empty JSON text", async () => {
    const { srv, bearer, path } = await inboxSetup();
    const json = await post(srv, path, {
      bearer,
      contentType: "application/json",
      body: JSON.stringify({ text: "" }),
    });
    expect(json.status).toBe(400);
    expect(json.body.error?.code).toBe("invalid_text");
    for (const body of ["", "\n", "\r\n"]) {
      const plain = await post(srv, path, {
        bearer,
        contentType: "text/plain",
        body,
      });
      expect(plain.status).toBe(json.status);
      expect(plain.body.error?.code).toBe(json.body.error?.code);
    }
  });
});
