// A locked office, booted the way the unit boots it (task cdd7883d): the real
// entry, a temp state root that carries the state marker. The boot gate in
// runOfficeMain must start the locked listener instead of the office, so this
// runs server/isomux-office.ts itself and not startLockedOffice.
//
// Not the test's own environment: an office started from an agent shell
// would read the live office's settings (see boot-codex-prep.test.ts).

import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import {
  LOCK_MARKER_FILE,
  LOCKED_HEADER,
  LOCKED_READY_BODY,
  LOCKDOWN_DIR_PREFIX,
  QUARANTINED_FILES,
} from "./lockdown.ts";
import { EXPORTS_SUBDIR } from "./office-export-jobs.ts";

const REPO = join(import.meta.dir, "..");
const ENTRY = join(import.meta.dir, "isomux-office.ts");
const READY_BUDGET_MS = 20_000;

let office: Subprocess | null = null;
let dir = "";

afterEach(async () => {
  if (office) {
    office.kill("SIGKILL");
    await office.exited;
  }
  office = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// One raw HTTP/1.1 request, so the Host and Upgrade headers go out as written.
async function rawRequest(
  port: number,
  lines: string[],
): Promise<{ status: number; head: string }> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let data = "";
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error(`no answer; got ${JSON.stringify(data)}`));
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("latin1");
      const end = data.indexOf("\r\n\r\n");
      if (end >= 0) {
        socket.destroy();
        const head = data.slice(0, end);
        resolve({
          status: Number(head.split(" ")[1]),
          head: head.toLowerCase(),
        });
      }
    });
    socket.on("error", reject);
    socket.write([...lines, "", ""].join("\r\n"));
  });
}

test("a state root with the lock marker boots the locked office: /readyz says locked, every other request gets the locked 503, the credential files are moved aside, and no owner export is left", async () => {
  dir = mkdtempSync(join(tmpdir(), "locked-office-"));
  const home = join(dir, "home");
  const stateRoot = join(home, ".isomux");
  const scratch = join(dir, "tmp");
  mkdirSync(stateRoot, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  // The host command could not move them (a container, or --stop): the
  // locked boot's safety net does.
  for (const name of QUARANTINED_FILES)
    writeFileSync(join(stateRoot, name), "{}");
  // The marker as the host command writes it; its presence is what locks.
  writeFileSync(
    join(stateRoot, LOCK_MARKER_FILE),
    JSON.stringify({
      since: new Date().toISOString(),
      reason: "test",
      by: "host",
      stateRoot,
    }),
  );
  // An owner export a lock must not leave downloadable on the next unlock
  // (slice 4): the locked boot empties the exports folder of the backup folder.
  const strayExport = join(dir, "backups", EXPORTS_SUBDIR, "office.tar.gz");
  mkdirSync(join(dir, "backups", EXPORTS_SUBDIR), { recursive: true });
  writeFileSync(strayExport, "the office, packed");
  const port = await freePort();
  office = Bun.spawn([process.execPath, ENTRY], {
    cwd: REPO,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      ISOMUX_HOME: stateRoot,
      ISOMUX_BACKUP_DIR: join(dir, "backups"),
      XDG_CONFIG_HOME: join(home, ".config"),
      TMPDIR: scratch,
      PORT: String(port),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output += decoder.decode(chunk);
  };
  void collect(office.stdout as ReadableStream<Uint8Array>);
  void collect(office.stderr as ReadableStream<Uint8Array>);

  // The first answer of the bound port. Today's office answers "ok\n" here.
  let ready: { status: number; body: string; locked: string | null } | null =
    null;
  const deadline = performance.now() + READY_BUDGET_MS;
  while (performance.now() < deadline && office.exitCode === null) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/readyz`);
      ready = {
        status: res.status,
        body: await res.text(),
        locked: res.headers.get(LOCKED_HEADER),
      };
      break;
    } catch {
      await Bun.sleep(50);
    }
  }
  if (!ready) console.error(output.slice(-3000));
  // update.sh polls with curl -f: a locked office still reads as up.
  expect(ready).toEqual({
    status: 200,
    body: LOCKED_READY_BODY,
    locked: "1",
  });

  // The office's own pages and API, an app host, a WebSocket upgrade: one
  // locked answer, with the header the container probe accepts.
  const plain = await fetch(`http://127.0.0.1:${port}/`, {
    redirect: "manual",
  });
  const api = await fetch(`http://127.0.0.1:${port}/api/agents`, {
    redirect: "manual",
  });
  const appHost = await rawRequest(port, [
    "GET / HTTP/1.1",
    "Host: board.apps.office.example.com",
    "Connection: close",
  ]);
  const upgrade = await rawRequest(port, [
    "GET /ws HTTP/1.1",
    `Host: localhost:${port}`,
    `Origin: http://localhost:${port}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Version: 13",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
  ]);
  const pageText = await plain.text();
  expect({
    root: [plain.status, plain.headers.get(LOCKED_HEADER)],
    api: [api.status, api.headers.get(LOCKED_HEADER)],
    appHost: [
      appHost.status,
      appHost.head.includes(`${LOCKED_HEADER.toLowerCase()}: 1`),
    ],
    upgrade: [
      upgrade.status,
      upgrade.head.includes(`${LOCKED_HEADER.toLowerCase()}: 1`),
    ],
  }).toEqual({
    root: [503, "1"],
    api: [503, "1"],
    appHost: [503, true],
    upgrade: [503, true],
  });
  // A static page: no script, nothing it loads.
  expect(plain.headers.get("content-type") ?? "").toContain("text/html");
  expect(pageText).not.toMatch(/<script|<link|src=/i);

  // The safety net ran before the listener answered.
  for (const name of QUARANTINED_FILES)
    expect(existsSync(join(stateRoot, name))).toBe(false);
  expect(existsSync(strayExport)).toBe(false);
  const moved = readdirSync(stateRoot).filter((n) =>
    n.startsWith(LOCKDOWN_DIR_PREFIX),
  );
  expect(moved).toHaveLength(1);
  expect(readdirSync(join(stateRoot, moved[0])).sort()).toEqual(
    [...QUARANTINED_FILES].sort(),
  );
  expect(readFileSync(join(stateRoot, moved[0], "sessions.json"), "utf8")).toBe(
    "{}",
  );

  // No office boot ran: a full boot creates the office database.
  expect(existsSync(join(stateRoot, "office.sqlite"))).toBe(false);

  // The locked office stays up, so Restart=always does not loop.
  await Bun.sleep(500);
  expect(office.exitCode).toBeNull();
}, 30_000);
