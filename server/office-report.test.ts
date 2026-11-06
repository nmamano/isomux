// The incident report (task cdd7883d, slice 3), through buildIncidentReport on
// a temp state root laid out as a real office writes it: the secret store,
// member and office env files, and office.sqlite in WAL mode with the lock
// audit rows the rescue command writes. The report goes to Isomux support, so
// every office value in it must come out masked; with the masks unknown, the
// texts that can carry them must stay out.

import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAuditStore, openOfficeDatabase } from "./audit-store.ts";
import { writeStateMarker } from "./lockdown.ts";
import { RESCUE_ACTOR, recordLockAudit } from "./lockdown-audit.ts";
import {
  buildIncidentReport,
  type IncidentReportInput,
} from "./office-report.ts";
import { createSecretStore } from "./secret-store.ts";

const NOW = new Date("2026-11-06T10:00:00.000Z");

let dir = "";
const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function stateRoot(): string {
  dir = mkdtempSync(join(tmpdir(), "office-report-test-"));
  const root = join(dir, ".isomux");
  mkdirSync(root, { mode: 0o700 });
  return root;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function md5(path: string): string {
  return new Bun.CryptoHasher("md5").update(readFileSync(path)).digest("hex");
}

const STORED = "storedvalue-QX7pL2";
const USER_ENV = "userenvvalue-K9wz";
const OFFICE_ENV = "officeenvvalue-M3vb";
// A token shape the redaction knows without the office's values.
const SHAPED = "ghp_" + "A1b2C3d4".repeat(4) + "E5f6";

/** One office secret, one member env value, one office env value. */
function seedSecrets(root: string): void {
  const made = createSecretStore(root).create(
    { kind: "office" },
    {
      name: "MY_KEY",
      value: STORED,
      hosts: ["api.example.com"],
      form: { kind: "authorization" },
    },
  );
  expect(made.ok).toBe(true);
  write(join(root, "user-env", "u1.env"), `MY_ENV=${USER_ENV}\n`);
  write(join(root, "office-env", "office.env"), `OFFICE_K=${OFFICE_ENV}\n`);
}

/** A text that carries every secret, tagged so the test can find where it
 *  landed. */
const leak = (carrier: string) =>
  `${carrier} stored=${STORED} user=${USER_ENV} office=${OFFICE_ENV} shaped=${SHAPED}`;

function input(
  root: string,
  over: Partial<IncidentReportInput> = {},
): IncidentReportInput {
  return {
    stateRoot: root,
    now: NOW,
    statusLines: ["Service        isomux: failed"],
    journal: "journal-plain-line\n",
    release: "v2026.11.6",
    previousRelease: "v2026.11.5",
    updateResult: "update-result-plain",
    note: "note-plain",
    ...over,
  };
}

const SECRETS = [STORED, USER_ENV, OFFICE_ENV, SHAPED];

test("every office secret is masked in the note, the status lines, the journal, the update result and the audit reasons, and each section is still there", () => {
  const root = stateRoot();
  seedSecrets(root);
  recordLockAudit(root, "lockdown", {
    actor: RESCUE_ACTOR,
    reason: leak("carrier-audit"),
    now: NOW,
  });

  const report = buildIncidentReport(
    input(root, {
      note: leak("carrier-note"),
      statusLines: [`Locked         by host: ${leak("carrier-status")}`],
      journal: `journal-first\n${leak("carrier-journal")}\njournal-last\n`,
      updateResult: leak("carrier-update"),
    }),
  );

  expect({
    leaked: SECRETS.filter((s) => report.includes(s)),
    carriers: [
      "carrier-note",
      "carrier-status",
      "carrier-journal",
      "carrier-update",
      "carrier-audit",
      "journal-first",
      "journal-last",
    ].filter((c) => !report.includes(c)),
    releases: ["v2026.11.6", "v2026.11.5"].filter((r) => !report.includes(r)),
  }).toEqual({ leaked: [], carriers: [], releases: [] });
});

// The report is most needed when the office is broken, so an unreadable
// secret source does not stop it; but without the stored values nothing can
// mask them, so the texts that hold the office's own output stay out.
test("with a secrets file it cannot read, the logs and the audit reasons stay out, the rest is written, and the error text is not quoted", () => {
  const root = stateRoot();
  seedSecrets(root);
  recordLockAudit(root, "lockdown", {
    actor: RESCUE_ACTOR,
    reason: `carrier-audit ${STORED}`,
    now: NOW,
  });
  const brokenLine = "broken-line-Zq4";
  write(join(root, "secrets", "users", "u1.json"), `{${brokenLine}`);
  const over = {
    note: `carrier-note shaped=${SHAPED}`,
    journal: `carrier-journal ${STORED}\n`,
  };

  const report = buildIncidentReport(input(root, over));

  expect({
    journal: report.includes("carrier-journal"),
    audit: report.includes("carrier-audit"),
    leaked: SECRETS.filter((s) => report.includes(s)),
    brokenLine: report.includes(brokenLine),
    note: report.includes("carrier-note"),
    status: report.includes("isomux: failed"),
  }).toEqual({
    journal: false,
    audit: false,
    leaked: [],
    brokenLine: false,
    note: true,
    status: true,
  });
  // The condition: the same office with that file fixed has both.
  write(
    join(root, "secrets", "users", "u1.json"),
    JSON.stringify({ version: 1, secrets: [] }),
  );
  const fixed = buildIncidentReport(input(root, over));
  expect({
    journal: fixed.includes("carrier-journal"),
    audit: fixed.includes("carrier-audit"),
    leaked: SECRETS.filter((s) => fixed.includes(s)),
  }).toEqual({ journal: true, audit: true, leaked: [] });
});

// The status lines carry the lock marker's reason: the same text as the
// audit reason, so it stays out with it.
test("with a secrets file it cannot read, the lock reason in the status lines stays out too", () => {
  const root = stateRoot();
  seedSecrets(root);
  const reason = `carrier-reason ${STORED}`;
  writeStateMarker(root, { reason, by: "host", now: NOW });
  const statusLines = [
    "Service        isomux: active",
    `Locked         by host since ${NOW.toISOString()}: ${reason} (${join(root, "LOCKDOWN")})`,
  ];
  write(join(root, "secrets", "users", "u1.json"), "{broken");
  const report = buildIncidentReport(input(root, { statusLines }));
  expect({
    leaked: report.includes(STORED),
    reason: report.includes("carrier-reason"),
    service: report.includes("isomux: active"),
  }).toEqual({ leaked: false, reason: false, service: true });

  // The condition: readable secrets keep the reason, masked.
  write(
    join(root, "secrets", "users", "u1.json"),
    JSON.stringify({ version: 1, secrets: [] }),
  );
  const fixed = buildIncidentReport(input(root, { statusLines }));
  expect({
    leaked: fixed.includes(STORED),
    reason: fixed.includes("carrier-reason"),
  }).toEqual({ leaked: false, reason: true });
});

test("the same holds for an env file it cannot parse", () => {
  const root = stateRoot();
  seedSecrets(root);
  const bareLine = "bare-env-line-W2x";
  write(join(root, "office-env", "broken.env"), `OK=fine-123\n${bareLine}\n`);
  const report = buildIncidentReport(
    input(root, { journal: `carrier-journal ${OFFICE_ENV}\n` }),
  );
  expect({
    journal: report.includes("carrier-journal"),
    leaked: SECRETS.filter((s) => report.includes(s)),
    bareLine: report.includes(bareLine),
  }).toEqual({ journal: false, leaked: [], bareLine: false });
});

test("the last 20 lock and unlock audit rows, newest kept, a row only in the WAL included, and office.sqlite is not written", () => {
  const root = stateRoot();
  for (let i = 1; i <= 24; i++)
    recordLockAudit(root, i % 2 ? "lockdown" : "unlock", {
      actor: RESCUE_ACTOR,
      reason: `reason-${String(i).padStart(2, "0")}`,
      now: new Date(+NOW - (30 - i) * 60_000),
    });
  // The office's own connection, still open: the last lock is in the WAL only.
  const path = join(root, "office.sqlite");
  const db = openOfficeDatabase(path);
  open.push(db);
  db.exec("PRAGMA wal_autocheckpoint=0");
  createAuditStore(db).append({
    operation: "office.lockdown",
    actor: RESCUE_ACTOR,
    targets: ["office"],
    fields: [],
    lockdown: { reason: "reason-25" },
    time: +NOW - 60_000,
  });
  // Not a lock row: never listed.
  createAuditStore(db).append({
    operation: "task.create",
    actor: RESCUE_ACTOR,
    targets: ["task:x"],
    fields: [],
    time: +NOW - 30_000,
  });
  // The condition: reason-25 is not in the main file.
  const copy = join(dir, "main-only.sqlite");
  copyFileSync(path, copy);
  const mainOnly = new Database(copy);
  const inMain = mainOnly
    .query("SELECT count(*) AS n FROM audit WHERE record LIKE '%reason-25%'")
    .get() as { n: number };
  mainOnly.close();
  expect(inMain.n).toBe(0);
  const before = {
    db: md5(path),
    wal: existsSync(`${path}-wal`) ? md5(`${path}-wal`) : "none",
  };

  const report = buildIncidentReport(input(root));

  const shown = Array.from(
    { length: 25 },
    (_, i) => `reason-${String(i + 1).padStart(2, "0")}`,
  ).filter((r) => report.includes(r));
  expect(shown).toEqual(
    Array.from(
      { length: 20 },
      (_, i) => `reason-${String(i + 6).padStart(2, "0")}`,
    ),
  );
  expect(report.includes("task:x")).toBe(false);
  expect({
    db: md5(path),
    wal: existsSync(`${path}-wal`) ? md5(`${path}-wal`) : "none",
  }).toEqual(before);
});

// With the office down, a read-write connection would be the last one, and
// its close would checkpoint the WAL into office.sqlite.
test("with the office down after a crash, a lock row only in the WAL shows, and the database files are not changed", async () => {
  const root = stateRoot();
  const path = join(root, "office.sqlite");
  recordLockAudit(root, "unlock", {
    actor: RESCUE_ACTOR,
    reason: "",
    now: NOW,
  });
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { openOfficeDatabase, createAuditStore } from ${JSON.stringify(join(import.meta.dir, "audit-store.ts"))};
       const db = openOfficeDatabase(${JSON.stringify(path)});
       db.exec("PRAGMA wal_autocheckpoint=0");
       createAuditStore(db).append({ operation: "office.lockdown", actor: { kind: "admin_cli", id: "rescue", name: "rescue" }, targets: ["office"], fields: [], lockdown: { reason: "crash-reason" }, time: ${+NOW} });
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
  // The condition: the row is in the WAL alone.
  expect(child.signalCode).toBe("SIGKILL");
  const copy = join(dir, "main-only.sqlite");
  copyFileSync(path, copy);
  const mainOnly = new Database(copy);
  const inMain = mainOnly
    .query("SELECT count(*) AS n FROM audit WHERE record LIKE '%crash-reason%'")
    .get() as { n: number };
  mainOnly.close();
  expect(inMain.n).toBe(0);
  const before = { db: md5(path), wal: md5(`${path}-wal`) };

  const report = buildIncidentReport(input(root));

  expect({
    shown: report.includes("crash-reason"),
    db: md5(path),
    wal: existsSync(`${path}-wal`) ? md5(`${path}-wal`) : "gone",
  }).toEqual({ shown: true, ...before });
});

test("an office with no database and no journal still gets a report", () => {
  const root = stateRoot();
  const report = buildIncidentReport(
    input(root, {
      journal: null,
      release: null,
      previousRelease: null,
      updateResult: null,
    }),
  );
  expect(report.includes("isomux: failed")).toBe(true);
  expect(existsSync(join(root, "office.sqlite"))).toBe(false);
});
