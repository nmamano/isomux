// The office export (task cdd7883d, slice 2), through exportOffice on a temp
// state root laid out as a real office writes it: agents.json, users.json,
// logs/<agentId>/ transcripts and files, the secret store, the office
// SQLite database in WAL mode. Each test reads the export dir back as a
// reader would: by walking it.

import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { openOfficeDatabase } from "./audit-store.ts";
import {
  redactSecretText,
  setSecretValuesForRedaction,
} from "./log-redaction.ts";
import { exportOffice, type ExportSummary } from "./office-export.ts";
import { createSecretStore } from "./secret-store.ts";

const NOW = new Date("2026-11-06T10:00:00.000Z");
const T0 = Date.parse("2026-11-01T09:00:00.000Z");
const MIB = 1024 * 1024;
// Free space the export asks for on top of its estimate (the agreed design).
const MARGIN = 256 * MIB;
const PLENTY = () => 1e12;

let dir = "";
const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  setSecretValuesForRedaction([]);
  if (dir) {
    // A test may leave an unreadable file behind.
    for (const entry of readdirSync(dir, {
      recursive: true,
      withFileTypes: true,
    }))
      chmodSync(
        join(entry.parentPath, entry.name),
        entry.isDirectory() ? 0o700 : 0o600,
      );
    rmSync(dir, { recursive: true, force: true });
  }
  dir = "";
});

interface Bed {
  stateRoot: string;
  outDir: string;
}

function bed(): Bed {
  dir = mkdtempSync(join(tmpdir(), "office-export-test-"));
  const stateRoot = join(dir, ".isomux");
  mkdirSync(stateRoot, { mode: 0o700 });
  return { stateRoot, outDir: join(dir, "out") };
}

function write(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function entry(
  agentId: string,
  i: number,
  kind: string,
  content: string,
): Record<string, unknown> {
  return { id: `e${i}`, agentId, timestamp: T0 + i * 1000, kind, content };
}

function jsonl(entries: Record<string, unknown>[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/** One room with one agent, a member, one session. */
function seedOffice(stateRoot: string): void {
  write(
    join(stateRoot, "agents.json"),
    JSON.stringify([
      {
        id: "room-a",
        name: "Room A",
        prompt: "room prompt",
        agents: [
          {
            id: "agent-one",
            name: "Agent One",
            desk: 0,
            cwd: "/srv/work",
            agentType: "claude",
            roomId: "room-a",
            customInstructions: "agent prompt",
          },
        ],
      },
    ]),
  );
  write(
    join(stateRoot, "users.json"),
    JSON.stringify({
      u1: { id: "u1", name: "Ann", role: "owner", allowedRooms: [] },
    }),
  );
}

function allFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

function allText(root: string): string {
  return allFiles(root)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
}

/** The one rendered session whose file name ends with the session id. */
function sessionFile(outDir: string, sessionId: string): string {
  const found = allFiles(outDir).filter((f) => f.endsWith(`-${sessionId}.md`));
  expect(found).toHaveLength(1);
  return found[0];
}

function md5(path: string): string {
  return new Bun.CryptoHasher("md5").update(readFileSync(path)).digest("hex");
}

/** Whether a task row is in office.sqlite's main file alone, without the
 *  WAL: a copy of just that file, opened on its own. */
function inMainFile(stateRoot: string, taskId: string): boolean {
  const copy = join(dir, "main-only.sqlite");
  copyFileSync(join(stateRoot, "office.sqlite"), copy);
  const db = new Database(copy);
  try {
    return db.query("SELECT 1 FROM tasks WHERE id=?").get(taskId) !== null;
  } catch {
    return false;
  } finally {
    db.close();
    rmSync(copy, { force: true });
  }
}

const TASK = (id: string, title: string, description = "") =>
  JSON.stringify({
    id,
    title,
    description,
    status: "open",
    createdBy: "Ann",
    createdAt: T0,
    roomId: "room-a",
  });

test("a task that is only in the WAL, with the office up, shows in tasks.md; the export holds no SQLite file", async () => {
  const b = bed();
  seedOffice(b.stateRoot);
  // The office's own connection, still open: it never checkpoints.
  const db = openOfficeDatabase(join(b.stateRoot, "office.sqlite"));
  open.push(db);
  db.exec("PRAGMA wal_autocheckpoint=0");
  db.query("INSERT INTO tasks (id, record) VALUES (?, ?)").run(
    "aaaa0001",
    TASK("aaaa0001", "walonly-live-title"),
  );
  // The condition this test needs: the row is in the WAL, not the main file.
  expect(inMainFile(b.stateRoot, "aaaa0001")).toBe(false);

  const summary = await exportOffice({
    stateRoot: b.stateRoot,
    outDir: b.outDir,
    now: NOW,
    freeBytes: PLENTY,
  });

  expect(readFileSync(join(b.outDir, "tasks.md"), "utf8")).toContain(
    "walonly-live-title",
  );
  expect(summary.tasks).toBe(1);
  // Tasks, asks and the audit go out rendered and redacted, never raw.
  const sqliteFiles = allFiles(b.outDir).filter((f) =>
    readFileSync(f).subarray(0, 16).equals(Buffer.from("SQLite format 3\0")),
  );
  expect(sqliteFiles.map((f) => relative(b.outDir, f))).toEqual([]);
  // The office's connection still works.
  expect(db.query("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 1 });
});

test("with the office down after a crash, a WAL-only task shows, and the database files are not changed", async () => {
  const b = bed();
  seedOffice(b.stateRoot);
  const path = join(b.stateRoot, "office.sqlite");
  // A writer that dies without closing: its row stays in the WAL alone.
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { openOfficeDatabase } from ${JSON.stringify(join(import.meta.dir, "audit-store.ts"))};
       const db = openOfficeDatabase(${JSON.stringify(path)});
       db.exec("PRAGMA wal_autocheckpoint=0");
       db.query("INSERT INTO tasks (id, record) VALUES (?, ?)").run("bbbb0002", ${JSON.stringify(TASK("bbbb0002", "walonly-crash-title"))});
       process.kill(process.pid, "SIGKILL");`,
    ],
    {
      cwd: join(import.meta.dir, ".."),
      env: process.env,
      stdout: "ignore",
      stderr: "inherit",
    },
  );
  await child.exited;
  expect(child.signalCode).toBe("SIGKILL");
  expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
  expect(inMainFile(b.stateRoot, "bbbb0002")).toBe(false);
  const before = { db: md5(path), wal: md5(`${path}-wal`) };

  await exportOffice({
    stateRoot: b.stateRoot,
    outDir: b.outDir,
    now: NOW,
    freeBytes: PLENTY,
  });

  expect(readFileSync(join(b.outDir, "tasks.md"), "utf8")).toContain(
    "walonly-crash-title",
  );
  // No checkpoint: the export never wrote the live database.
  expect({
    db: md5(path),
    wal: existsSync(`${path}-wal`) ? md5(`${path}-wal`) : "gone",
  }).toEqual(before);
});

test("stored secrets, member and office env values and secret-shaped strings are masked in conversations, memory, asks and tasks; the server's own redaction list is not touched", async () => {
  const b = bed();
  seedOffice(b.stateRoot);
  const stored = "storedvalue-QX7pL2";
  const userEnv = "userenvvalue-K9wz";
  const officeEnv = "officeenvvalue-M3vb";
  const shaped = "ghp_" + "A1b2C3d4".repeat(4) + "E5f6";
  const made = createSecretStore(b.stateRoot).create(
    { kind: "office" },
    {
      name: "MY_KEY",
      value: stored,
      hosts: ["api.example.com"],
      form: { kind: "authorization" },
    },
  );
  expect(made.ok).toBe(true);
  write(join(b.stateRoot, "user-env", "u1.env"), `MY_ENV=${userEnv}\n`);
  write(
    join(b.stateRoot, "office-env", "office.env"),
    `OFFICE_K=${officeEnv}\n`,
  );
  const leak = (carrier: string) =>
    `${carrier} stored=${stored} user=${userEnv} office=${officeEnv} shaped=${shaped}`;
  write(
    join(b.stateRoot, "logs", "agent-one", "s-redact.jsonl"),
    jsonl([entry("agent-one", 1, "text", leak("carrier-log"))]),
  );
  write(join(b.stateRoot, "memory", "office.md"), leak("carrier-memory"));
  write(
    join(b.stateRoot, "asks.json"),
    JSON.stringify([
      {
        id: "ask00001",
        agentId: "agent-one",
        memberUserId: "u1",
        prompt: leak("carrier-ask"),
        createdAt: T0,
        updatedAt: T0,
        options: ["Yes"],
      },
    ]),
  );
  const db = openOfficeDatabase(join(b.stateRoot, "office.sqlite"));
  db.query("INSERT INTO tasks (id, record) VALUES (?, ?)").run(
    "cccc0003",
    TASK("cccc0003", "a task", leak("carrier-task")),
  );
  db.close();
  // The server's live list, as the secrets runtime would have set it.
  const live = "livelistvalue-Zx81";
  setSecretValuesForRedaction([live]);

  await exportOffice({
    stateRoot: b.stateRoot,
    outDir: b.outDir,
    now: NOW,
    freeBytes: PLENTY,
  });

  const text = allText(b.outDir);
  // Each place was exported...
  for (const carrier of [
    "carrier-log",
    "carrier-memory",
    "carrier-ask",
    "carrier-task",
  ])
    expect({ carrier, found: text.includes(carrier) }).toEqual({
      carrier,
      found: true,
    });
  expect(readFileSync(sessionFile(b.outDir, "s-redact"), "utf8")).toContain(
    "ISOMUX-REDACTED",
  );
  // ...and no value left it.
  expect(
    [stored, userEnv, officeEnv, shaped].filter((v) => text.includes(v)),
  ).toEqual([]);
  // The live list is the server's: the export neither replaced nor cleared it.
  expect({
    live: redactSecretText(live) === live,
    stored: redactSecretText(stored) === stored,
  }).toEqual({ live: false, stored: true });
});

test("credential files and stores never reach the export, and README names every top-level entry left out", async () => {
  const b = bed();
  seedOffice(b.stateRoot);
  write(join(b.stateRoot, "memory", "office.md"), "kept-memory-line");
  // A sentinel that no redaction rule touches: only leaving the file out
  // keeps it out of the export.
  const sentinel = (where: string) => `SENTINEL-${where}-zq`;
  const planted: Record<string, string> = {
    "api-tokens.json": "api-tokens",
    "sessions.json": "sessions",
    "invites.json": "invites",
    "web-push.json": "web-push",
    "pager-settings.json": "pager-settings",
    "browser-connections.json": "browser-connections",
    "secrets/ca-key.pem": "secrets",
    "secrets/apps/my-app/TOKEN": "secrets-apps",
    "provider-homes/u1/.claude/.credentials.json": "provider-homes",
    "codex-home/auth.json": "codex-home",
    "opencode/auth.json": "opencode",
    "apps/my-app/.env": "apps",
    "cronjobs/job/token": "cronjobs",
    "webhooks/secrets.json": "webhooks",
    "mcp-servers/server.json": "mcp-servers",
    "browser-profiles/p1/Cookies": "browser-profiles",
    "whatsapp/auth/creds.json": "whatsapp",
    "discord/auth.json": "discord",
    "backups/office-backup.tar": "backups",
    "user-env/u1.env": "user-env",
    "office-env/office.env": "office-env",
    // A .env file inside a dir the export copies.
    "memory/.env": "memory-dotenv",
    // A store added after this export was written.
    "brand-new-store/creds.json": "brand-new-store",
  };
  for (const [path, where] of Object.entries(planted))
    // A comment line: in an env file it is no value, so no redaction masks it.
    write(join(b.stateRoot, path), `# ${sentinel(where)}\n`);

  await exportOffice({
    stateRoot: b.stateRoot,
    outDir: b.outDir,
    now: NOW,
    freeBytes: PLENTY,
  });

  const text = allText(b.outDir);
  // The export ran: an allowlisted file made it.
  expect(text).toContain("kept-memory-line");
  expect(
    Object.values(planted).filter((where) => text.includes(sentinel(where))),
  ).toEqual([]);
  const readme = readFileSync(join(b.outDir, "README.md"), "utf8");
  expect(
    ["brand-new-store", "secrets", "provider-homes", "api-tokens.json"].filter(
      (name) => !readme.includes(name),
    ),
  ).toEqual([]);
});

test("refuses a dir that has content or sits inside the state root; an empty dir is used; dirs are 0700 and files 0600", async () => {
  const b = bed();
  seedOffice(b.stateRoot);
  write(join(b.stateRoot, "memory", "office.md"), "kept-memory-line");
  write(join(b.stateRoot, "logs", "agent-one", "files", "f1.png"), "png");
  write(
    join(b.stateRoot, "logs", "agent-one", "s-mode.jsonl"),
    jsonl([entry("agent-one", 1, "text", "hello")]),
  );

  const busy = join(dir, "busy");
  write(join(busy, "keep.txt"), "mine");
  await expect(
    exportOffice({
      stateRoot: b.stateRoot,
      outDir: busy,
      now: NOW,
      freeBytes: PLENTY,
    }),
  ).rejects.toThrow();
  expect(readdirSync(busy)).toEqual(["keep.txt"]);

  const inside = join(b.stateRoot, "export");
  await expect(
    exportOffice({
      stateRoot: b.stateRoot,
      outDir: inside,
      now: NOW,
      freeBytes: PLENTY,
    }),
  ).rejects.toThrow();
  expect(existsSync(inside)).toBe(false);

  // The root wrapper makes the dir empty and hands it over.
  const empty = join(dir, "empty");
  mkdirSync(empty, { mode: 0o755 });
  await exportOffice({
    stateRoot: b.stateRoot,
    outDir: empty,
    now: NOW,
    freeBytes: PLENTY,
  });
  const entries = readdirSync(empty, { recursive: true, withFileTypes: true });
  // The condition: the export wrote nested dirs and files.
  expect(entries.filter((e) => e.isFile()).length).toBeGreaterThan(3);
  expect(entries.filter((e) => e.isDirectory()).length).toBeGreaterThan(0);
  const loose = [
    { path: ".", mode: statSync(empty).mode & 0o777, want: 0o700 },
    ...entries.map((e) => ({
      path: relative(empty, join(e.parentPath, e.name)),
      mode: statSync(join(e.parentPath, e.name)).mode & 0o777,
      want: e.isDirectory() ? 0o700 : 0o600,
    })),
  ].filter((e) => e.mode !== e.want);
  expect(loose).toEqual([]);
});

test("conversations: by room and agent, removed agents under _removed, .jsonl.gz rendered, attachments copied, tool results cut and messages whole", async () => {
  const b = bed();
  seedOffice(b.stateRoot);
  const logs = join(b.stateRoot, "logs");
  const long = (word: string) =>
    `${word}-` + "x".repeat(10 * 1024) + `-${word}-end`;
  write(
    join(logs, "agent-one", "s-live.jsonl"),
    jsonl([
      entry("agent-one", 1, "user_message", long("usermsg")),
      entry("agent-one", 2, "text", long("agenttext")),
      entry("agent-one", 3, "tool_result", long("toolout")),
    ]),
  );
  write(
    join(logs, "agent-one", "sessions.json"),
    JSON.stringify({ "s-live": { topic: "Topic-Alpha", lastModified: T0 } }),
  );
  write(
    join(logs, "agent-one", "s-zipped.jsonl.gz"),
    gzipSync(jsonl([entry("agent-one", 1, "text", "zipped-line")])),
  );
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
  write(join(logs, "agent-one", "files", "abc123.png"), png);
  write(
    join(logs, "agent-gone", "s-gone.jsonl"),
    jsonl([entry("agent-gone", 1, "text", "gone-line")]),
  );

  const summary: ExportSummary = await exportOffice({
    stateRoot: b.stateRoot,
    outDir: b.outDir,
    now: NOW,
    freeBytes: PLENTY,
  });

  const conversations = join(b.outDir, "conversations");
  const agentDir = join(conversations, "Room A", "Agent One");
  const live = sessionFile(b.outDir, "s-live");
  expect({
    live: dirname(live),
    zipped: dirname(sessionFile(b.outDir, "s-zipped")),
    gone: dirname(sessionFile(b.outDir, "s-gone")),
  }).toEqual({
    live: agentDir,
    zipped: agentDir,
    gone: join(conversations, "_removed", "agent-gone"),
  });
  const liveText = readFileSync(live, "utf8");
  expect(readFileSync(sessionFile(b.outDir, "s-zipped"), "utf8")).toContain(
    "zipped-line",
  );
  expect(readFileSync(sessionFile(b.outDir, "s-gone"), "utf8")).toContain(
    "gone-line",
  );
  expect({
    topic: liveText.includes("Topic-Alpha"),
    userWhole: liveText.includes(long("usermsg")),
    agentWhole: liveText.includes(long("agenttext")),
    toolStart: liveText.includes("toolout-" + "x".repeat(1000)),
    toolWhole: liveText.includes(long("toolout")),
    toolEnd: liveText.includes("-toolout-end"),
  }).toEqual({
    topic: true,
    userWhole: true,
    agentWhole: true,
    toolStart: true,
    toolWhole: false,
    toolEnd: false,
  });
  // Attachments go out as bytes, next to the agent's sessions.
  expect(
    new Uint8Array(readFileSync(join(agentDir, "files", "abc123.png"))),
  ).toEqual(png);
  expect(summary.sessions).toBe(3);
  expect(summary.skipped).toEqual([]);
});

test("a name that is a path cannot write outside the export dir", async () => {
  const b = bed();
  write(
    join(b.stateRoot, "agents.json"),
    JSON.stringify([
      // A slash after a plain start, and a bare "..": each one alone climbs
      // out of conversations/ when it is not made safe.
      {
        id: "room-x",
        name: "x/../../../escaped-room",
        prompt: "",
        agents: [{ id: "agent-x", name: "agent-x", roomId: "room-x" }],
      },
      {
        id: "room-y",
        name: "..",
        prompt: "",
        agents: [{ id: "agent-y", name: "..", roomId: "room-y" }],
      },
    ]),
  );
  for (const id of ["agent-x", "agent-y"])
    write(
      join(b.stateRoot, "logs", id, `s-${id}.jsonl`),
      jsonl([entry(id, 1, "text", `line-of-${id}`)]),
    );

  await exportOffice({
    stateRoot: b.stateRoot,
    outDir: b.outDir,
    now: NOW,
    freeBytes: PLENTY,
  });

  for (const id of ["agent-x", "agent-y"])
    expect(readFileSync(sessionFile(b.outDir, `s-${id}`), "utf8")).toContain(
      `line-of-${id}`,
    );
  // The test dir holds the state root and the export, nothing else.
  expect(readdirSync(dir).sort()).toEqual([".isomux", "out"]);
});

test("a torn last line is dropped quietly; a file it cannot read is listed as skipped and the export goes on", async () => {
  const b = bed();
  seedOffice(b.stateRoot);
  write(
    join(b.stateRoot, "logs", "agent-one", "s-torn.jsonl"),
    jsonl([entry("agent-one", 1, "text", "before-the-tear")]) +
      '{"id":"e2","agentId":"agent-one","kin',
  );
  write(join(b.stateRoot, "memory", "office.md"), "kept-memory-line");
  const locked = join(b.stateRoot, "memory", "agents", "locked.md");
  write(locked, "unreadable");
  chmodSync(locked, 0o000);

  const summary = await exportOffice({
    stateRoot: b.stateRoot,
    outDir: b.outDir,
    now: NOW,
    freeBytes: PLENTY,
  });

  expect(readFileSync(sessionFile(b.outDir, "s-torn"), "utf8")).toContain(
    "before-the-tear",
  );
  expect(allText(b.outDir)).toContain("kept-memory-line");
  expect(summary.skipped).toHaveLength(1);
  expect(summary.skipped[0]).toContain("locked.md");
});

test("refuses before writing when free space is under the estimate, attachments counted, plus the margin", async () => {
  const b = bed();
  seedOffice(b.stateRoot);
  write(
    join(b.stateRoot, "logs", "agent-one", "files", "big.bin"),
    new Uint8Array(MIB),
  );
  const seen: string[] = [];
  const short = (d: string) => {
    seen.push(d);
    return MARGIN + MIB / 2;
  };

  await expect(
    exportOffice({
      stateRoot: b.stateRoot,
      outDir: b.outDir,
      now: NOW,
      freeBytes: short,
    }),
  ).rejects.toThrow();
  // The condition: the export asked about free space.
  expect(seen.length).toBeGreaterThan(0);
  expect(existsSync(b.outDir) ? readdirSync(b.outDir) : []).toEqual([]);

  // Enough room: the same office exports.
  const summary = await exportOffice({
    stateRoot: b.stateRoot,
    outDir: b.outDir,
    now: NOW,
    freeBytes: () => MARGIN + 8 * MIB,
  });
  expect(summary.bytes).toBeGreaterThan(MIB);
});

// Without the stored values the export cannot mask them, so a secrets file
// it cannot read stops the export: it fails closed, not open.
test("refuses when a secrets file cannot be read, and writes no conversation", async () => {
  const b = bed();
  seedOffice(b.stateRoot);
  write(
    join(b.stateRoot, "logs", "agent-one", "s-closed.jsonl"),
    jsonl([entry("agent-one", 1, "text", "closed-line")]),
  );
  write(join(b.stateRoot, "secrets", "users", "u1.json"), "{not json");

  await expect(
    exportOffice({
      stateRoot: b.stateRoot,
      outDir: b.outDir,
      now: NOW,
      freeBytes: PLENTY,
    }),
  ).rejects.toThrow();
  const written = existsSync(b.outDir) ? allText(b.outDir) : "";
  expect(written.includes("closed-line")).toBe(false);

  // The condition: the same office with that file fixed exports the line.
  write(
    join(b.stateRoot, "secrets", "users", "u1.json"),
    JSON.stringify({ version: 1, secrets: [] }),
  );
  rmSync(b.outDir, { recursive: true, force: true });
  await exportOffice({
    stateRoot: b.stateRoot,
    outDir: b.outDir,
    now: NOW,
    freeBytes: PLENTY,
  });
  expect(readFileSync(sessionFile(b.outDir, "s-closed"), "utf8")).toContain(
    "closed-line",
  );
});

// The rescue command prints the error on the terminal, so it may name the
// file but never quote it: a broken line of an env file is often a value.
test("an env file it cannot parse stops the export, and the error names the file without quoting it", async () => {
  const b = bed();
  seedOffice(b.stateRoot);
  const bare = "bare-secret-line-Q8w";
  write(
    join(b.stateRoot, "user-env", "u1.env"),
    `MY_ENV=fine-value-123\n${bare}\n`,
  );

  const error = await exportOffice({
    stateRoot: b.stateRoot,
    outDir: b.outDir,
    now: NOW,
    freeBytes: PLENTY,
  }).then(
    () => null,
    (e: unknown) => e as Error,
  );

  expect({
    refused: error !== null,
    names: error?.message.includes(join("user-env", "u1.env")) ?? false,
    quotes: error?.message.includes(bare) ?? false,
    written: existsSync(b.outDir) ? readdirSync(b.outDir) : [],
  }).toEqual({ refused: true, names: true, quotes: false, written: [] });
});
