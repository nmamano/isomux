// The lobby elevator's floors over real HTTP (task 5a1891f9): the public
// office card, and floors.list / floors.add / floors.remove.
//
// What is pinned:
//   - The card answers with no identity, before the claim too, sets no cookie,
//     carries no CORS header, and is limited per forwarded client on a budget
//     of its own (the box is exempt).
//   - floors.add probes the card ON THE SERVER, at the normalised origin, with
//     no credentials. The name comes from the card, never from the body. An
//     office from before office cards (its auth wall answers the card path)
//     gets 422 office_outdated; every other probe failure is the same 422
//     office_unreachable. Neither saves anything. The probe follows no
//     redirect, and its timeout covers the body too.
//   - The duplicate check runs after the probe resolves, so two concurrent
//     adds of one origin save one floor.
//   - The cap, remove, the floors_updated event, full_state, and persistence
//     across a boot, including a damaged file.
//   - Reach: a member reads and writes, a privileged agent writes, a plain
//     agent gets 403.
//   - floors.name (task 42be5397): the card's name for an origin on the
//     member's elevator panel, probed on the server with no credentials. The
//     answer is shared: a second ask, by any member, sends no probe, failures
//     included. Every failure is one 422 office_unreachable without detail.
//     Past four probes in flight for one member: 429, with no probe.
//   - A ride to an office where the member is signed out: the login page keeps
//     the isomux-panel part of the address in sessionStorage, for the office
//     after sign-in.
//
// The probe targets are real local listeners, so the default fetch path is
// what runs; only the timeout is shortened.
//
// Seam: startTestServer(). Zero LLM.

import { afterEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "fs";
import { runInNewContext } from "vm";
import { join } from "path";
import type { Server } from "bun";
import { startTestServer, type TestServer } from "./harness.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import type { AgentInfo } from "../../shared/types.ts";
import {
  MAX_FLOORS,
  MAX_FLOOR_NAME_CHARS,
  OFFICE_CARD_PATH,
  type Floor,
} from "../../shared/floors.ts";
import {
  MAX_PANEL_FRAGMENT_CHARS,
  PANEL_HASH_KEY,
  PANEL_SESSION_KEY,
} from "../../shared/elevator-panel.ts";
import { OFFICE_NAME_MAX_IN_FLIGHT } from "../office-name-cache.ts";

const PROBE_TIMEOUT_MS = 300;

// A port nothing listens on, by construction: port 9 is below the ephemeral
// range, so no port-0 listener in the suite can get it, and below 1024, so a
// non-root test cannot bind it. A freed ephemeral port is not closed: another
// listener can take it before the probe runs (task 81b05c6c).
const CLOSED_ORIGIN = "http://127.0.0.1:9";

let server: TestServer | null = null;
const listeners: Server<unknown>[] = [];
afterEach(async () => {
  for (const l of listeners.splice(0)) await l.stop(true);
  await server?.stop();
  server = null;
});

interface Res {
  status: number;
  body: unknown;
}

async function api(
  srv: TestServer,
  method: string,
  path: string,
  init: { rawSessionId?: string; bearer?: string; body?: unknown } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.bearer) headers["Authorization"] = `Bearer ${init.bearer}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await srv.http(path, {
    method,
    headers,
    rawSessionId: init.rawSessionId,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

const errCode = (body: unknown): string | undefined =>
  (body as { error?: { code?: string } } | null)?.error?.code;
const floorOf = (body: unknown) => (body as { floor: Floor }).floor;
const floorsOf = (body: unknown) => (body as { floors: Floor[] }).floors;
// The floor a successful add returns. Asserts the 201 first: toEqual reads an
// array of undefined floors as equal to an empty list.
function added(res: Res): Floor {
  expect(res.status).toBe(201);
  return floorOf(res.body);
}

async function spawnAgent(srv: TestServer, name: string): Promise<AgentInfo> {
  const info = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    srv.agentManager.getRooms()[0].id,
    undefined,
    undefined,
    undefined,
    undefined,
    "claude",
  );
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

async function office() {
  const srv = await startTestServer({
    startServer: { officeProbe: { timeoutMs: PROBE_TIMEOUT_MS } },
  });
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const member = await srv.seedMember("Mia");
  const add = (url: unknown, rawSessionId = member.rawSessionId) =>
    api(srv, "POST", "/api/floors", { body: { url }, rawSessionId });
  const list = async () => {
    const res = await api(srv, "GET", "/api/floors", {
      rawSessionId: member.rawSessionId,
    });
    expect(res.status).toBe(200);
    return floorsOf(res.body);
  };
  return { srv, owner, member, add, list };
}

interface Listener {
  origin: string;
  // Every request the listener got, in arrival order.
  hits: { path: string; headers: Headers }[];
}

// A local HTTP listener that answers every request with `answer`.
function listen(
  answer: (req: Request) => Response | Promise<Response>,
): Listener {
  const hits: Listener["hits"] = [];
  const l = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      hits.push({ path: new URL(req.url).pathname, headers: req.headers });
      return answer(req);
    },
  });
  listeners.push(l);
  return { origin: `http://127.0.0.1:${l.port}`, hits };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// An office card, the way another office answers it.
const cardListener = (name: unknown = "Harbor") =>
  listen(() => json({ isomux: 1, name }));

describe("the office card", () => {
  it("answers with no identity before and after the claim, with no cookie and no CORS header", async () => {
    const srv = await startTestServer();
    server = srv;
    const read = async (rawSessionId?: string) => {
      const res = await srv.http(OFFICE_CARD_PATH, { rawSessionId });
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-type")).toContain("application/json");
      return res.json();
    };
    // Pre-claim: the card is not behind the claim gate.
    expect(await read()).toEqual({ isomux: 1, name: null });
    const owner = await srv.seedOwner("Morgan");
    srv.agentManager.setOfficeSettings(null, null, "Harbor HQ");
    expect(await read()).toEqual({ isomux: 1, name: "Harbor HQ" });
    // A signed-in browser gets the same card and no cookie either.
    expect(await read(owner.rawSessionId)).toEqual({
      isomux: 1,
      name: "Harbor HQ",
    });
  });

  it("limits each forwarded client on a budget of its own, and never the box", async () => {
    let srv = await startTestServer();
    server = srv;
    writeFileSync(
      join(srv.stateRoot, "office-config.json"),
      JSON.stringify({ trustedProxy: "same-host" }),
    );
    srv = await srv.restart();
    server = srv;
    // A fresh client per run: the limiter is module state that outlives a boot.
    const client = `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
    const forwarded = { headers: { "X-Forwarded-For": client } };
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++)
      statuses.push((await srv.http(OFFICE_CARD_PATH, forwarded)).status);
    expect(new Set(statuses.slice(0, -1))).toEqual(new Set([200]));
    expect(statuses.at(-1)).toBe(429);
    // The card's budget is not /readyz's: the updater's probe stays clear.
    expect((await srv.http("/readyz", forwarded)).status).toBe(200);
    // The box itself is exempt.
    expect((await srv.http(OFFICE_CARD_PATH)).status).toBe(200);
  });
});

describe("floors.add", () => {
  it("probes the card at the origin with no credentials, and takes the name from the card, never from the body", async () => {
    const { srv, member, list } = await office();
    const card = cardListener("Harbor");
    const res = await api(srv, "POST", "/api/floors", {
      body: { url: `${card.origin}/rooms/a?x=1`, name: "Spoofed" },
      rawSessionId: member.rawSessionId,
    });
    expect(res.status).toBe(201);
    const floor = floorOf(res.body);
    expect(floor.url).toBe(card.origin);
    expect(floor.name).toBe("Harbor");
    expect(typeof floor.id).toBe("string");
    expect(floor.id.length).toBeGreaterThan(0);
    expect(typeof floor.addedAt).toBe("number");
    expect(card.hits.map((h) => h.path)).toEqual([OFFICE_CARD_PATH]);
    expect(card.hits[0].headers.get("cookie")).toBeNull();
    expect(card.hits[0].headers.get("authorization")).toBeNull();
    expect(await list()).toEqual([floor]);
  });

  // The real card through the real probe: what one office serves, another
  // accepts. (The UI refuses its own origin; the server does not check.)
  it("accepts the card this office serves", async () => {
    const { srv, add } = await office();
    srv.agentManager.setOfficeSettings(null, null, "Harbor HQ");
    const res = await add(srv.baseUrl);
    expect(res.status).toBe(201);
    expect(floorOf(res.body).name).toBe("Harbor HQ");
    expect(floorOf(res.body).url).toBe(new URL(srv.baseUrl).origin);
  });

  it("trims the card's name, caps its length, and stores a blank one as null", async () => {
    const { add } = await office();
    const long = "N".repeat(MAX_FLOOR_NAME_CHARS + 50);
    for (const [cardName, check] of [
      ["  Harbor  ", (n: string | null) => expect(n).toBe("Harbor")],
      ["   ", (n: string | null) => expect(n).toBeNull()],
      [null, (n: string | null) => expect(n).toBeNull()],
      [
        long,
        (n: string | null) => {
          expect(n).not.toBeNull();
          expect(n!.length).toBeLessThanOrEqual(MAX_FLOOR_NAME_CHARS);
          expect(long.startsWith(n!)).toBe(true);
        },
      ],
    ] as const) {
      const res = await add(cardListener(cardName).origin);
      expect(res.status).toBe(201);
      check(floorOf(res.body).name);
    }
  });

  it("answers one 422 office_unreachable for every probe failure, and saves nothing", async () => {
    // The closed-port case is real only when a connect to it is refused. The
    // probe reads every fetch error as null, so also require the refusal to
    // come from the socket, not from a fetch that blocks the port up front.
    const refused = await fetch(CLOSED_ORIGIN + OFFICE_CARD_PATH).then(
      () => "answered",
      (err: { code?: string }) => err.code,
    );
    expect({ closedPort: CLOSED_ORIGIN, refused }).toEqual({
      closedPort: CLOSED_ORIGIN,
      refused: "ECONNREFUSED",
    });
    const { srv, member, add, list } = await office();
    const ws = await srv.connectWs(member.rawSessionId);
    const target = cardListener("Target");
    const failures: [string, Listener | string][] = [
      [
        "an HTML page",
        listen(
          () =>
            new Response("<html></html>", {
              headers: { "Content-Type": "text/html" },
            }),
        ),
      ],
      ["a 404", listen(() => new Response("nope", { status: 404 }))],
      [
        "a card with a 500 status",
        listen(() => json({ isomux: 1, name: "X" }, 500)),
      ],
      ["another version", listen(() => json({ isomux: 2, name: "X" }))],
      ["a name of the wrong type", listen(() => json({ isomux: 1, name: 5 }))],
      ["JSON that is not an object", listen(() => json([1]))],
      [
        "a redirect to a real card",
        listen(
          () =>
            new Response(null, {
              status: 302,
              headers: { Location: `${target.origin}${OFFICE_CARD_PATH}` },
            }),
        ),
      ],
      [
        "a card over the body cap",
        listen(() => json({ isomux: 1, name: "X", pad: "x".repeat(8192) })),
      ],
      ["no answer", listen(() => new Promise<Response>(() => {}))],
      [
        "headers and then a body that never ends",
        listen(
          () =>
            new Response(
              new ReadableStream({
                start(c) {
                  c.enqueue(new TextEncoder().encode('{"isomux":1,'));
                },
              }),
              { headers: { "Content-Type": "application/json" } },
            ),
        ),
      ],
      ["a closed port", CLOSED_ORIGIN],
    ];
    for (const [label, l] of failures) {
      const origin = typeof l === "string" ? l : l.origin;
      const res = await add(origin);
      expect({ label, status: res.status, code: errCode(res.body) }).toEqual({
        label,
        status: 422,
        code: "office_unreachable",
      });
      if (typeof l !== "string")
        expect({ label, hits: l.hits.length }).toEqual({ label, hits: 1 });
    }
    // The probe did not follow the redirect.
    expect(target.hits.length).toBe(0);
    expect(await list()).toEqual([]);
    // No event for a refused add: the first floors_updated is the next good one.
    const ok = await add(target.origin);
    expect(ok.status).toBe(201);
    const event = await ws.waitFor("floors_updated");
    expect(floorsOf(event)).toEqual([floorOf(ok.body)]);
    expect(
      ws.messages.filter(
        (m) => (m as { type?: string }).type === "floors_updated",
      ).length,
    ).toBe(1);
    ws.close();
  });

  // An office on a release before office cards (v2026.10.29 and older) has no
  // card route: the probe meets its auth wall, which answers a JSON caller
  // exactly this (server/auth-middleware.ts unauthorized(), the same bytes at
  // every tag from v2026.7.23 to v2026.10.29).
  it("answers 422 office_outdated for an office from before office cards, and saves nothing", async () => {
    const { srv, member, add, list } = await office();
    const ws = await srv.connectWs(member.rawSessionId);
    const wall = (
      body: string,
      status = 401,
      contentType = "application/json",
    ): Response =>
      new Response(body, {
        status,
        headers: { "Content-Type": contentType },
      });
    const WALL_BODY = JSON.stringify({ error: "unauthenticated" });

    const older = listen(() => wall(WALL_BODY));
    const res = await add(older.origin);
    expect({ status: res.status, code: errCode(res.body) }).toEqual({
      status: 422,
      code: "office_outdated",
    });
    expect(older.hits.map((h) => h.path)).toEqual([OFFICE_CARD_PATH]);

    // Each near miss changes one property of that answer, and is not an
    // Isomux office as far as the probe can tell.
    const nearMisses: [string, Listener][] = [
      [
        "the wall's sign-in page (HTML)",
        listen(() => wall("<html></html>", 401, "text/html")),
      ],
      [
        "the same body as text/plain",
        listen(() => wall(WALL_BODY, 401, "text/plain")),
      ],
      ["the same body with a 403", listen(() => wall(WALL_BODY, 403))],
      ["the same body with a 200", listen(() => wall(WALL_BODY, 200))],
      [
        "another error value",
        listen(() => wall(JSON.stringify({ error: "forbidden" }))),
      ],
      [
        "an extra key",
        listen(() =>
          wall(JSON.stringify({ error: "unauthenticated", detail: "x" })),
        ),
      ],
      [
        "the error as a bare string",
        listen(() => wall(JSON.stringify("unauthenticated"))),
      ],
      ["a body that is not JSON", listen(() => wall("unauthenticated"))],
      [
        // Whitespace keeps it the same JSON value: only the cap refuses it.
        "the same body over the body cap",
        listen(() => wall(" ".repeat(8192) + WALL_BODY)),
      ],
      [
        "the wall's headers and then a body that never ends",
        listen(
          () =>
            new Response(
              new ReadableStream({
                start(c) {
                  c.enqueue(new TextEncoder().encode('{"error":'));
                },
              }),
              {
                status: 401,
                headers: { "Content-Type": "application/json" },
              },
            ),
        ),
      ],
    ];
    for (const [label, l] of nearMisses) {
      const miss = await add(l.origin);
      expect({ label, status: miss.status, code: errCode(miss.body) }).toEqual({
        label,
        status: 422,
        code: "office_unreachable",
      });
      expect({ label, hits: l.hits.length }).toEqual({ label, hits: 1 });
    }

    expect(await list()).toEqual([]);
    // No event for a refused add: the first floors_updated is the next good one.
    const ok = await add(cardListener("Target").origin);
    expect(ok.status).toBe(201);
    const event = await ws.waitFor("floors_updated");
    expect(floorsOf(event)).toEqual([floorOf(ok.body)]);
    expect(
      ws.messages.filter(
        (m) => (m as { type?: string }).type === "floors_updated",
      ).length,
    ).toBe(1);
    ws.close();
  });

  it("refuses an address that is not an http(s) origin with 400, and probes nothing", async () => {
    const { add, list } = await office();
    const card = cardListener();
    const host = new URL(card.origin).host;
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,x",
      "ftp://files.example.com",
      `http://user:pw@${host}`,
      `${card.origin}/${"a".repeat(2100)}`,
      "",
      42,
      null,
    ]) {
      const res = await add(url);
      expect({ url, status: res.status, code: errCode(res.body) }).toEqual({
        url,
        status: 400,
        code: "invalid_request",
      });
    }
    expect(card.hits.length).toBe(0);
    expect(await list()).toEqual([]);
  });

  it("refuses an origin that is already a floor with 409 floor_exists, also for two adds at once", async () => {
    const { add, list } = await office();
    const card = cardListener();
    expect((await add(card.origin)).status).toBe(201);
    const again = await add(`${card.origin}/another/path`);
    expect(again.status).toBe(409);
    expect(errCode(again.body)).toBe("floor_exists");

    // Both adds are in flight while the probe waits, so a duplicate check
    // made before the probe passes for both.
    const slow = listen(async () => {
      await Bun.sleep(100);
      return json({ isomux: 1, name: "Slow" });
    });
    const both = await Promise.all([add(slow.origin), add(slow.origin)]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(slow.hits.length).toBe(2);
    expect((await list()).map((f) => f.url)).toEqual([
      card.origin,
      slow.origin,
    ]);
  });

  it("refuses a floor over the cap with 409 too_many_floors, and takes one again after a remove", async () => {
    const { srv, member } = await office();
    const stored: Floor[] = Array.from({ length: MAX_FLOORS }, (_, i) => ({
      id: `f${i}`,
      url: `https://office-${i}.example.com`,
      name: `Office ${i}`,
      addedAt: 1_000 + i,
    }));
    writeFileSync(join(srv.stateRoot, "floors.json"), JSON.stringify(stored));
    const next = await srv.restart();
    server = next;
    const card = cardListener();
    const add = () =>
      api(next, "POST", "/api/floors", {
        body: { url: card.origin },
        rawSessionId: member.rawSessionId,
      });
    const full = await add();
    expect(full.status).toBe(409);
    expect(errCode(full.body)).toBe("too_many_floors");
    expect(
      (
        await api(next, "DELETE", "/api/floors/f7", {
          rawSessionId: member.rawSessionId,
        })
      ).status,
    ).toBe(204);
    expect((await add()).status).toBe(201);
  });
});

describe("floors.remove", () => {
  it("removes a floor with 204 and an event, then answers 404 floor_not_found", async () => {
    const { srv, member, add, list } = await office();
    const a = added(await add(cardListener("A").origin));
    const b = added(await add(cardListener("B").origin));
    expect(await list()).toEqual([a, b]);
    const ws = await srv.connectWs(member.rawSessionId);
    const remove = (id: string) =>
      api(srv, "DELETE", `/api/floors/${id}`, {
        rawSessionId: member.rawSessionId,
      });
    expect((await remove(a.id)).status).toBe(204);
    expect(floorsOf(await ws.waitFor("floors_updated"))).toEqual([b]);
    expect(await list()).toEqual([b]);
    const gone = await remove(a.id);
    expect(gone.status).toBe(404);
    expect(errCode(gone.body)).toBe("floor_not_found");
    ws.close();
  });
});

describe("floors reach", () => {
  it("a member and a privileged agent write, a plain agent and no identity are refused", async () => {
    const { srv, owner, add, list } = await office();
    const plain = getAgentTokenRaw((await spawnAgent(srv, "Plain")).id)!;
    const ops = await spawnAgent(srv, "Ops");
    await srv.agentManager.setPrivileged(ops.id, true);
    const privileged = getAgentTokenRaw(ops.id)!;
    const card = cardListener();

    const byOwner = await add(card.origin, owner.rawSessionId);
    expect(byOwner.status).toBe(201);
    const id = floorOf(byOwner.body).id;

    const namePath = `/api/floors/name?url=${encodeURIComponent(card.origin)}`;
    for (const [method, path, body] of [
      ["GET", "/api/floors", undefined],
      ["POST", "/api/floors", { url: cardListener().origin }],
      ["DELETE", `/api/floors/${id}`, undefined],
      ["GET", namePath, undefined],
    ] as const) {
      const res = await api(srv, method, path, { bearer: plain, body });
      expect({ method, status: res.status }).toEqual({ method, status: 403 });
      const anon = await api(srv, method, path, { body });
      expect({ method, status: anon.status }).toEqual({ method, status: 401 });
    }

    const byAgent = await api(srv, "POST", "/api/floors", {
      bearer: privileged,
      body: { url: cardListener("Ops floor").origin },
    });
    expect(byAgent.status).toBe(201);
    expect((await list()).length).toBe(2);
    const nameByAgent = await api(srv, "GET", namePath, { bearer: privileged });
    expect(nameByAgent).toEqual({ status: 200, body: { name: "Harbor" } });
  });
});

const namePathOf = (url: string) =>
  `/api/floors/name?url=${encodeURIComponent(url)}`;

// Waits for a condition that a request in flight makes true.
async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(5);
  }
}

describe("floors.name", () => {
  it("answers the card's name, probed on the server with no credentials, once for every member", async () => {
    const { srv, owner, member } = await office();
    const ask = (url: string, rawSessionId = member.rawSessionId) =>
      api(srv, "GET", namePathOf(url), { rawSessionId });
    const card = cardListener("Harbor");
    expect(await ask(card.origin)).toEqual({
      status: 200,
      body: { name: "Harbor" },
    });
    expect(card.hits.map((h) => h.path)).toEqual([OFFICE_CARD_PATH]);
    expect(card.hits[0].headers.get("cookie")).toBeNull();
    expect(card.hits[0].headers.get("authorization")).toBeNull();
    // Another member, and the same origin with a path: the cached answer.
    expect(await ask(card.origin, owner.rawSessionId)).toEqual({
      status: 200,
      body: { name: "Harbor" },
    });
    expect(await ask(`${card.origin}/lobby`)).toEqual({
      status: 200,
      body: { name: "Harbor" },
    });
    expect(card.hits).toHaveLength(1);
    const blank = cardListener(null);
    expect(await ask(blank.origin)).toEqual({
      status: 200,
      body: { name: null },
    });
  });

  it("refuses an address that is not an http(s) origin with 400, and probes nothing", async () => {
    const { srv, member } = await office();
    const card = cardListener();
    const port = new URL(card.origin).port;
    for (const path of [
      "/api/floors/name",
      namePathOf("javascript:alert(1)"),
      namePathOf(`ftp://127.0.0.1:${port}`),
      namePathOf(`http://user:pw@127.0.0.1:${port}`),
    ]) {
      const res = await api(srv, "GET", path, {
        rawSessionId: member.rawSessionId,
      });
      expect({ path, status: res.status, code: errCode(res.body) }).toEqual({
        path,
        status: 400,
        code: "invalid_request",
      });
    }
    expect(card.hits).toEqual([]);
  });

  it("answers one 422 office_unreachable without detail for every failure, and keeps that answer too", async () => {
    const { srv, member } = await office();
    const ask = (url: string) =>
      api(srv, "GET", namePathOf(url), { rawSessionId: member.rawSessionId });
    // An office from before office cards: its auth wall answers the card path.
    const outdated = listen(() => json({ error: "unauthenticated" }, 401));
    const page = listen(
      () =>
        new Response("<!doctype html><title>Not an office</title>", {
          headers: { "Content-Type": "text/html" },
        }),
    );
    const answers = [
      await ask(CLOSED_ORIGIN),
      await ask(outdated.origin),
      await ask(page.origin),
    ];
    for (const res of answers) {
      expect(res.status).toBe(422);
      expect(errCode(res.body)).toBe("office_unreachable");
    }
    expect(answers[1].body).toEqual(answers[0].body);
    expect(answers[2].body).toEqual(answers[0].body);
    expect(outdated.hits).toHaveLength(1);
    expect((await ask(outdated.origin)).status).toBe(422);
    expect(outdated.hits).toHaveLength(1);
  });

  it("answers 429 too_many_requests past the probes one member may have in flight, without a probe", async () => {
    // A long probe timeout: the held probes must outlast the test's asks.
    const srv = await startTestServer({
      startServer: { officeProbe: { timeoutMs: 10_000 } },
    });
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Mia");
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const held = Array.from({ length: OFFICE_NAME_MAX_IN_FLIGHT }, (_, i) =>
      listen(async () => {
        await gate;
        return json({ isomux: 1, name: `Held ${i}` });
      }),
    );
    const pending = held.map((l) =>
      api(srv, "GET", namePathOf(l.origin), {
        rawSessionId: member.rawSessionId,
      }),
    );
    // Every held ask is at its probe; none answered without one.
    const early: Res[] = [];
    for (const p of pending) void p.then((res) => early.push(res));
    await until(
      () => early.length > 0 || held.every((l) => l.hits.length === 1),
    );
    expect(early).toEqual([]);
    const extra = cardListener("Extra");
    const refused = await api(srv, "GET", namePathOf(extra.origin), {
      rawSessionId: member.rawSessionId,
    });
    expect(refused.status).toBe(429);
    expect(errCode(refused.body)).toBe("too_many_requests");
    expect(extra.hits).toEqual([]);
    // Another member has probes of their own.
    expect(
      await api(srv, "GET", namePathOf(extra.origin), {
        rawSessionId: owner.rawSessionId,
      }),
    ).toEqual({ status: 200, body: { name: "Extra" } });
    open();
    const answers = await Promise.all(pending);
    expect(answers.map((a) => a.status)).toEqual(held.map(() => 200));
  });
});

describe("a ride to an office where the member is signed out", () => {
  it("the login page keeps the panel part of the address in sessionStorage, and only that part", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Morgan");
    // A browser's navigation asks for HTML; a JSON client gets the JSON 401.
    const res = await srv.http("/", { headers: { Accept: "text/html" } });
    expect(res.status).toBe(401);
    const html = await res.text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
      (m) => m[1],
    );
    const run = (hash: string) => {
      const stored = new Map<string, string>();
      const sessionStorage = {
        getItem: (k: string) => stored.get(k) ?? null,
        setItem: (k: string, value: string) => stored.set(k, String(value)),
        removeItem: (k: string) => stored.delete(k),
      };
      const ctx: Record<string, unknown> = {
        location: { hash, pathname: "/", search: "" },
        sessionStorage,
        history: { replaceState: () => {} },
      };
      ctx.window = ctx;
      for (const script of scripts) runInNewContext(script, ctx);
      return stored;
    };
    const part = `${PANEL_HASH_KEY}=${"A".repeat(40)}`;
    expect(run(`#foo=1&${part}&bar`).get(PANEL_SESSION_KEY)).toBe(part);
    expect(run(`#${part}`).get(PANEL_SESSION_KEY)).toBe(part);
    expect(run("#foo=1").has(PANEL_SESSION_KEY)).toBe(false);
    expect(
      run(`#${PANEL_HASH_KEY}=${"A".repeat(MAX_PANEL_FRAGMENT_CHARS)}`).has(
        PANEL_SESSION_KEY,
      ),
    ).toBe(false);
  });
});

describe("floors across a boot", () => {
  it("full_state carries the floors, which survive a restart in the order they were added", async () => {
    const { srv, member, add } = await office();
    const a = added(await add(cardListener("A").origin));
    const b = added(await add(cardListener("B").origin));
    const next = await srv.restart();
    server = next;
    const ws = await next.connectWs(member.rawSessionId);
    expect(floorsOf(await ws.waitFor("full_state"))).toEqual([a, b]);
    ws.close();
  });

  it("a damaged floors file reads as no floors, and the next add replaces it", async () => {
    const { srv, member } = await office();
    writeFileSync(join(srv.stateRoot, "floors.json"), "{not json");
    const next = await srv.restart();
    server = next;
    const ws = await next.connectWs(member.rawSessionId);
    expect(floorsOf(await ws.waitFor("full_state"))).toEqual([]);
    ws.close();
    const card = cardListener();
    const res = await api(next, "POST", "/api/floors", {
      body: { url: card.origin },
      rawSessionId: member.rawSessionId,
    });
    expect(res.status).toBe(201);
    const listed = await api(next, "GET", "/api/floors", {
      rawSessionId: member.rawSessionId,
    });
    expect(floorsOf(listed.body)).toEqual([floorOf(res.body)]);
  });
});
