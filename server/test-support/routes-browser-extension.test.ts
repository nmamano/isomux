import { sessionCookieName } from "../auth.ts";
import { mayReachExtension, mayUseExtension } from "../isomux-office";
import { getUserByName } from "../users";
import {
  startFlatOffice,
  raw,
  WS_UPGRADE_HEADERS,
  expectAuthRequired,
  expectBounce,
} from "./app-host-test-kit";
import {
  memberRequest,
  ownedAgent,
  extensionSocket,
  origin,
} from "./browser-extension-route-fixture";
import { afterEach, test, expect } from "bun:test";
import { startTestServer, type TestServer } from "./harness";
import { getAgentTokenRaw } from "../identity/tokens";
import { extensionUpgradeAllowed } from "../browser-extension-service";
import { formatSharedPage } from "../../shared/browser-share";
import { isRepliesOnlyDevice } from "../../shared/identity";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

test("production routes pair, bind Origin, reject office credential use, persist and revoke", async () => {
  server = await startTestServer();
  const owner = await server.seedOwner();
  const other = await server.seedMember("Other");
  expect(
    (await memberRequest(server, owner, "GET", "/api/me/browser")).status,
  ).toBe(200);
  expect(
    await (await memberRequest(server, other, "GET", "/api/me/browser")).json(),
  ).toMatchObject({ paired: false });
  const agent = await ownedAgent(server, owner, "browser agent");
  expect(mayUseExtension(getUserByName(owner.username)!.id, agent.id)).toBe(
    true,
  );
  expect(
    (
      await memberRequest(
        server,
        owner,
        "PUT",
        `/api/users/${other.username}/access`,
        { allowedRooms: [agent.roomId] },
      )
    ).status,
  ).toBe(200);
  expect(mayUseExtension(getUserByName(other.username)!.id, agent.id)).toBe(
    false,
  );
  const token = getAgentTokenRaw(agent.id)!;
  expect(
    (
      await server.http("/api/me/browser/pair", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: "{}",
      })
    ).status,
  ).toBe(403);
  const { code } = await (
    await memberRequest(server, owner, "POST", "/api/me/browser/pair", {})
  ).json();
  const socket = await extensionSocket(server, {
    kind: "hello",
    version: 4,
    code,
  });
  const paired = await socket.wait("paired");
  const ready = await socket.wait("ready");
  expect(typeof paired.credential).toBe("string");
  expect(
    (
      await server.http("/api/me/browser", {
        headers: { Authorization: `Bearer ${String(paired.credential)}` },
      })
    ).status,
  ).toBe(401);
  const duplicate = await extensionSocket(server, {
    kind: "hello",
    version: 4,
    credential: paired.credential,
  });
  await duplicate.wait("refused");
  expect(socket.closed()).toBe(false);
  const reused = await extensionSocket(server, {
    kind: "hello",
    version: 4,
    code,
  });
  await reused.wait("refused");
  const wrongOrigin = await extensionSocket(
    server,
    { kind: "hello", version: 4, credential: paired.credential },
    "chrome-extension://" + "b".repeat(32),
  );
  await wrongOrigin.wait("refused");
  server = await server.restart();
  const restored = await extensionSocket(server, {
    kind: "hello",
    version: 4,
    credential: paired.credential,
  });
  const next = await restored.wait("ready");
  expect(next.generation).not.toBe(ready.generation);
  expect(
    await (await memberRequest(server, owner, "GET", "/api/me/browser")).json(),
  ).toMatchObject({ paired: true, online: true });
  expect(
    (await memberRequest(server, owner, "DELETE", "/api/me/browser")).status,
  ).toBe(204);
  await restored.wait("refused");
  expect(
    await (await memberRequest(server, owner, "GET", "/api/me/browser")).json(),
  ).toMatchObject({ paired: false, online: false });
});

test("several browsers pair, stay connected, and unpair one at a time", async () => {
  server = await startTestServer();
  const owner = await server.seedOwner();
  const other = await server.seedMember("Other");
  const pair = async (body: unknown) =>
    (
      await (
        await memberRequest(
          server!,
          owner,
          "POST",
          "/api/me/browser/pair",
          body,
        )
      ).json()
    ).code as string;
  const connect = async (code: string) => {
    const socket = await extensionSocket(server!, {
      kind: "hello",
      version: 4,
      code,
    });
    await socket.wait("ready");
    return socket;
  };
  const status = async () =>
    (await (
      await memberRequest(server!, owner, "GET", "/api/me/browser")
    ).json()) as {
      online: boolean;
      browsers: { id: string; name: string; online: boolean }[];
    };
  const laptop = await connect(await pair({ name: " Laptop " }));
  // A retired replace flag is ignored: the code adds a browser.
  const desk = await connect(await pair({ replace: true }));
  expect(laptop.closed()).toBe(false);
  const both = await status();
  expect(both.browsers.map((b) => [b.name, b.online])).toEqual([
    ["Laptop", true],
    ["Browser 1", true],
  ]);
  for (const body of [{ name: "x".repeat(41) }, { name: 1 }, { replace: 1 }])
    expect(
      (await memberRequest(server, owner, "POST", "/api/me/browser/pair", body))
        .status,
    ).toBe(422);
  const laptopId = both.browsers[0].id;
  const missing = await memberRequest(
    server,
    owner,
    "DELETE",
    "/api/me/browser/browsers/unknown",
  );
  const foreign = await memberRequest(
    server,
    other,
    "DELETE",
    `/api/me/browser/browsers/${laptopId}`,
  );
  expect([missing.status, foreign.status]).toEqual([404, 404]);
  expect(await foreign.json()).toEqual(await missing.json());
  const token = getAgentTokenRaw(
    (await ownedAgent(server, owner, "browser agent")).id,
  )!;
  expect(
    (
      await server.http(`/api/me/browser/browsers/${laptopId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
  ).toBe(403);
  const pending = await pair({});
  expect(
    (
      await memberRequest(
        server,
        owner,
        "DELETE",
        `/api/me/browser/browsers/${laptopId}`,
      )
    ).status,
  ).toBe(204);
  await laptop.wait("refused");
  expect(desk.closed()).toBe(false);
  expect((await status()).browsers.map((b) => b.name)).toEqual(["Browser 1"]);
  // Unpairing one browser leaves a pending code usable.
  const third = await connect(pending);
  expect((await status()).browsers.map((b) => b.name)).toEqual([
    "Browser 1",
    "Browser 2",
  ]);
  const cleared = await pair({});
  expect(
    (await memberRequest(server, owner, "DELETE", "/api/me/browser")).status,
  ).toBe(204);
  await desk.wait("refused");
  await third.wait("refused");
  const late = await extensionSocket(server, {
    kind: "hello",
    version: 4,
    code: cleared,
  });
  await late.wait("refused");
  expect(await status()).toMatchObject({ online: false, browsers: [] });
});

test("extension socket requires exact Origin and canonical office host", () => {
  const request = (url: string, host: string, o: string) =>
    new Request(url, { headers: { host, origin: o } });
  expect(
    extensionUpgradeAllowed(
      request(
        "https://office.example/browser-extension/ws",
        "office.example",
        origin,
      ),
      "https://office.example",
    ),
  ).toBe(true);
  for (const bad of [
    "null",
    "https://office.example",
    "",
    origin + "/",
    origin + ".evil",
  ])
    expect(
      extensionUpgradeAllowed(
        request(
          "https://office.example/browser-extension/ws",
          "office.example",
          bad,
        ),
        "https://office.example",
      ),
    ).toBe(false);
  expect(
    extensionUpgradeAllowed(
      request(
        "https://app.office.example/browser-extension/ws",
        "app.office.example",
        origin,
      ),
      "https://office.example",
    ),
  ).toBe(false);
  expect(
    extensionUpgradeAllowed(
      request(
        "http://office.example/browser-extension/ws",
        "office.example",
        origin,
      ),
      "http://office.example",
    ),
  ).toBe(false);
});

test("current manager room access loss actively detaches a pending agent action", async () => {
  server = await startTestServer();
  const owner = await server.seedOwner();
  const member = await server.seedMember("Browser member");
  const room = server.agentManager.getOrdinaryRooms()[0].id;
  const access = async (rooms: string[]) =>
    server!.http(`/api/users/${encodeURIComponent(member.username)}/access`, {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowedRooms: rooms }),
    });
  expect((await access([room])).status).toBe(200);
  const agent = await ownedAgent(server, member, "member browser agent");
  const { code } = await (
    await memberRequest(server, member, "POST", "/api/me/browser/pair", {})
  ).json();
  const socket = await extensionSocket(server, {
    kind: "hello",
    version: 4,
    code,
  });
  await socket.wait("ready");
  const generation = (await socket.wait("ready")).generation;
  socket.ws.send(
    JSON.stringify({
      kind: "offer",
      generation,
      durationMinutes: 0,
      assignment: crypto.randomUUID(),
      scope: { kind: "agent", agentId: agent.id },
    }),
  );
  const attach = await socket.wait("command");
  expect(attach.method).toBe("attach");
  socket.ws.send(
    JSON.stringify({
      kind: "result",
      generation,
      id: attach.id,
      result: {
        targetInfo: {
          targetId: "owned",
          browserContextId: "context",
          type: "page",
          url: "https://example.com/",
        },
      },
    }),
  );
  await socket.wait("offered");
  socket.messages.length = 0;
  const pending = server.http(`/api/agents/${agent.id}/browser`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getAgentTokenRaw(agent.id)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "goto", url: "https://example.com" }),
  });
  const command = await socket.wait("command");
  expect(command.method).toBe("cdp");
  expect((await access([])).status).toBe(200);
  const response = await pending;
  expect(response.status).toBe(500);
  expect((await response.json()).error.code).toBe("browser_control_ended");
  for (
    let i = 0;
    i < 100 && !socket.messages.some((m) => m.method === "detach");
    i++
  )
    await Bun.sleep(5);
  expect(socket.messages.some((m) => m.method === "detach")).toBe(true);
  expect(socket.closed()).toBe(false);
  socket.ws.close();
});

// Task d4224f2f: a member offers a tab to All agents, and an agent of
// another member, whose manager has no browser, acts in it until the offering
// member loses access to the agent's room.
test("an agent acts in another member's All agents tab while that member can access its room", async () => {
  server = await startTestServer();
  const owner = await server.seedOwner();
  const member = await server.seedMember("Offering member");
  const memberId = getUserByName(member.username)!.id;
  const room = server.agentManager.getOrdinaryRooms()[0].id;
  const access = async (rooms: string[]) =>
    (
      await memberRequest(
        server!,
        owner,
        "PUT",
        `/api/users/${encodeURIComponent(member.username)}/access`,
        { allowedRooms: rooms },
      )
    ).status;
  expect(await access([room])).toBe(200);
  const agent = await ownedAgent(server, owner, "owner agent");
  expect(mayReachExtension(memberId, agent.id)).toBe(true);
  expect(mayUseExtension(memberId, agent.id)).toBe(false);
  expect(mayReachExtension(memberId, "missing-agent")).toBe(false);
  expect(mayReachExtension("missing-member", agent.id)).toBe(false);
  const { code } = await (
    await memberRequest(server, member, "POST", "/api/me/browser/pair", {})
  ).json();
  const socket = await extensionSocket(server, {
    kind: "hello",
    version: 4,
    code,
  });
  const ready = await socket.wait("ready");
  expect(ready.officeScope).toBe(true);
  socket.ws.send(
    JSON.stringify({
      kind: "offer",
      generation: ready.generation,
      durationMinutes: 0,
      assignment: crypto.randomUUID(),
      scope: { kind: "office" },
    }),
  );
  const attach = await socket.wait("command");
  expect(attach.method).toBe("attach");
  socket.ws.send(
    JSON.stringify({
      kind: "result",
      generation: ready.generation,
      id: attach.id,
      result: {
        targetInfo: {
          targetId: "owned",
          browserContextId: "context",
          type: "page",
          url: "https://example.com/",
        },
      },
    }),
  );
  expect((await socket.wait("offered")).error).toBeUndefined();
  const browser = (body: unknown) =>
    server!.http(`/api/agents/${agent.id}/browser`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getAgentTokenRaw(agent.id)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const tabs = await browser({ action: "tabs" });
  expect(tabs.status).toBe(200);
  expect(await tabs.json()).toMatchObject({
    tabs: [
      {
        scope: { kind: "office" },
        member: getUserByName(member.username)!.name,
      },
    ],
  });
  socket.messages.length = 0;
  const pending = browser({ action: "goto", url: "https://example.com" });
  const command = await socket.wait("command");
  expect(command.method).toBe("cdp");
  expect(await access([])).toBe(200);
  expect(mayReachExtension(memberId, agent.id)).toBe(false);
  // As with an Only my agents offer, the offer stays for the agents the member
  // still reaches; this caller ends when its command answers.
  socket.ws.send(
    JSON.stringify({
      kind: "result",
      generation: ready.generation,
      id: command.id,
      result: {},
    }),
  );
  const response = await pending;
  expect(response.status).toBe(500);
  expect((await response.json()).error.code).toBe("browser_control_ended");
  expect(socket.messages.some((m) => m.method === "detach")).toBe(false);
  const after = await browser({ action: "tabs" });
  expect((await after.json()).error.code).toBe("browser_not_paired");
  socket.ws.close();
});

test("app host dispatch cannot reach pairing or browser sockets", async () => {
  server = await startFlatOffice((s) => {
    server = s;
  });
  for (const path of [
    "/api/me/browser/pair",
    "/browser-extension/ws",
    "/api/me/browser/extension.zip",
  ]) {
    const response = await raw(server.port, {
      host: "unknown.office.example",
      path,
      ...(path.endsWith("/ws")
        ? { headers: { ...WS_UPGRADE_HEADERS, Origin: origin } }
        : { method: path.endsWith(".zip") ? "GET" : "POST" }),
    });
    // The app-host gate answers (F9: an unknown label gets the no-session
    // answer), so the request never reaches the office's own handler. A GET
    // may start the sign-in handshake; the rest are refused.
    if (path.endsWith(".zip"))
      expectBounce(response, { label: "unknown", path }, path);
    else expectAuthRequired(response, path);
  }
});

test("extension ZIP download is self-authenticated and metadata is the current member", async () => {
  server = await startTestServer();
  const owner = await server.seedOwner("Package owner");
  const agent = await ownedAgent(server, owner, "Package agent");
  const path = "/api/me/browser/extension.zip";
  expect((await server.http(path)).status).toBe(401);
  expect(
    (
      await server.http(path, {
        headers: { Authorization: `Bearer ${getAgentTokenRaw(agent.id)}` },
      })
    ).status,
  ).toBe(403);
  const response = await memberRequest(server, owner, "GET", path);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-disposition")).toContain("attachment");
  expect(response.headers.get("content-type")).toBe("application/zip");
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect([...bytes.slice(0, 4)]).toEqual([80, 75, 3, 4]);
  const status = await (
    await memberRequest(server, owner, "GET", "/api/me/browser")
  ).json();
  expect(status.member).toEqual({
    id: getUserByName(owner.username)!.id,
    name: owner.username,
  });
  expect(status.version).toMatch(/^\d+\.\d+\.\d+$/);
  // Safe GETs use the existing cookie/SameSite + no-CORS boundary, not the write CSRF gate.
  const foreign = await fetch(server.baseUrl + path, {
    headers: {
      Cookie: `${sessionCookieName()}=${owner.rawSessionId}`,
      Origin: "https://foreign.example",
    },
  });
  expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
});

// Task 2f43d351: an extension that reports newer files on disk can be
// reloaded from the office, by its member only.
test("a member reloads a browser whose extension has newer files in place", async () => {
  server = await startTestServer();
  const owner = await server.seedOwner();
  const other = await server.seedMember("Other");
  const pairAndConnect = async (pkg: string, credential?: unknown) => {
    const hello = credential
      ? { kind: "hello", version: 4, credential, package: pkg }
      : {
          kind: "hello",
          version: 4,
          package: pkg,
          code: (
            await (
              await memberRequest(
                server!,
                owner,
                "POST",
                "/api/me/browser/pair",
                {},
              )
            ).json()
          ).code,
        };
    const socket = await extensionSocket(server!, hello);
    const ready = await socket.wait("ready");
    const paired = credential ? undefined : await socket.wait("paired");
    return {
      socket,
      generation: ready.generation as string,
      ready,
      credential: credential ?? paired!.credential,
    };
  };
  const browsers = async () =>
    (
      (await (
        await memberRequest(server!, owner, "GET", "/api/me/browser")
      ).json()) as {
        browsers: { id: string; online: boolean; reloadable: boolean }[];
      }
    ).browsers;
  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 200 && !(await check()); i++) await Bun.sleep(5);
    expect(await check()).toBe(true);
  };
  const reload = (who: typeof owner, id: string) =>
    memberRequest(
      server!,
      who,
      "POST",
      `/api/me/browser/browsers/${id}/reload`,
    );
  const files = (
    c: { socket: { ws: WebSocket }; generation: string },
    pkg: unknown,
  ) =>
    c.socket.ws.send(
      JSON.stringify({ kind: "files", generation: c.generation, package: pkg }),
    );

  const laptop = await pairAndConnect("0.0.1");
  expect(laptop.ready.reload).toBe(true);
  const desk = await pairAndConnect("0.0.1");
  const [laptopId, deskId] = (await browsers()).map((b) => b.id);
  // No files reported yet.
  expect((await browsers()).map((b) => b.reloadable)).toEqual([false, false]);
  const refused = await reload(owner, laptopId);
  expect(refused.status).toBe(409);
  expect((await refused.json()).error.code).toBe("not_reloadable");

  files(laptop, "0.0.2");
  await until(async () => (await browsers())[0].reloadable);
  expect((await browsers())[1].reloadable).toBe(false);
  // A later report that is not newer than the running package.
  files(laptop, "0.0.1");
  await until(async () => !(await browsers())[0].reloadable);
  files(laptop, "0.0.2");
  await until(async () => (await browsers())[0].reloadable);

  // Another member, an unknown id and an agent cannot reload it.
  const foreign = await reload(other, laptopId);
  const missing = await reload(owner, "unknown");
  expect([foreign.status, missing.status]).toEqual([404, 404]);
  expect(await foreign.json()).toEqual(await missing.json());
  const token = getAgentTokenRaw(
    (await ownedAgent(server, owner, "browser agent")).id,
  )!;
  expect(
    (
      await server.http(`/api/me/browser/browsers/${laptopId}/reload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
  ).toBe(403);
  expect(laptop.socket.messages.some((m) => m.kind === "reload")).toBe(false);

  expect((await reload(owner, laptopId)).status).toBe(204);
  expect(await laptop.socket.wait("reload")).toEqual({
    kind: "reload",
    generation: laptop.generation,
  });
  expect(desk.socket.messages.some((m) => m.kind === "reload")).toBe(false);
  const deskRefused = await reload(owner, deskId);
  expect(deskRefused.status).toBe(409);
  expect((await deskRefused.json()).error.code).toBe("not_reloadable");

  // Offline: the files report goes with the connection.
  laptop.socket.ws.close();
  await until(async () => !(await browsers())[0].online);
  expect((await browsers())[0].reloadable).toBe(false);
  const offline = await reload(owner, laptopId);
  expect(offline.status).toBe(409);
  expect((await offline.json()).error.code).toBe("browser_offline");

  // The reloaded extension connects with the new package and no files report.
  const back = await pairAndConnect("0.0.2", laptop.credential);
  await until(async () => (await browsers())[0].online);
  expect((await browsers())[0].reloadable).toBe(false);
  expect((await reload(owner, laptopId)).status).toBe(409);
  back.socket.ws.close();

  // A files report with an invalid package ends the connection.
  files(desk, "not a version");
  await until(async () => desk.socket.closed());
  await until(async () => !(await browsers())[1].online);
});

// Share page with agent (task 68da3968): the office delivers a share as the
// member's own message, marked by a device that is not the data marker, never
// as an answer to a prompt, and audits it without the page.
test("a share from a paired browser reaches the agent as the member's message, answers no prompt, and is audited without the page", async () => {
  server = await startTestServer();
  const owner = await server.seedOwner("Morgan");
  const agent = await ownedAgent(server, owner, "dispatcher");
  const { code } = await (
    await memberRequest(server, owner, "POST", "/api/me/browser/pair", {})
  ).json();
  const socket = await extensionSocket(server, {
    kind: "hello",
    version: 4,
    code,
  });
  const ready = await socket.wait("ready");
  expect(ready.share).toBe(true);
  const page = {
    url: "https://example.com/issues/12",
    title: "Crash on boot",
    selection: "Steps to reproduce",
  };
  const answer = async (id: string) => {
    socket.ws.send(
      JSON.stringify({
        kind: "share",
        generation: ready.generation,
        id,
        agentId: agent.id,
        ...page,
      }),
    );
    for (let i = 0; i < 400; i++) {
      const found = socket.messages.find(
        (m) => m.kind === "shareResult" && m.id === id,
      );
      if (found) return found;
      await Bun.sleep(5);
    }
    throw new Error("No answer to share " + id);
  };
  const sent = () =>
    server!.fakeBackend.sessionForAgent(agent.id)?.sent.map((m) => m.text) ??
    [];

  expect((await answer("first")).error).toBeUndefined();
  const body = formatSharedPage(page);
  for (let i = 0; i < 400 && !sent().some((t) => t.includes(body)); i++)
    await Bun.sleep(5);
  const text = sent().find((t) => t.includes(body));
  expect(text).toBeDefined();
  // The member's label, with a device, right before the body.
  const label = text!.slice(0, text!.indexOf(body));
  const device = /\[Morgan \(([^)]+)\)\] $/.exec(label)?.[1];
  expect(device).toBeDefined();
  expect(isRepliesOnlyDevice(device)).toBe(false);

  // A menu waits for the member: a share does not answer it.
  const opened = await memberRequest(
    server,
    owner,
    "POST",
    `/api/agents/${agent.id}/messages`,
    { text: "/model" },
  );
  expect(opened.status).toBe(200);
  const pending = () =>
    server!.agentManager
      .getPendingInteractions()
      .filter((item) => item.agentId === agent.id);
  expect(pending()).toHaveLength(1);
  const before = sent().length;
  expect((await answer("second")).error).toBe("awaits_member_answer");
  expect(pending()).toHaveLength(1);
  expect(sent()).toHaveLength(before);

  const audit = await memberRequest(server, owner, "GET", "/api/audit-log");
  const auditText = await audit.text();
  const rows = (
    JSON.parse(auditText) as {
      items: { operation: string; targets: string[] }[];
    }
  ).items.filter((row) => row.operation === "browserExtension.share");
  expect(rows.map((row) => row.targets)).toEqual([[agent.id]]);
  for (const value of Object.values(page))
    expect(auditText).not.toContain(value);
  socket.ws.close();
});
