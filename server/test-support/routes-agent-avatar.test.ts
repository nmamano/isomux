// GET /api/agents/:id/avatar.svg (agents.avatar, task 600c58c4): an agent's
// office face as an image, for apps and any page that shows agents.
//
// What only a real server shows, pinned here:
//   - reach: each caller gets a face for exactly the agents GET /agents lists
//     to it (lobby and back room included), and every other id - hidden,
//     killed, unknown - is refused with one identical answer, so the route is
//     no oracle for which ids exist;
//   - the picture is the chat's portrait (ui/office/Character.tsx), rendered
//     standalone, with headers that let no script run if it is opened as a
//     document;
//   - an ETag over the picture: 304 while the outfit holds, a new picture when
//     it changes.
// The route's capability arms (an API token without api:discover-agents) are
// in routes-table.test.ts. The last case keeps the server's UI imports to the
// react-only face modules: the server renders them at request time.
//
// Seam: startTestServer() + fetch. Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { startTestServer, type TestServer } from "./harness.ts";
import { getAgentTokenRaw, mintRunToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { Character } from "../../ui/office/Character.tsx";
import {
  LOBBY_ROOM_ID,
  type AgentInfo,
  type AgentOutfit,
} from "../../shared/types.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

type Caller = { cookie: string } | { bearer: string };

async function get(
  srv: TestServer,
  path: string,
  caller: Caller,
  headers: Record<string, string> = {},
): Promise<Response> {
  if ("cookie" in caller)
    return srv.http(path, { rawSessionId: caller.cookie, headers });
  return fetch(`${srv.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${caller.bearer}`, ...headers },
  });
}

const avatarPath = (id: string) =>
  `/api/agents/${encodeURIComponent(id)}/avatar.svg`;

async function spawnOwnedBy(
  srv: TestServer,
  name: string,
  roomId: string,
  desk: number | null,
  username: string,
): Promise<AgentInfo> {
  const user = getUserByName(username);
  if (!user) throw new Error(`unknown user: ${username}`);
  const a = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    desk,
    undefined,
    roomId,
    undefined,
    undefined,
    undefined,
    username,
    "claude",
    undefined,
    user.id,
  );
  if (!a) throw new Error(`spawn failed: ${name}`);
  return a;
}

function bearerFor(agentId: string): string {
  const token = getAgentTokenRaw(agentId);
  if (!token) throw new Error(`agent token not minted: ${agentId}`);
  return token;
}

// What the chat draws beside a sender (ui/log-view/chat-avatars.tsx
// AgentAvatar), at the route's 64 px.
const chatPortrait = (outfit: AgentOutfit): string =>
  renderToStaticMarkup(
    createElement(Character, {
      state: "idle",
      outfit,
      portrait: true,
      headCrop: 64,
    }),
  );

const OUTFIT_A: AgentOutfit = {
  costume: "none",
  hat: "cap",
  color: "#3366cc",
  hair: "#222222",
  hairStyle: "short",
  accessory: "glasses",
  beard: "none",
  skin: "#f1c27d",
};

const OUTFIT_B: AgentOutfit = {
  ...OUTFIT_A,
  hat: "beanie",
  color: "#cc3333",
  hair: "#aa7733",
};

async function setOutfit(
  srv: TestServer,
  ownerCookie: string,
  agentId: string,
  outfit: AgentOutfit,
): Promise<void> {
  const res = await srv.http(`/api/agents/${agentId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ outfit }),
    rawSessionId: ownerCookie,
  });
  if (res.status >= 400) throw new Error(`PATCH outfit -> ${res.status}`);
}

describe("GET /api/agents/:id/avatar.svg", () => {
  it("serves exactly the agents GET /agents lists to the same caller, and refuses every other id alike", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Mem");
    const r1 = srv.agentManager.getRooms()[0].id;
    const r2 = srv.agentManager.createRoom("Members Only");
    const access = await srv.http(`/api/users/${member.username}/access`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowedRooms: [r2] }),
      rawSessionId: owner.rawSessionId,
    });
    expect(access.status).toBeLessThan(400);
    srv.agentManager.ensureLobby();

    const greeter = await spawnOwnedBy(
      srv,
      "Greeter",
      LOBBY_ROOM_ID,
      0,
      owner.username,
    );
    const ownerFront = await spawnOwnedBy(
      srv,
      "OwnerFront",
      r1,
      0,
      owner.username,
    );
    await spawnOwnedBy(srv, "OwnerBack", r1, null, owner.username);
    const memFront = await spawnOwnedBy(
      srv,
      "MemFront",
      r2,
      0,
      member.username,
    );
    await spawnOwnedBy(srv, "MemBack", r2, null, member.username);
    const builder = await spawnOwnedBy(
      srv,
      "MemBuilder",
      r2,
      1,
      member.username,
    );
    const doomed = await spawnOwnedBy(srv, "Doomed", r2, 2, member.username);
    await srv.agentManager.kill(doomed.id);
    expect(srv.agentManager.getAgent(doomed.id)).toBeUndefined();
    expect(greeter.roomId).toBe(LOBBY_ROOM_ID);

    // An app built by the member's agent, and the member's API token.
    const reg = await fetch(`${srv.baseUrl}/api/apps`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerFor(builder.id)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "chips",
        command: "bun run serve.ts",
        cwd: srv.stateRoot,
      }),
    });
    expect(reg.status).toBe(201);
    const appToken = srv.appSupervisor.tokenFiles.get("chips");
    if (!appToken) throw new Error("no app token");
    const minted = await srv.http("/api/me/api-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Laptop", expiresInDays: 30 }),
      rawSessionId: member.rawSessionId,
    });
    expect(minted.status).toBe(201);
    const apiToken = ((await minted.json()) as { token: string }).token;
    const memberId = getUserByName(member.username)!.id;

    const live = srv.agentManager.getAllAgents();
    const nameOf = new Map(live.map((a) => [a.id, a.name]));
    const everyId = [...live.map((a) => a.id), doomed.id, "agent-0-nobody"];
    const ownerView = live.map((a) => a.name).sort();
    const memberView = ["Greeter", "MemBack", "MemBuilder", "MemFront"].sort();

    const callers: Array<[string, Caller, string[]]> = [
      ["owner cookie", { cookie: owner.rawSessionId }, ownerView],
      ["owner's agent", { bearer: bearerFor(ownerFront.id) }, ownerView],
      ["member cookie", { cookie: member.rawSessionId }, memberView],
      ["member's agent", { bearer: bearerFor(memFront.id) }, memberView],
      ["member's API token", { bearer: apiToken }, memberView],
      [
        "member's cron run",
        { bearer: mintRunToken("job-1", "run-1", memberId) },
        memberView,
      ],
      ["app with a live owner agent", { bearer: appToken }, memberView],
    ];

    for (const [label, caller, expectedNames] of callers) {
      const dir = await get(srv, "/agents?back=1", caller);
      expect({ label, status: dir.status }).toEqual({ label, status: 200 });
      const listed = ((await dir.json()) as Array<{ id?: unknown }>)
        .map((e) => e.id)
        .filter((id): id is string => typeof id === "string");
      // The enabling condition: the directory itself projects as expected,
      // lobby and back room included.
      expect({
        label,
        names: listed.map((id) => nameOf.get(id)).sort(),
      }).toEqual({ label, names: expectedNames });

      const served: string[] = [];
      const refusals = new Set<string>();
      for (const id of everyId) {
        const res = await get(srv, avatarPath(id), caller);
        if (res.status === 200) {
          served.push(id);
          await res.arrayBuffer();
        } else {
          expect({ label, id, status: res.status }).toEqual({
            label,
            id,
            status: 403,
          });
          refusals.add(await res.text());
        }
      }
      expect({ label, served: served.sort() }).toEqual({
        label,
        served: [...listed].sort(),
      });
      // Hidden, killed and unknown ids get one answer.
      expect({ label, refusals: refusals.size }).toEqual({
        label,
        refusals: 1,
      });
    }

    // Once its owner agent is gone, the app keeps only its app-self routes:
    // no directory and no faces.
    await srv.agentManager.kill(builder.id);
    expect(
      (await get(srv, "/agents?back=1", { bearer: appToken })).status,
    ).toBe(403);
    expect(
      (await get(srv, avatarPath(memFront.id), { bearer: appToken })).status,
    ).toBe(403);
    // The same face still reaches the member.
    expect(
      (await get(srv, avatarPath(memFront.id), { cookie: member.rawSessionId }))
        .status,
    ).toBe(200);
  });

  it("is the chat's portrait as a standalone SVG, under headers that run no script", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const r1 = srv.agentManager.getRooms()[0].id;
    const agent = await spawnOwnedBy(srv, "Face", r1, 0, owner.username);
    await setOutfit(srv, owner.rawSessionId, agent.id, OUTFIT_A);
    expect(srv.agentManager.getAgent(agent.id)?.outfit).toEqual(OUTFIT_A);

    const res = await get(srv, avatarPath(agent.id), {
      cookie: owner.rawSessionId,
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe(chatPortrait(OUTFIT_A));
    // Standalone: the root is an <svg> in the SVG namespace, scaled by its
    // view box around the head.
    expect(body.startsWith("<svg")).toBe(true);
    const root = body.slice(0, body.indexOf(">"));
    expect(root).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(root).toContain('viewBox="10 21 32 32"');

    expect(res.headers.get("content-type")?.split(";")[0]).toBe(
      "image/svg+xml",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    const csp = (res.headers.get("content-security-policy") ?? "")
      .split(";")
      .map((d) => d.trim());
    expect(csp).toContain("default-src 'none'");
    expect(csp.some((d) => d.startsWith("script-src"))).toBe(false);
  });

  it("revalidates by ETag: 304 while the outfit holds, a new picture once it changes", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const r1 = srv.agentManager.getRooms()[0].id;
    const agent = await spawnOwnedBy(srv, "Face", r1, 0, owner.username);
    const caller = { cookie: owner.rawSessionId };
    await setOutfit(srv, owner.rawSessionId, agent.id, OUTFIT_A);

    const first = await get(srv, avatarPath(agent.id), caller);
    expect(first.status).toBe(200);
    await first.arrayBuffer();
    const etag = first.headers.get("etag") ?? "";
    expect(etag).toMatch(/^W\/".+"$/);

    // Weak comparison: the weak tag and its strong form both match.
    for (const sent of [etag, etag.slice(2), `"other", ${etag}`]) {
      const again = await get(srv, avatarPath(agent.id), caller, {
        "If-None-Match": sent,
      });
      expect({ sent, status: again.status }).toEqual({ sent, status: 304 });
      expect(await again.text()).toBe("");
      expect(again.headers.get("etag")).toBe(etag);
      for (const name of [
        "cache-control",
        "x-content-type-options",
        "content-security-policy",
      ])
        expect({ sent, name, value: again.headers.get(name) }).toEqual({
          sent,
          name,
          value: first.headers.get(name),
        });
    }

    await setOutfit(srv, owner.rawSessionId, agent.id, OUTFIT_B);
    const changed = await get(srv, avatarPath(agent.id), caller, {
      "If-None-Match": etag,
    });
    expect(changed.status).toBe(200);
    expect(await changed.text()).toBe(chatPortrait(OUTFIT_B));
    const newTag = changed.headers.get("etag") ?? "";
    expect(newTag).toMatch(/^W\/".+"$/);
    expect(newTag).not.toBe(etag);
  });
});

// The server renders ui/office/Character.tsx on every avatar request, so the
// UI code its renderer reaches loads in the office process. Only the
// react-only face modules may be among it: a UI module that pulls in the
// store, i18n or a browser global at load would ride into the server and can
// break it at boot.
describe("the avatar renderer's UI imports", () => {
  it("reach only the react-only face modules", () => {
    const repo = resolve(import.meta.dir, "../..");
    const allowedUi = new Set([
      "ui/office/Character.tsx",
      "ui/office/Costume.tsx",
      "ui/components/BackgroundMark.tsx",
    ]);
    const seen = new Set<string>();
    const uiFiles = new Set<string>();
    const uiPackages = new Set<string>();
    const queue = [join(repo, "server/agent-avatar.ts")];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const rel = relative(repo, file);
      const inUi = rel.startsWith("ui/");
      if (inUi) uiFiles.add(rel);
      const loader = file.endsWith(".tsx") ? "tsx" : "ts";
      const transpiler = new Bun.Transpiler({ loader });
      for (const imp of transpiler.scanImports(readFileSync(file, "utf8"))) {
        if (imp.path.startsWith(".")) {
          queue.push(resolve(dirname(file), imp.path));
        } else if (inUi) {
          uiPackages.add(imp.path);
        }
      }
    }
    // The enabling condition: the walk reaches the face it renders.
    expect(uiFiles.has("ui/office/Character.tsx")).toBe(true);
    expect([...uiFiles].filter((f) => !allowedUi.has(f)).sort()).toEqual([]);
    // The transpiler reports the JSX runtime it injects for a .tsx file.
    const react = /^react(\/jsx-(dev-)?runtime)?$/;
    expect([...uiPackages].filter((p) => !react.test(p)).sort()).toEqual([]);
  });
});
