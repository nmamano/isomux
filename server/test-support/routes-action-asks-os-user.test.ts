// A member-os-user action ask (task 4088f164), through the real server and a
// stand-in sudo (fake-sudo.ts). The properties:
// - the owner's Apply on the card runs the member's root command as the
//   Members page's Run does: the verb, the member id and the step's target,
//   with the password the owner typed; a wrong password comes back with the
//   tries left; an agent of the owner cannot run it, and another member
//   cannot see it;
// - the password is in no answer, no audit row, no line of the agent's chat
//   and no file under the state root, and the ask stores none;
// - the ask closes when the state reaches the asked one, at each place that
//   can change it: the member's runner connects (an on), a verb of the root
//   command ends (an off by hand), and the Run's command ends;
// - an agent below Standard opens one through /mcp with its target.
// The stand-in sudo runs a script of this file in place of the root command,
// so no case runs the host's installed command (/usr/local/sbin).

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startTestServer, type TestServer } from "./harness.ts";
import { createFakeSudo, FAKE_SUDO_WRONG_PASSWORD } from "./fake-sudo.ts";
import { isolateMember, type IsolatedMember } from "./member-host-fixture.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { officeAuditStore } from "../audit-store.ts";
import {
  handleMemberUserAdmin,
  setMemberUserAdminDeps,
} from "../member-user-admin.ts";
import {
  MEMBER_USER_COMMAND_PATH,
  resetMemberUserAttempts,
} from "../member-os-user-view.ts";
import { resetRunModeCache } from "../member-os-user-run.ts";
import { forgetMemberOsUser } from "../member-os-users.ts";
import type { AgentInfo, AskEntry } from "../../shared/types.ts";
import type { MemberOsUserWire } from "../../shared/contract-shapes.ts";

const PASSWORD = "Os-user-ask-pa55-4088f164";
// A new user's name no box has.
const NEW_USER = "isomuxt4088f164";
const STAND_IN_LINE = "stand-in root command: nothing changed";
const sudo = createFakeSudo();
sudo.setPassword(PASSWORD);
const GO = join(sudo.dir, "go");

let server: TestServer | null = null;
let isolated: IsolatedMember | null = null;
const folders: string[] = [];
const clients: Client[] = [];
beforeAll(() => {
  // The installer's install; no OS user name taken (no passwd read).
  setMemberUserAdminDeps({
    support: { ok: true, shape: "installer" },
    takenOsUserNames: async () => [],
  });
});
afterEach(async () => {
  // A run that waits for GO ends now.
  writeFileSync(GO, "");
  for (const client of clients.splice(0)) await client.close();
  isolated?.dispose();
  isolated = null;
  await server?.stop();
  server = null;
  resetRunModeCache();
  resetMemberUserAttempts();
  sudo.setCommand(null);
  rmSync(GO, { force: true });
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true });
});
afterAll(() => {
  setMemberUserAdminDeps(null);
  rmSync(sudo.dir, { recursive: true, force: true });
});

interface Res {
  status: number;
  body: unknown;
}
// Every answer's text, for the password scan.
const answers: string[] = [];

async function read(res: Response): Promise<Res> {
  const text = await res.text();
  answers.push(text);
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body };
}

// Morgan owns the office; Mia is the member whose OS user changes; Casey is
// another member.
async function office() {
  const srv = await startTestServer({ startServer: { sudoPath: sudo.path } });
  server = srv;
  const morgan = await srv.seedOwner("Morgan");
  await srv.seedMember("Mia");
  const casey = await srv.seedMember("Casey");
  return {
    srv,
    morgan: morgan.rawSessionId,
    morganName: morgan.username,
    morganId: getUserByName(morgan.username)!.id,
    casey: casey.rawSessionId,
    miaId: getUserByName("Mia")!.id,
  };
}
type Office = Awaited<ReturnType<typeof office>>;

async function spawn(o: Office, name: string): Promise<AgentInfo> {
  const cwd = mkdtempSync(join(tmpdir(), "action-asks-os-user-"));
  folders.push(cwd);
  const agent = await o.srv.agentManager.spawn(
    name,
    cwd,
    "default",
    undefined,
    undefined,
    o.srv.agentManager.getRooms()[0].id,
    undefined,
    undefined,
    undefined,
    o.morganName,
    "claude",
    undefined,
    o.morganId,
  );
  if (!agent) throw new Error(`spawn failed: ${name}`);
  return agent;
}

function asSession(
  o: Office,
  session: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Res> {
  return o.srv
    .http(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      rawSessionId: session,
    })
    .then(read);
}

function asAgent(
  o: Office,
  agentId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Res> {
  return o.srv
    .http(path, {
      method,
      headers: {
        Authorization: `Bearer ${getAgentTokenRaw(agentId)!}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    .then(read);
}

const codeOf = (res: Res) =>
  (res.body as { error?: { code?: string } } | null)?.error?.code;

async function opened(
  o: Office,
  askerId: string,
  step: Record<string, unknown>,
): Promise<AskEntry> {
  const res = await asAgent(o, askerId, "POST", `/api/agents/${askerId}/asks`, {
    text: "Please turn this on.",
    step,
  });
  expect({ status: res.status, code: codeOf(res) }).toEqual({
    status: 201,
    code: undefined,
  });
  return res.body as AskEntry;
}

const apply = (o: Office, session: string, askId: string, body?: unknown) =>
  asSession(o, session, "POST", `/api/asks/${askId}/action`, body);

async function askStatus(o: Office, askerId: string, askId: string) {
  const res = await asAgent(
    o,
    askerId,
    "GET",
    `/api/agents/${askerId}/asks/${askId}`,
  );
  if (res.status !== 200) return String(res.status);
  return (
    (res.body as { closed?: { outcome: string } }).closed?.outcome ?? "open"
  );
}

async function waitUntil(pred: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 3000;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await Bun.sleep(20);
  }
}

const closedAsDone = (o: Office, askerId: string, askId: string) =>
  waitUntil(
    async () => (await askStatus(o, askerId, askId)) === "done",
    "the ask closes as done",
  );

// An ask that must stay open: a hook had time to run and did not close it.
async function staysOpen(o: Office, askerId: string, askId: string) {
  await Bun.sleep(150);
  expect(await askStatus(o, askerId, askId)).toBe("open");
}

const osUser = async (o: Office) =>
  (await asSession(o, o.morgan, "GET", "/api/users/Mia/os-user"))
    .body as MemberOsUserWire;

// The Run's attempt, once it no longer runs.
async function endedAttempt(o: Office) {
  let attempt: MemberOsUserWire["attempt"];
  await waitUntil(async () => {
    attempt = (await osUser(o)).attempt;
    return !!attempt && attempt.status !== "running";
  }, "the run ends");
  return attempt!;
}

const sudoRan = () => existsSync(join(sudo.dir, "argv"));

describe("a member-os-user ask's Apply", () => {
  it("runs the member's root command with the step's target and the typed password, as the owner", async () => {
    const o = await office();
    sudo.setCommand(`printf '%s\\n' '${STAND_IN_LINE}' >&2; exit 1`);
    const asker = await spawn(o, "Asker");
    for (const [step, tail] of [
      [{}, ""],
      [{ osUser: NEW_USER }, ` --user ${NEW_USER}`],
    ] as const) {
      resetMemberUserAttempts();
      const entry = await opened(o, asker.id, {
        kind: "member-os-user",
        username: "Mia",
        on: true,
        ...step,
      });
      const ran = await apply(o, o.morgan, entry.id, { password: PASSWORD });
      expect({ tail, status: ran.status }).toEqual({ tail, status: 202 });
      // The stand-in fails: the attempt shows its line, and the ask stays.
      expect((await endedAttempt(o)).message).toContain(STAND_IN_LINE);
      expect(sudo.argv()).toContain(
        `${MEMBER_USER_COMMAND_PATH} enable ${o.miaId}${tail}`,
      );
      expect(await askStatus(o, asker.id, entry.id)).toBe("open");
      // The dispatched Run's audit row names the ask, with the owner.
      expect(
        officeAuditStore()
          .list({ operation: "users.osUser.run", limit: 1000 })
          .items.filter((r) => r.targets.includes(entry.id))
          .map((r) => [r.actor.kind, r.actor.id]),
      ).toEqual([["member", o.morganId]]);
    }
  });

  it("answers a wrong password with sudo's line and the tries left", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const entry = await opened(o, asker.id, {
      kind: "member-os-user",
      username: "Mia",
      on: true,
    });
    const res = await apply(o, o.morgan, entry.id, { password: "not-it" });
    expect(res.status).toBe(422);
    expect((res.body as { error?: unknown }).error).toMatchObject({
      code: "not_started",
      reason: FAKE_SUDO_WRONG_PASSWORD,
      attemptsLeft: 2,
    });
  });

  it("runs nothing for an agent of the owner, and the ask is not another member's to run", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const entry = await opened(o, asker.id, {
      kind: "member-os-user",
      username: "Mia",
      on: true,
    });
    rmSync(join(sudo.dir, "argv"), { force: true });
    const byAgent = await asAgent(
      o,
      asker.id,
      "POST",
      `/api/asks/${entry.id}/action`,
      { password: PASSWORD },
    );
    expect(byAgent.status).toBeGreaterThanOrEqual(400);
    expect(
      (await apply(o, o.casey, entry.id, { password: PASSWORD })).status,
    ).toBe(404);
    expect(sudoRan()).toBe(false);
    // The enabling condition: the owner's Apply reaches sudo.
    expect(
      (await apply(o, o.morgan, entry.id, { password: PASSWORD })).status,
    ).toBe(202);
    await endedAttempt(o);
    expect(sudoRan()).toBe(true);
  });

  it("keeps the password out of every answer, audit row, chat line, the ask and every file under the state root", async () => {
    const o = await office();
    sudo.setCommand(`printf '%s\\n' '${STAND_IN_LINE}' >&2; exit 1`);
    const asker = await spawn(o, "Asker");
    const entry = await opened(o, asker.id, {
      kind: "member-os-user",
      username: "Mia",
      on: true,
    });
    answers.length = 0;
    expect(
      (await apply(o, o.morgan, entry.id, { password: PASSWORD })).status,
    ).toBe(202);
    await endedAttempt(o);
    // A wrong one too: the refusal's path.
    await apply(o, o.morgan, entry.id, { password: `${PASSWORD}-wrong` });
    const stored = await asAgent(
      o,
      asker.id,
      "GET",
      `/api/agents/${asker.id}/asks/${entry.id}`,
    );
    expect(stored.status).toBe(200);
    const audit = JSON.stringify(
      officeAuditStore().list({ limit: 1000 }).items,
    );
    // The enabling condition: the scans read what the run wrote.
    expect(audit).toContain(entry.id);
    expect(answers.length).toBeGreaterThan(2);
    const chat = JSON.stringify(o.srv.agentManager.getAgentLogs(asker.id));
    const bytes = (dir: string): string =>
      readdirSync(dir)
        .map((name) => {
          const path = join(dir, name);
          const st = statSync(path);
          return st.isDirectory()
            ? bytes(path)
            : st.isFile()
              ? readFileSync(path).toString("latin1")
              : "";
        })
        .join("");
    expect({
      answers: answers.some((a) => a.includes(PASSWORD)),
      audit: audit.includes(PASSWORD),
      chat: chat.includes(PASSWORD),
      files: bytes(o.srv.stateRoot).includes(PASSWORD),
    }).toEqual({ answers: false, audit: false, chat: false, files: false });
  });
});

describe("a member-os-user ask closes", () => {
  it("when the member's runner connects after an on", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const entry = await opened(o, asker.id, {
      kind: "member-os-user",
      username: "Mia",
      on: true,
    });
    await staysOpen(o, asker.id, entry.id);
    isolated = await isolateMember(o.miaId);
    expect((await osUser(o)).state).toBe("on");
    await closedAsDone(o, asker.id, entry.id);
  });

  it("when a verb of the root command turns the OS user off by hand", async () => {
    const o = await office();
    isolated = await isolateMember(o.miaId);
    const asker = await spawn(o, "Asker");
    const entry = await opened(o, asker.id, {
      kind: "member-os-user",
      username: "Mia",
      on: false,
    });
    await staysOpen(o, asker.id, entry.id);
    const res = await handleMemberUserAdmin("/admin/member-user/disable", {
      member: o.miaId,
      keepFiles: true,
    });
    expect(res.status).toBe(200);
    expect((await osUser(o)).state).toBe("off");
    await closedAsDone(o, asker.id, entry.id);
  });

  it("when the Run's command ends", async () => {
    const o = await office();
    isolated = await isolateMember(o.miaId);
    // The stand-in waits for the test, then succeeds.
    sudo.setCommand(`while [ ! -e '${GO}' ]; do sleep 0.05; done; exit 0`);
    const asker = await spawn(o, "Asker");
    const entry = await opened(o, asker.id, {
      kind: "member-os-user",
      username: "Mia",
      on: false,
    });
    expect(
      (await apply(o, o.morgan, entry.id, { password: PASSWORD })).status,
    ).toBe(202);
    expect((await osUser(o)).attempt?.status).toBe("running");
    // The record changes with no hook (as the root command's own write
    // would): the ask waits for the end of the run.
    forgetMemberOsUser(o.miaId);
    expect((await osUser(o)).state).toBe("off");
    await staysOpen(o, asker.id, entry.id);
    writeFileSync(GO, "");
    await closedAsDone(o, asker.id, entry.id);
    expect(sudo.argv()).toContain(
      `${MEMBER_USER_COMMAND_PATH} disable ${o.miaId}`,
    );
  });
});

describe("a member-os-user ask through /mcp", () => {
  it("opens with its target for an agent below Standard", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const access = await asSession(
      o,
      o.morgan,
      "PUT",
      `/api/agents/${asker.id}/access`,
      { access: "office" },
    );
    expect(access.status).toBe(200);
    const client = new Client({ name: "member-os-user", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${o.srv.baseUrl}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${getAgentTokenRaw(asker.id)}` },
        },
      }),
    );
    clients.push(client);
    const open = async (step: Record<string, unknown>) => {
      const r = (await client.callTool({
        name: "open_ask",
        arguments: { prompt: "Please turn on Mia's OS user.", step },
      })) as { isError?: boolean; content?: Array<{ text?: string }> };
      return {
        isError: !!r.isError,
        text: (r.content ?? []).map((p) => p.text ?? "").join("\n"),
      };
    };
    const made = await open({
      kind: "member-os-user",
      username: "Mia",
      on: true,
      osUser: NEW_USER,
    });
    expect(made).toMatchObject({ isError: false });
    expect((JSON.parse(made.text) as AskEntry).step).toEqual({
      kind: "member-os-user",
      userId: o.miaId,
      on: true,
      osUser: NEW_USER,
    });
    // existing reaches the server: zod would strip an unknown key, and the
    // step would then make a new user of that name. The server refuses the
    // name as no existing user (the box's users were read), or stores it
    // with existing (they were not).
    const taken = await open({
      kind: "member-os-user",
      username: "Mia",
      on: true,
      osUser: `${NEW_USER}x`,
      existing: true,
    });
    if (taken.isError) expect(taken.text).toContain("unknown_os_user");
    else
      expect((JSON.parse(taken.text) as AskEntry).step).toMatchObject({
        osUser: `${NEW_USER}x`,
        existing: true,
      });
  });
});
