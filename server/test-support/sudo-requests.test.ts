// Sudo requests through the office routes (task 43a28eed), with a stand-in
// sudo (fake-sudo.ts): the agent's ask, who may answer it, the ask routes
// that refuse it, the agent's result, the notice after a restart, and that
// the password is in no answer, frame, console line or state file.

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { createFakeSudo } from "./fake-sudo.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { mintApiToken } from "../api-tokens.ts";
import { createSudoRunStore } from "../sudo-run-store.ts";
import type { AskEntry } from "../../shared/types.ts";

const PASSWORD = "R0ute-marker-pa55-43a28eed";
const sudo = createFakeSudo();
sudo.setPassword(PASSWORD);

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
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
    srv.stateRoot,
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

      // The ask is answered by its form only: a reply, a dismiss, a task, a
      // simplify and the agent's edit are refused, and it stays open.
      for (const verb of ["reply", "dismiss", "file-task", "simplify"]) {
        const r = await call(
          w.srv,
          "POST",
          `/api/asks/${entry.id}/${verb}`,
          w.ownerSession,
          verb === "reply" || verb === "file-task" ? { text: PASSWORD } : {},
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
