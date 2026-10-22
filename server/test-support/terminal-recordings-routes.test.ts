// The terminal recording routes (task 749cb7fd, slice c):
// GET /api/terminal-recordings[?agentId=] and GET /api/terminal-recordings/:id.
// The readers are the audit log's: an owner, and an agent or API token with
// owner reach. The file comes back as a download that a browser never renders.

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "fs";

import { mintAgentToken } from "../identity/tokens.ts";
import { mintApiToken } from "../api-tokens.ts";
import { getUserByName } from "../users.ts";
import {
  startTerminalRecording,
  terminalRecordingPath,
  type TerminalRecording,
} from "../terminal-recorder.ts";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer | null = null;
const open: TerminalRecording[] = [];
afterEach(async () => {
  for (const recording of open.splice(0)) await recording.close();
  await server?.stop();
  server = null;
});

async function get(
  srv: TestServer,
  path: string,
  as: { session?: string; bearer?: string },
) {
  return srv.http(path, {
    headers: as.bearer ? { Authorization: `Bearer ${as.bearer}` } : {},
    rawSessionId: as.session,
  });
}

interface Item {
  id: string;
  agentId: string;
  startedAt: number;
  startedBy: { id: string };
  bytes: number;
  endedAt?: number;
}

async function office() {
  server = await startTestServer();
  const srv = server;
  const morgan = await srv.seedOwner("Morgan");
  const member = await srv.seedMember("Member");
  const morganId = getUserByName(morgan.username)!.id;
  const memberId = getUserByName(member.username)!.id;
  const alice = { kind: "member" as const, id: morganId, name: "Morgan" };
  const record = (agentId: string, start: number) => {
    const recording = startTerminalRecording({
      agentId,
      cols: 80,
      rows: 24,
      startedBy: alice,
      root: srv.stateRoot,
      now: () => start,
    });
    open.push(recording);
    return recording;
  };
  const { token: ownerApi } = await mintApiToken({
    userId: morganId,
    name: "Morgan token",
    expiresInDays: null,
  });
  const { token: memberApi } = await mintApiToken({
    userId: memberId,
    name: "Member token",
    expiresInDays: null,
  });
  return {
    srv,
    morgan,
    member,
    morganId,
    record,
    readers: {
      owner: { session: morgan.rawSessionId },
      "owner's privileged agent": {
        bearer: mintAgentToken("morgan-privileged", morganId, true),
      },
      "owner's API token": { bearer: ownerApi },
    },
    refused: {
      member: { session: member.rawSessionId },
      "member's privileged agent": {
        bearer: mintAgentToken("member-privileged", memberId, true),
      },
      "member's API token": { bearer: memberApi },
      "owner's ordinary agent": {
        bearer: mintAgentToken("morgan-plain", morganId, false),
      },
    },
  };
}

describe("who reads terminal recordings", () => {
  it("the audit log's readers list and read them; every other caller gets 403", async () => {
    const o = await office();
    const recording = o.record("agent-a", Date.now());
    recording.output("$ ls\r\n");
    await recording.close();
    for (const [who, as] of Object.entries(o.readers)) {
      const list = await get(o.srv, "/api/terminal-recordings", as);
      expect(list.status, who).toBe(200);
      const { items } = (await list.json()) as { items: Item[] };
      expect(
        items.map((item) => item.id),
        who,
      ).toEqual([recording.id]);
      const file = await get(
        o.srv,
        `/api/terminal-recordings/${recording.id}`,
        as,
      );
      expect(file.status, who).toBe(200);
    }
    for (const [who, as] of Object.entries(o.refused)) {
      const list = await get(o.srv, "/api/terminal-recordings", as);
      expect(list.status, who).toBe(403);
      const file = await get(
        o.srv,
        `/api/terminal-recordings/${recording.id}`,
        as,
      );
      expect(file.status, who).toBe(403);
      expect(await file.text(), who).not.toContain("$ ls");
    }
  });
});

describe("the list", () => {
  it("is newest first, says which recordings ended, and filters by agent", async () => {
    const o = await office();
    const t0 = Date.now() - 60_000;
    const first = o.record("agent-a", t0);
    const second = o.record("agent-b", t0 + 1_000);
    const live = o.record("agent-a", t0 + 2_000);
    await first.close();
    await second.close();
    live.output("still going\r\n");
    await live.flush();

    const all = await get(o.srv, "/api/terminal-recordings", o.readers.owner);
    const { items } = (await all.json()) as { items: Item[] };
    expect(items.map((item) => item.id)).toEqual([
      live.id,
      second.id,
      first.id,
    ]);
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get(first.id)).toMatchObject({
      agentId: "agent-a",
      startedAt: t0,
      startedBy: { id: o.morganId },
      endedAt: t0,
    });
    expect(byId.get(live.id)).not.toHaveProperty("endedAt");
    expect(byId.get(live.id)!.bytes).toBe(
      readFileSync(terminalRecordingPath(live.id, o.srv.stateRoot)!).length,
    );

    const filtered = await get(
      o.srv,
      "/api/terminal-recordings?agentId=agent-a",
      o.readers.owner,
    );
    expect(
      ((await filtered.json()) as { items: Item[] }).items.map(
        (item) => item.id,
      ),
    ).toEqual([live.id, first.id]);
  });
});

describe("one recording", () => {
  it("comes back byte for byte as a download a browser does not render", async () => {
    const o = await office();
    const recording = o.record("agent-a", Date.now());
    // Output a browser would run if it rendered the file as a page.
    recording.output("<script>alert(1)</script>\r\n");
    await recording.close();
    const res = await get(
      o.srv,
      `/api/terminal-recordings/${recording.id}`,
      o.readers.owner,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith(
      "application/x-asciicast",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toStartWith("attachment");
    expect(await res.text()).toBe(
      readFileSync(
        terminalRecordingPath(recording.id, o.srv.stateRoot)!,
        "utf8",
      ),
    );
  });

  it("gets 404 for an id that is no recording, and never reads outside the folder", async () => {
    const o = await office();
    const recording = o.record("agent-a", Date.now());
    await recording.close();
    // The route is there: the real id reads.
    expect(
      (
        await get(
          o.srv,
          `/api/terminal-recordings/${recording.id}`,
          o.readers.owner,
        )
      ).status,
    ).toBe(200);
    const ids = [
      "tr-0000000000000000",
      recording.id.toUpperCase(),
      `${recording.id}.cast`,
      "..%2F..%2Foffice-config.json",
      `tr-..%2F${recording.id}`,
      "%2e%2e",
    ];
    for (const id of ids) {
      const res = await get(
        o.srv,
        `/api/terminal-recordings/${id}`,
        o.readers.owner,
      );
      expect(res.status, id).toBe(404);
    }
  });
});
