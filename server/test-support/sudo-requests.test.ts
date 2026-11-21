// Sudo requests through the office routes (task 43a28eed), with a stand-in
// sudo (fake-sudo.ts): the agent's ask, who may answer it, the ask routes
// that refuse it, the agent's result, the notice after a restart, and that
// the password is in no answer, frame, console line or state file.

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { createFakeSudo } from "./fake-sudo.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { mintApiToken } from "../api-tokens.ts";
import { createSudoRunStore } from "../sudo-run-store.ts";
import type { AgentInfo, AskEntry } from "../../shared/types.ts";
import { isolateMember, type IsolatedMember } from "./member-host-fixture.ts";
import type { AgentFs } from "../agent-host.ts";
import { ownOsUserLine } from "../system-prompt.ts";

const PASSWORD = "R0ute-marker-pa55-43a28eed";
const sudo = createFakeSudo();
sudo.setPassword(PASSWORD);

let server: TestServer | null = null;
let iso: IsolatedMember | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
  iso?.dispose();
  iso = null;
});
afterAll(() => rmSync(sudo.dir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(20);
  }
}

type Res = { status: number; code?: string; body: unknown };
// Every answer, kept for the password check.
const answers: unknown[] = [];

async function call(
  srv: TestServer,
  method: string,
  path: string,
  auth: { bearer?: string; rawSessionId?: string },
  json?: unknown,
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (auth.bearer) headers["Authorization"] = `Bearer ${auth.bearer}`;
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const res = await srv.http(path, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
    rawSessionId: auth.rawSessionId,
  });
  const text = await res.text();
  answers.push(text);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return {
    status: res.status,
    code: (parsed as { error?: { code?: string } } | null)?.error?.code,
    body: parsed,
  };
}

function sentTexts(srv: TestServer, agentId: string): string[] {
  return srv.fakeBackend.sessions
    .filter((s) => s.opts.agentId === agentId)
    .flatMap((s) => s.sent.map((m) => m.text));
}

// Every file under the state root, as bytes: asks, logs, the audit
// database, the run rows.
function stateBytes(root: string): string {
  let all = "";
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const st = statSync(path);
    if (st.isDirectory()) all += stateBytes(path);
    else if (st.isFile()) all += readFileSync(path).toString("latin1");
  }
  return all;
}

async function world(
  startServer: Record<string, unknown> = { sudoPath: sudo.path },
) {
  server = await startTestServer({
    fakeBackend: new FakeBackend({
      storedSessionState: "durable",
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
    }),
    startServer,
  });
  const srv = server;
  const owner = await srv.seedOwner("Nil");
  const ownerId = getUserByName(owner.username)!.id;
  const member = await srv.seedMember("Mia");
  const [room] = srv.agentManager.getRooms();
  const asker = await srv.agentManager.spawn(
    "Asker",
    srv.workDir,
    "default",
    undefined,
    undefined,
    room.id,
    undefined,
    undefined,
    undefined,
    undefined,
    "claude",
    undefined,
    ownerId,
  );
  if (!asker) throw new Error("spawn failed");
  const agent = { bearer: getAgentTokenRaw(asker.id)! };
  const ownerSession = { rawSessionId: owner.rawSessionId };
  const ownerToken = {
    bearer: (
      await mintApiToken({ userId: ownerId, name: "Nil", expiresInDays: null })
    ).token,
  };
  const request = (command: string) =>
    call(srv, "POST", `/api/agents/${asker.id}/sudo-requests`, agent, {
      command,
      reason: "To install jq.",
    });
  const runPath = (requestId: string, verb: "run" | "decline") =>
    `/api/agents/${asker.id}/sudo-requests/${requestId}/${verb}`;
  return {
    srv,
    owner,
    ownerId,
    member,
    asker,
    agent,
    ownerSession,
    ownerToken,
    request,
    runPath,
  };
}

describe("where sudo requests are offered", () => {
  it("not without sudo on the box", async () => {
    const w = await world({});
    const r = await w.request("apt-get install -y jq");
    expect(`${r.status} ${r.code}`).toBe("409 sudo_unavailable");
  });

  it("not on a Hosted office, even with sudo on the box", async () => {
    const w = await world({ sudoPath: sudo.path, installKind: "hosted" });
    const r = await w.request("apt-get install -y jq");
    expect(`${r.status} ${r.code}`).toBe("409 sudo_unavailable");
  });
});

describe("a sudo request through the routes", () => {
  it("opens an ask the owner runs with the password, and the agent gets the output; the password goes nowhere else", async () => {
    answers.length = 0;
    const lines: unknown[][] = [];
    const saved = { ...console };
    for (const key of ["log", "error", "warn", "info", "debug"] as const)
      console[key] = (...args: unknown[]) => lines.push(args);
    try {
      const w = await world();
      const ws = await w.srv.connectWs(w.owner.rawSessionId);
      expect((await w.request("sudo apt-get install -y jq")).status).toBe(400);
      const opened = await w.request("echo SUDO-RAN-43a28eed");
      expect(opened.status).toBe(200);
      const requestId = (opened.body as { requestId: string }).requestId;

      const listed = await call(w.srv, "GET", "/api/asks", w.ownerSession);
      const [entry] = listed.body as AskEntry[];
      expect(entry.sudo).toMatchObject({
        requestId,
        command: "echo SUDO-RAN-43a28eed",
      });

      // The ask is answered by its form only: a reply, a dismiss, a
      // simplify, a rewrite, a postpone and the agent's edit are refused, and
      // it stays open.
      for (const verb of [
        "reply",
        "dismiss",
        "simplify",
        "rewrite",
        "postpone",
      ]) {
        const r = await call(
          w.srv,
          "POST",
          `/api/asks/${entry.id}/${verb}`,
          w.ownerSession,
          verb === "dismiss" || verb === "simplify" ? {} : { text: PASSWORD },
        );
        expect(`${verb} ${r.status} ${r.code}`).toBe(
          `${verb} 409 sudo_request`,
        );
      }
      const edit = await call(
        w.srv,
        "PATCH",
        `/api/agents/${w.asker.id}/asks/${entry.id}`,
        w.agent,
        { prompt: "Another reason" },
      );
      expect(`${edit.status} ${edit.code}`).toBe("409 sudo_request");

      // Browser sessions only: not the owner's API token, not the agent,
      // not a member who is no owner.
      for (const [who, auth] of [
        ["owner token", w.ownerToken],
        ["agent", w.agent],
        ["member", { rawSessionId: w.member.rawSessionId }],
      ] as const) {
        const r = await call(w.srv, "POST", w.runPath(requestId, "run"), auth, {
          password: PASSWORD,
        });
        expect({ who, status: r.status }).toEqual({ who, status: 403 });
      }

      const wrong = await call(
        w.srv,
        "POST",
        w.runPath(requestId, "run"),
        w.ownerSession,
        { password: "not-it" },
      );
      expect(`${wrong.status} ${wrong.code}`).toBe("422 not_started");

      const ran = await call(
        w.srv,
        "POST",
        w.runPath(requestId, "run"),
        w.ownerSession,
        { password: PASSWORD },
      );
      expect(ran.status).toBe(200);
      expect((await ws.waitFor("ask_removed")).id).toBe(entry.id);
      await waitUntil(
        () =>
          sentTexts(w.srv, w.asker.id).some((t) =>
            t.includes("SUDO-RAN-43a28eed"),
          ),
        "the agent's result notice",
      );
      // The run ended: no row is left for a restart to report.
      await waitUntil(
        () =>
          createSudoRunStore(join(w.srv.stateRoot, "sudo-runs.json")).list()
            .length === 0,
        "the run row removed",
      );

      const everything = [
        JSON.stringify(answers),
        JSON.stringify(ws.messages),
        JSON.stringify(lines),
        JSON.stringify(w.srv.agentManager.getAgentLogs(w.asker.id)),
        JSON.stringify(sentTexts(w.srv, w.asker.id)),
        stateBytes(w.srv.stateRoot),
      ];
      expect(everything.map((text) => text.includes(PASSWORD))).toEqual([
        false,
        false,
        false,
        false,
        false,
        false,
      ]);
    } finally {
      Object.assign(console, saved);
    }
  });

  it("a decline closes the ask and tells the agent", async () => {
    const w = await world();
    const opened = await w.request("echo never");
    const requestId = (opened.body as { requestId: string }).requestId;
    const before = sentTexts(w.srv, w.asker.id).length;
    const r = await call(
      w.srv,
      "POST",
      w.runPath(requestId, "decline"),
      w.ownerSession,
    );
    expect(r.status).toBe(200);
    expect(
      (await call(w.srv, "GET", "/api/asks", w.ownerSession)).body,
    ).toEqual([]);
    await waitUntil(
      () => sentTexts(w.srv, w.asker.id).length > before,
      "the agent's decline notice",
    );
  });

  it("while sudo checks the password, the agent cannot withdraw the request", async () => {
    const w = await world();
    const opened = await w.request("echo withdrawn-too-late");
    const requestId = (opened.body as { requestId: string }).requestId;
    const [entry] = (await call(w.srv, "GET", "/api/asks", w.ownerSession))
      .body as AskEntry[];
    sudo.setAuthDelay(1);
    try {
      const running = call(
        w.srv,
        "POST",
        w.runPath(requestId, "run"),
        w.ownerSession,
        { password: PASSWORD },
      );
      await sleep(300);
      const del = await call(
        w.srv,
        "DELETE",
        `/api/agents/${w.asker.id}/asks/${entry.id}`,
        w.agent,
      );
      expect(`${del.status} ${del.code}`).toBe("409 run_in_progress");
      expect((await running).status).toBe(200);
    } finally {
      sudo.setAuthDelay(null);
    }
    // With no run, the agent withdraws a request.
    const again = await w.request("echo withdrawn");
    const [open] = (await call(w.srv, "GET", "/api/asks", w.ownerSession))
      .body as AskEntry[];
    expect(open.sudo?.requestId).toBe(
      (again.body as { requestId: string }).requestId,
    );
    const del = await call(
      w.srv,
      "DELETE",
      `/api/agents/${w.asker.id}/asks/${open.id}`,
      w.agent,
    );
    expect(del.status).toBe(204);
  });

  it("after a restart during a run, the agent hears the result is unknown", async () => {
    const w = await world();
    // A run row as a server that stopped mid-run leaves it.
    createSudoRunStore(join(w.srv.stateRoot, "sudo-runs.json")).add({
      requestId: "q-restart",
      agentId: w.asker.id,
      command: "apt-get dist-upgrade -y",
      startedAt: Date.now(),
      memberUserId: w.ownerId,
    });
    server = await w.srv.restart();
    const srv = server;
    await waitUntil(
      () =>
        sentTexts(srv, w.asker.id).some((t) =>
          t.includes("apt-get dist-upgrade -y"),
        ),
      "the restart notice",
    );
    expect(
      createSudoRunStore(join(srv.stateRoot, "sudo-runs.json")).list(),
    ).toEqual([]);
  });
});

// Task b94dfd25 4b: an agent of a member with their own OS user. Its cwd is
// checked through her host, it asks even where the office's sudo needs no
// password (her user has none), and its run gets root's home, never the
// office's. Mia has her own OS user (the recording stand-in of
// member-host-fixture.ts); the office agent is the owner's.
describe("an agent of a member with their own OS user", () => {
  async function memberWorld() {
    const w = await world();
    const mia = getUserByName(w.member.username)!;
    iso = await isolateMember(mia.id);
    // The recorder keeps process calls only: record her host's stats here.
    const memberFs = iso.member.host.fs;
    const statted: string[] = [];
    (iso.member.host as { fs: AgentFs }).fs = {
      ...memberFs,
      stat: (path) => {
        statted.push(path);
        return memberFs.stat(path);
      },
    };
    const cwd = realpathSync(mkdtempSync(join(iso.home, "work-")));
    const [room] = w.srv.agentManager.getRooms();
    const info = (await w.srv.agentManager.spawn(
      "Mia's agent",
      cwd,
      "default",
      undefined,
      undefined,
      room.id,
      undefined,
      undefined,
      undefined,
      mia.name,
      "claude",
      undefined,
      mia.id,
    )) as AgentInfo | null;
    if (!info) throw new Error("spawn failed");
    const token = { bearer: getAgentTokenRaw(info.id)! };
    const ask = (command: string) =>
      call(w.srv, "POST", `/api/agents/${info.id}/sudo-requests`, token, {
        command,
        reason: "To install jq.",
        member: w.owner.username,
      });
    return { ...w, mia, cwd, miaAgent: info, ask, statted };
  }
  const line = ownOsUserLine("your manager");
  // Per session of the agent: whether its system prompt has the line.
  const promptsOf = (srv: TestServer, agentId: string) =>
    srv.fakeBackend.sessions
      .filter((s) => s.opts.agentId === agentId)
      .map((s) => s.opts.systemPrompt.includes(line));
  const previewHasLine = async (
    w: { srv: TestServer; ownerSession: { rawSessionId: string } },
    agentId: string,
  ) => {
    const r = await call(
      w.srv,
      "GET",
      `/api/agents/${agentId}/system-prompt`,
      w.ownerSession,
    );
    expect(r.status).toBe(200);
    return (r.body as { prompt: string }).prompt.includes(line);
  };

  it("asks where sudo needs no password, with her cwd checked on her host, and runs with root's home and no password on stdin", async () => {
    sudo.setProbe({ output: "    (ALL) NOPASSWD: ALL\n", code: 0 }, 0);
    sudo.setNoPassword("");
    try {
      const w = await memberWorld();
      // The office's agent may run sudo itself.
      const office = await w.request("echo office");
      expect(`${office.status} ${office.code}`).toBe("409 no_password_needed");
      // The spawn stats her cwd too: count only the request's stats.
      w.statted.length = 0;
      const opened = await w.ask("cat; echo MIA-RAN-b94dfd25");
      expect(opened.status).toBe(200);
      // Her cwd was asked of her host.
      expect(w.statted).toContain(w.cwd);
      const requestId = (opened.body as { requestId: string }).requestId;
      const ran = await call(
        w.srv,
        "POST",
        `/api/agents/${w.miaAgent.id}/sudo-requests/${requestId}/run`,
        w.ownerSession,
        { password: PASSWORD },
      );
      expect(ran.status).toBe(200);
      await waitUntil(
        () =>
          sentTexts(w.srv, w.miaAgent.id).some((t) =>
            t.includes("MIA-RAN-b94dfd25"),
          ),
        "her agent's result notice",
      );
      expect(sudo.env().HOME).toBe("/root");
      expect(sudo.cwd()).toBe("/");
      const notice = sentTexts(w.srv, w.miaAgent.id).join("\n");
      expect(notice.includes(PASSWORD)).toBe(false);
      // Her agent's session and its preview carry the own OS user line.
      expect(promptsOf(w.srv, w.miaAgent.id)).toEqual([true]);
      expect(await previewHasLine(w, w.miaAgent.id)).toBe(true);
    } finally {
      sudo.setNoPassword(null);
      sudo.setProbe({ output: "sudo: a password is required\n", code: 1 }, 1);
    }
  });

  it("an office agent's run keeps the office's home", async () => {
    const w = await memberWorld();
    const opened = await w.request("echo OFFICE-RAN-b94dfd25");
    expect(opened.status).toBe(200);
    const requestId = (opened.body as { requestId: string }).requestId;
    const ran = await call(
      w.srv,
      "POST",
      w.runPath(requestId, "run"),
      w.ownerSession,
      { password: PASSWORD },
    );
    expect(ran.status).toBe(200);
    await waitUntil(
      () =>
        sentTexts(w.srv, w.asker.id).some((t) =>
          t.includes("OFFICE-RAN-b94dfd25"),
        ),
      "the office agent's result notice",
    );
    expect(sudo.env().HOME).toBe(homedir());
    // The office agent's session and preview do not carry the line, and its
    // cwd was not asked of her host.
    expect(promptsOf(w.srv, w.asker.id)).toEqual([false]);
    expect(await previewHasLine(w, w.asker.id)).toBe(false);
    expect(w.statted).not.toContain(w.srv.workDir);
    expect(w.statted).not.toContain(realpathSync(w.srv.workDir));
  });

  it("a cwd that is gone on her host opens no ask", async () => {
    const w = await memberWorld();
    rmSync(w.cwd, { recursive: true, force: true });
    w.statted.length = 0;
    const r = await w.ask("echo never");
    expect(`${r.status} ${r.code}`).toBe("422 cwd_not_found");
    expect(w.statted).toContain(w.cwd);
    const asks = await call(w.srv, "GET", "/api/asks", w.ownerSession);
    expect((asks.body as AskEntry[]).filter((e) => e.sudo)).toHaveLength(0);
  });
});
