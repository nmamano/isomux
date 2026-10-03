// Admin socket peer check (task 636901c1, internal-docs/owner-login-recovery-design.md).
//
// The socket answers root and ISOMUX_RECOVERY_UID only, and never the server's
// own uid, which every agent shares. The requests are the real curl lines
// that install.sh (claim_owner) and the control plane's mint-invite.sh send,
// read out of those scripts, so a parser change that breaks a caller fails
// here. The peer uid is injected except in the same-uid test, which reads
// it from the kernel.

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { resolveAllowedPeerUids, startAdminSocket } from "../admin-socket.ts";
import { ownerLoginCommand } from "../admin-cli.ts";
import { listInvites, peekInvite } from "../auth.ts";

const REPO = join(import.meta.dir, "..", "..");
const SERVER_UID = process.getuid?.() ?? -1;

let server: TestServer | null = null;
let admin: { stop(): void } | null = null;
let dir: string | null = null;
afterEach(async () => {
  admin?.stop();
  admin = null;
  await server?.stop();
  server = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

// The caller's curl command, joined across its line continuations.
function callerCurl(script: string): string {
  const text = readFileSync(join(REPO, script), "utf8").replace(
    /\\\n\s*/g,
    "",
  );
  const start = text.indexOf("curl -fsS --unix-socket");
  const tail = `'{name: $name}')"`;
  const end = text.indexOf(tail, start);
  if (start < 0 || end < 0) throw new Error(`no admin curl in ${script}`);
  return text.slice(start, end + tail.length);
}

// Async: the socket under test runs on this process's event loop.
async function runCaller(
  script: string,
  socketPath: string,
  owner: string,
): Promise<{ exitCode: number; stdout: string }> {
  const child = Bun.spawn(
    ["bash", "-c", `resp=$(${callerCurl(script)}) || exit $?; printf %s "$resp"`],
    { env: { ...process.env, ADMIN_SOCK: socketPath, owner }, stdout: "pipe" },
  );
  const stdout = await new Response(child.stdout).text();
  return { exitCode: await child.exited, stdout };
}

async function start(options: {
  peerUid: number | null;
  recoveryUidSetting?: string;
}): Promise<string> {
  server = await startTestServer();
  await server.seedOwner("Boss");
  dir = mkdtempSync(join(tmpdir(), "admin-sock-"));
  const socketPath = join(dir, "admin.sock");
  admin = startAdminSocket({
    socketPath,
    serverUid: SERVER_UID,
    recoveryUidSetting: options.recoveryUidSetting,
    readPeerUid: () => options.peerUid,
  });
  expect(admin).not.toBeNull();
  return socketPath;
}

describe("admin socket peer check", () => {
  for (const script of [
    "deploy/install.sh",
    "control-plane/remote/mint-invite.sh",
  ]) {
    it(`answers a root peer with a live owner sign-in link (${script})`, async () => {
      const socketPath = await start({ peerUid: 0 });
      const { exitCode, stdout } = await runCaller(script, socketPath, "Boss");
      expect(exitCode).toBe(0);
      const body = JSON.parse(stdout) as { ok: boolean; url: string };
      expect(body.ok).toBe(true);
      const token = body.url.split("/i/")[1];
      const peek = peekInvite(token);
      expect("error" in peek).toBe(false);
      expect(peek).toMatchObject({ username: "Boss" });
    });
  }

  it("refuses the server's own uid as read from the kernel", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    dir = mkdtempSync(join(tmpdir(), "admin-sock-"));
    const socketPath = join(dir, "admin.sock");
    admin = startAdminSocket({ socketPath, recoveryUidSetting: undefined });
    expect(admin).not.toBeNull();
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    const { exitCode } = await runCaller("deploy/install.sh", socketPath, "Boss");
    // curl -f exits 22 on an HTTP error status.
    expect(exitCode).toBe(22);
    const response = await fetch("http://localhost/admin/owner-login", {
      unix: socketPath,
      method: "POST",
      body: JSON.stringify({ name: "Boss" }),
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { ok: boolean }).ok).toBe(false);
  });

  it("refuses a peer whose uid could not be read", async () => {
    const socketPath = await start({ peerUid: null });
    expect((await runCaller("deploy/install.sh", socketPath, "Boss")).exitCode).toBe(
      22,
    );
  });

  it("answers ISOMUX_RECOVERY_UID and lets it connect", async () => {
    const recoveryUid = SERVER_UID + 1;
    const socketPath = await start({
      peerUid: recoveryUid,
      recoveryUidSetting: String(recoveryUid),
    });
    expect(statSync(socketPath).mode & 0o777).toBe(0o666);
    expect((await runCaller("deploy/install.sh", socketPath, "Boss")).exitCode).toBe(0);
  });

  it("refuses any other uid while a recovery uid is enabled", async () => {
    const recoveryUid = SERVER_UID + 1;
    const otherUid = SERVER_UID + 2;
    const socketPath = await start({
      peerUid: otherUid,
      recoveryUidSetting: String(recoveryUid),
    });
    expect(statSync(socketPath).mode & 0o777).toBe(0o666);
    const before = listInvites().length;
    const response = await fetch("http://localhost/admin/owner-login", {
      unix: socketPath,
      method: "POST",
      body: JSON.stringify({ name: "Boss" }),
    });
    expect(response.status).toBe(403);
    expect(listInvites().length).toBe(before);
  });

  it("ignores an ISOMUX_RECOVERY_UID that names the server's uid", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const socketPath = await start({
        peerUid: SERVER_UID,
        recoveryUidSetting: String(SERVER_UID),
      });
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);
      expect(
        (await runCaller("deploy/install.sh", socketPath, "Boss")).exitCode,
      ).toBe(22);
      expect(
        errors.mock.calls.some((call) =>
          String(call[0]).includes("ISOMUX_RECOVERY_UID"),
        ),
      ).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("owner-login CLI", () => {
  it("prints a root command that works for a name with a quote", async () => {
    server = await startTestServer();
    await server.seedOwner("Bo'o");
    dir = mkdtempSync(join(tmpdir(), "admin-sock-"));
    const socketPath = join(dir, "admin's.sock");
    admin = startAdminSocket({ socketPath, readPeerUid: () => 0 });
    const command = ownerLoginCommand("Bo'o", socketPath);
    expect(command.startsWith("sudo ")).toBe(true);
    const child = Bun.spawn(["bash", "-c", command.slice("sudo ".length)], {
      stdout: "pipe",
    });
    const body = JSON.parse(await new Response(child.stdout).text()) as {
      url: string;
    };
    expect(await child.exited).toBe(0);
    expect(peekInvite(body.url.split("/i/")[1])).toMatchObject({
      username: "Bo'o",
    });
  });
});

describe("resolveAllowedPeerUids", () => {
  const quiet = () => spyOn(console, "error").mockImplementation(() => {});

  it("allows root and a valid recovery uid", () => {
    expect([...resolveAllowedPeerUids(1000, undefined)]).toEqual([0]);
    expect([...resolveAllowedPeerUids(1000, " 1001 ")]).toEqual([0, 1001]);
  });

  it("drops a malformed or same-uid setting", () => {
    const errors = quiet();
    try {
      for (const setting of ["abc", "-1", "1e3", "1000"])
        expect([...resolveAllowedPeerUids(1000, setting)]).toEqual([0]);
      expect(errors).toHaveBeenCalledTimes(4);
    } finally {
      errors.mockRestore();
    }
  });

  it("refuses root when the server runs as root", () => {
    const errors = quiet();
    try {
      expect([...resolveAllowedPeerUids(0, undefined)]).toEqual([]);
      expect([...resolveAllowedPeerUids(0, "1001")]).toEqual([1001]);
    } finally {
      errors.mockRestore();
    }
  });
});
