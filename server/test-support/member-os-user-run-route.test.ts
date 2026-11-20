// POST /api/users/:username/os-user/run (task b94dfd25 4c-iii): the owner's
// Run on the Members page, through the real server and a stand-in sudo
// (fake-sudo.ts). The properties:
// - only an office owner's browser session runs it: their API token, their
//   privileged agent and a member get 403 (the sudo password goes to root);
// - the GET says how the page can run it: with a password here, and never
//   for an owner;
// - sudo runs the command with the member id only, whatever their name
//   holds, as root's home;
// - a wrong password answers with sudo's line and the tries left;
// - the end of a failed run shows the command's own output, never sudo's
//   prompt (a PAM prompt in place of -p included);
// - the password is in no answer and no file under the state root.
// The stand-in sudo runs a script of this file in place of the root command,
// so no case runs the host's installed command (/usr/local/sbin).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { startTestServer, type TestServer } from "./harness.ts";
import { createFakeSudo, FAKE_SUDO_WRONG_PASSWORD } from "./fake-sudo.ts";
import { mintApiToken } from "../api-tokens.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { setMemberUserAdminDeps } from "../member-user-admin.ts";
import {
  MEMBER_USER_COMMAND_PATH,
  resetMemberUserAttempts,
} from "../member-os-user-view.ts";
import { resetRunModeCache } from "../member-os-user-run.ts";
import type { MemberOsUserWire } from "../../shared/contract-shapes.ts";

const PASSWORD = "Run-route-pa55-b94dfd25";
const ODD_NAME = "Eve O'Neil --user root .";
// The stand-in root command's only output.
const STAND_IN_LINE = "stand-in root command: nothing changed";
const sudo = createFakeSudo();
sudo.setPassword(PASSWORD);

let server: TestServer | null = null;
beforeAll(() => {
  setMemberUserAdminDeps({ support: { ok: true, shape: "installer" } });
  sudo.setCommand(`printf '%s\\n' '${STAND_IN_LINE}' >&2; exit 1`);
});
afterEach(async () => {
  await server?.stop();
  server = null;
  resetRunModeCache();
  resetMemberUserAttempts();
  sudo.setPamPrompt(null);
});
afterAll(() => {
  setMemberUserAdminDeps(null);
  sudo.setCommand(null);
  rmSync(sudo.dir, { recursive: true, force: true });
});

type Auth = { bearer?: string; rawSessionId?: string };
const answers: string[] = [];

async function call(
  srv: TestServer,
  method: string,
  path: string,
  auth: Auth,
  json?: unknown,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const headers: Record<string, string> = {};
  if (auth.bearer) headers.Authorization = `Bearer ${auth.bearer}`;
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const res = await srv.http(path, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
    rawSessionId: auth.rawSessionId,
  });
  const text = await res.text();
  answers.push(text);
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body };
}

const runPath = (name: string) =>
  `/api/users/${encodeURIComponent(name)}/os-user/run`;
const viewPath = (name: string) =>
  `/api/users/${encodeURIComponent(name)}/os-user`;

async function office() {
  server = await startTestServer({ startServer: { sudoPath: sudo.path } });
  const srv = server;
  const owner = await srv.seedOwner("Morgan");
  const mia = await srv.seedMember("Mia");
  const eve = await srv.seedMember(ODD_NAME);
  const id = (name: string) => getUserByName(name)!.id;
  return {
    srv,
    ids: { owner: id(owner.username), mia: id("Mia"), eve: id(eve.username) },
    eveName: eve.username,
    ownerName: owner.username,
    callers: {
      ownerSession: { rawSessionId: owner.rawSessionId },
      ownerPrivilegedAgent: {
        bearer: mintAgentToken("run-owner-priv", id(owner.username), true),
      },
      ownerApiToken: {
        bearer: (
          await mintApiToken({
            userId: id(owner.username),
            name: "run-owner-token",
            expiresInDays: null,
          })
        ).token,
      },
      memberSession: { rawSessionId: mia.rawSessionId },
    } satisfies Record<string, Auth>,
  };
}

// The attempt the GET shows, once it is no longer running.
async function endedAttempt(srv: TestServer, auth: Auth, name: string) {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const view = (await call(srv, "GET", viewPath(name), auth))
      .body as unknown as MemberOsUserWire;
    if (view.attempt && view.attempt.status !== "running") return view.attempt;
    if (Date.now() > deadline) throw new Error("the run did not end");
    await Bun.sleep(50);
  }
}

describe("POST /api/users/:username/os-user/run", () => {
  it("runs for an office owner's browser session only", async () => {
    const o = await office();
    rmSync(join(sudo.dir, "argv"), { force: true });
    const out: Record<string, number> = {};
    for (const [who, auth] of Object.entries(o.callers)) {
      if (who === "ownerSession") continue;
      out[who] = (
        await call(o.srv, "POST", runPath("Mia"), auth, {
          action: "enable",
          password: PASSWORD,
        })
      ).status;
    }
    expect(out).toEqual({
      ownerPrivilegedAgent: 403,
      ownerApiToken: 403,
      memberSession: 403,
    });
    // None of them reached sudo.
    expect(() => sudo.argv()).toThrow();
    // The enabling condition: the owner's session runs it.
    const ran = await call(
      o.srv,
      "POST",
      runPath("Mia"),
      o.callers.ownerSession,
      {
        action: "enable",
        password: PASSWORD,
      },
    );
    expect([ran.status, ran.body?.action]).toEqual([202, "enable"]);
    expect(
      (
        await call(o.srv, "POST", runPath("Nobody"), o.callers.ownerSession, {
          action: "enable",
          password: PASSWORD,
        })
      ).status,
    ).toBe(404);
  });

  it("tells the page to ask for the password, for a member and an owner alike", async () => {
    const o = await office();
    const view = (
      await call(o.srv, "GET", viewPath("Mia"), o.callers.ownerSession)
    ).body as unknown as MemberOsUserWire;
    expect(view.run).toBe("password");
    const ownerView = (
      await call(o.srv, "GET", viewPath(o.ownerName), o.callers.ownerSession)
    ).body as unknown as MemberOsUserWire;
    // Task 12c796b2: an owner may have an OS user, so their page runs it too.
    expect(ownerView.run).toBe("password");
  });

  it("runs the root command with the member id only, whatever their name holds, as root's home", async () => {
    const o = await office();
    expect(o.eveName).toBe(ODD_NAME);
    const ran = await call(
      o.srv,
      "POST",
      runPath(o.eveName),
      o.callers.ownerSession,
      { action: "disable", password: PASSWORD },
    );
    expect(ran.status).toBe(202);
    await endedAttempt(o.srv, o.callers.ownerSession, o.eveName);
    const argv = sudo.argv();
    // The command is one argument of the wrapper: the path, the verb, the id.
    expect(argv).toContain(`${MEMBER_USER_COMMAND_PATH} disable ${o.ids.eve}`);
    for (const piece of ["Eve", "O'Neil", "--user root"])
      expect({ piece, in: argv.some((a) => a.includes(piece)) }).toEqual({
        piece,
        in: false,
      });
    expect(sudo.env().HOME).toBe("/root");
  });

  it("answers a wrong password with sudo's line and the tries left", async () => {
    const o = await office();
    const r = await call(
      o.srv,
      "POST",
      runPath("Mia"),
      o.callers.ownerSession,
      {
        action: "enable",
        password: "not-the-password",
      },
    );
    expect(r.status).toBe(422);
    // The executor spreads the detail into the error object
    // (server/routes/executor.ts), as the UI's ApiError.detail reads it.
    expect(r.body?.error).toMatchObject({
      code: "not_started",
      reason: FAKE_SUDO_WRONG_PASSWORD,
      attemptsLeft: 2,
    });
  });

  it("ends a failed run with the command's own output, never sudo's prompt", async () => {
    const o = await office();
    const PROMPT = "Rig PAM passcode for the run: ";
    for (const pam of [null, PROMPT]) {
      sudo.setPamPrompt(pam);
      resetMemberUserAttempts();
      const ran = await call(
        o.srv,
        "POST",
        runPath("Mia"),
        o.callers.ownerSession,
        { action: "enable", password: PASSWORD },
      );
      expect(ran.status).toBe(202);
      // The stand-in root command fails with a line of its own.
      const attempt = await endedAttempt(o.srv, o.callers.ownerSession, "Mia");
      expect({ pam, status: attempt.status }).toEqual({
        pam,
        status: "failed",
      });
      expect(attempt.message).toContain(STAND_IN_LINE);
      for (const text of [PROMPT, "password", "[sudo]", "Sorry"])
        expect({ pam, text, in: attempt.message?.includes(text) }).toEqual({
          pam,
          text,
          in: false,
        });
    }
  });

  it("keeps the password out of every answer and every file under the state root", async () => {
    const o = await office();
    await call(o.srv, "POST", runPath("Mia"), o.callers.ownerSession, {
      action: "enable",
      password: PASSWORD,
    });
    await endedAttempt(o.srv, o.callers.ownerSession, "Mia");
    await call(o.srv, "POST", runPath("Mia"), o.callers.ownerSession, {
      action: "enable",
      password: `${PASSWORD}-wrong`,
    });
    expect(answers.some((a) => a.includes(PASSWORD))).toBe(false);
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
    expect(bytes(o.srv.stateRoot).includes(PASSWORD)).toBe(false);
  });
});
