// The office export (task cdd7883d, slice 2): one readable, redacted copy of
// the office's content, for its owner when the office is down or under
// attack. The rescue host command calls it (bun run rescue export), and the
// owner export route will (slice 4). It takes the state root as a parameter
// and only reads it: the SQLite database through a read-only VACUUM INTO,
// which never checkpoints the live WAL.
//
// It copies an allowlist of the state root, never everything minus a
// denylist: a credential file added later is then left out, not leaked.
// README.md names every top-level entry it left out.
//
// Every text it writes passes through the redaction the logs get, with the
// office's own secret values (the secret store, member and office env
// files), collected here and never set on the server's live list. A secrets
// file it cannot read stops the export: without its values it cannot mask
// them. Attachments are copied as bytes.

import { Database } from "bun:sqlite";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { redactSecretTextWith } from "./log-redaction.ts";
import { parseDotenv } from "./persistence.ts";
import { scrubPatterns } from "./secret-proxy/scrub.ts";
import { createSecretStore } from "./secret-store.ts";
import {
  resolveTranscript,
  sessionIdOfTranscript,
} from "./transcript-files.ts";

export interface ExportOptions {
  stateRoot: string;
  /** Must not exist, or be empty; never inside the state root. */
  outDir: string;
  now: Date;
  /** Free bytes on the filesystem that holds dir. Tests inject it. */
  freeBytes?: (dir: string) => number;
}

export interface ExportSummary {
  outDir: string;
  rooms: number;
  agents: number;
  sessions: number;
  tasks: number;
  files: number;
  bytes: number;
  /** State-root paths that could not be read or parsed. */
  skipped: string[];
}

/** Free space the export asks for on top of its estimate. */
const MARGIN_BYTES = 256 * 1024 * 1024;
/** A .jsonl.gz counts this many times its size in the estimate. */
const GZIP_FACTOR = 5;
/** A tool result is cut after this many characters; messages never are. */
const TOOL_RESULT_MAX = 4096;
/** At the top of the out dir until the export finishes. */
export const EXPORT_INCOMPLETE_FILE = "EXPORT-INCOMPLETE";

const DATABASE = "office.sqlite";
// Top-level state-root entries the export reads. Everything else is left
// out and named in README.md.
const RENDERED = new Set([
  "agents.json",
  "users.json",
  "asks.json",
  "logs",
  "token-logs",
  DATABASE,
  `${DATABASE}-wal`,
  `${DATABASE}-shm`,
]);
const COPIED = [
  "memory",
  "members-chat",
  "skills",
  "member-skills",
  "office-prompt.md",
  "scheduled-messages.json",
  "floors.json",
];
// Read only for the secret values to mask; never copied.
const SECRET_SOURCES = new Set(["secrets", "user-env", "office-env"]);
// Directory names under conversations/ that no room may take.
const REMOVED_DIR = "_removed";
const CRON_DIR = "_cron";
const API_TOKENS_DIR = "_api-tokens";
const CRON_LOG_PREFIX = "cronrun-";

// An env file name: never copied, wherever it is.
function isEnvFile(name: string): boolean {
  return name === ".env" || name.startsWith(".env.") || name.endsWith(".env");
}

interface Room {
  id: string;
  name: string;
  agents: { id: string; name: string; roomId: string }[];
}

/** Writes the export. Throws, before it writes anything, when the dir is
 *  not usable, a secrets file cannot be read or the space is short. */
export async function exportOffice(
  options: ExportOptions,
): Promise<ExportSummary> {
  const stateRoot = resolve(options.stateRoot);
  const outDir = resolve(options.outDir);
  if (outDir === stateRoot || outDir.startsWith(stateRoot + sep))
    throw new Error(
      `${outDir} is inside the office's state folder ${stateRoot}: pick a folder outside it`,
    );
  if (existsSync(outDir)) {
    if (!statSync(outDir).isDirectory())
      throw new Error(`${outDir} exists and is not a folder`);
    if (readdirSync(outDir).length > 0)
      throw new Error(`${outDir} is not empty: name a new or empty folder`);
  }
  const patterns = scrubPatterns(collectSecretValues(stateRoot));
  const ex = new Exporter(stateRoot, outDir, options.now, patterns);

  const estimate = ex.estimate();
  const target = nearestDir(outDir);
  const free = (options.freeBytes ?? defaultFreeBytes)(target);
  if (free < estimate + MARGIN_BYTES)
    throw new Error(
      `not enough free space in ${target}: the export needs about ${mib(estimate + MARGIN_BYTES)} MiB, ${mib(free)} MiB are free`,
    );

  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  chmodSync(outDir, 0o700);
  const incomplete = join(outDir, EXPORT_INCOMPLETE_FILE);
  writeFileSync(
    incomplete,
    "This export stopped before it finished. Run it again into an empty folder.\n",
    { mode: 0o600 },
  );
  ex.run();
  rmSync(incomplete);
  return ex.summary();
}

function mib(bytes: number): number {
  return Math.ceil(bytes / (1024 * 1024));
}

function nearestDir(path: string): string {
  let dir = path;
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

function defaultFreeBytes(dir: string): number {
  const s = statfsSync(dir);
  return s.bavail * s.bsize;
}

// Why a secret source could not be read, without its text: a parse error
// can quote the line it stopped at, and that line can be a secret.
function secretSourceError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  const line = /at line (\d+)/.exec(
    error instanceof Error ? error.message : "",
  );
  return line ? `line ${line[1]} does not parse` : "it does not parse";
}

/** Every secret value the office holds. Throws when a secret store file or
 *  an env file cannot be read: the export must not run without them. */
function collectSecretValues(stateRoot: string): string[] {
  const values: string[] = [];
  const store = createSecretStore(stateRoot);
  for (const scope of store.scopes()) {
    try {
      for (const secret of store.readForProxy(scope)) values.push(secret.value);
    } catch (error) {
      const which = scope.kind === "office" ? "office" : `user ${scope.userId}`;
      // No cause: its message can quote the file, and a printer may show it.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        `the ${which} secrets file cannot be read (${secretSourceError(error)}), so the export stopped: it could not remove those secret values from the copy`,
      );
    }
  }
  for (const dir of ["user-env", "office-env"]) {
    const path = join(stateRoot, dir);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path).sort()) {
      if (!name.endsWith(".env")) continue;
      try {
        values.push(
          ...Object.values(parseDotenv(readFileSync(join(path, name), "utf8"))),
        );
      } catch (error) {
        // eslint-disable-next-line preserve-caught-error -- as above
        throw new Error(
          `${dir}/${name} cannot be read (${secretSourceError(error)}), so the export stopped: it could not remove those secret values from the copy`,
        );
      }
    }
  }
  return values;
}

// A name as one path component: no separators, no control characters, no
// leading dot, never empty.
function safeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  let safe = name.replace(/[/\\\u0000-\u001f\u007f]/g, "_").trim();
  if (safe.startsWith(".")) safe = "_" + safe;
  if (!safe) safe = "_";
  return safe.slice(0, 120);
}

function isoDay(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "";
}

function isoTime(ms: number): string {
  return Number.isFinite(ms)
    ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC"
    : "";
}

// A fence longer than any backtick run in the text.
function fenced(text: string, lang = ""): string {
  let longest = 2;
  for (const run of text.match(/`+/g) ?? [])
    longest = Math.max(longest, run.length);
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

// A stored field as text: strings and numbers as they are, anything else empty.
function str(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? `${value}`
    : "";
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

class Exporter {
  private bytes = 0;
  private files = 0;
  private sessions = 0;
  private tasks = 0;
  private skipped: string[] = [];
  private rooms: Room[] = [];
  private agentNames = new Map<string, string>();
  private userNames = new Map<string, string>();
  // The names already taken in each output dir.
  private taken = new Map<string, Set<string>>();

  constructor(
    private stateRoot: string,
    private outDir: string,
    private now: Date,
    private patterns: string[],
  ) {}

  private redact(text: string): string {
    return redactSecretTextWith(this.patterns, text);
  }

  private redactValue(value: unknown): unknown {
    if (typeof value === "string") return this.redact(value);
    if (Array.isArray(value)) return value.map((v) => this.redactValue(v));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, this.redactValue(v)]),
      );
    return value;
  }

  private skip(path: string, error: unknown): void {
    // A parse error can quote the text it stopped at.
    const why = this.redact(
      error instanceof Error ? error.message : str(error),
    );
    this.skipped.push(`${relative(this.stateRoot, path)}: ${why}`);
  }

  private ensureDir(rel: string): string {
    const path = join(this.outDir, rel);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  }

  writeText(rel: string, text: string): void {
    this.writeBytes(rel, Buffer.from(text, "utf8"));
  }

  private writeBytes(rel: string, data: Uint8Array): void {
    const path = join(this.outDir, rel);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, data, { mode: 0o600 });
    this.bytes += data.byteLength;
  }

  // A unique, safe child name of the output dir `parentRel`.
  private claim(parentRel: string, name: string): string {
    let set = this.taken.get(parentRel);
    if (!set) this.taken.set(parentRel, (set = new Set()));
    const base = safeName(name);
    let pick = base;
    for (let n = 2; set.has(pick.toLowerCase()); n++) pick = `${base} (${n})`;
    set.add(pick.toLowerCase());
    return join(parentRel, pick);
  }

  /** Bytes the export will write, from the sizes of what it reads. */
  estimate(): number {
    let total = 0;
    const walk = (path: string) => {
      let st;
      try {
        st = lstatSync(path);
      } catch {
        return;
      }
      if (st.isSymbolicLink()) return;
      if (st.isDirectory()) {
        let names: string[] = [];
        try {
          names = readdirSync(path);
        } catch {
          return;
        }
        for (const name of names) walk(join(path, name));
      } else if (st.isFile()) {
        total += path.endsWith(".gz") ? st.size * GZIP_FACTOR : st.size;
      }
    };
    for (const name of [...RENDERED, ...COPIED])
      walk(join(this.stateRoot, name));
    return total;
  }

  run(): void {
    this.loadNames();
    this.exportDatabase();
    this.writeAsks();
    this.exportConversations();
    this.exportTokenLogs();
    for (const name of COPIED) this.copyTree(name, name);
    this.writeRoomsAndUsers();
    this.writeReadme();
  }

  summary(): ExportSummary {
    return {
      outDir: this.outDir,
      rooms: this.rooms.length,
      agents: this.rooms.reduce((n, r) => n + r.agents.length, 0),
      sessions: this.sessions,
      tasks: this.tasks,
      files: this.files,
      bytes: this.bytes,
      skipped: this.skipped,
    };
  }

  private loadNames(): void {
    const agentsPath = join(this.stateRoot, "agents.json");
    if (existsSync(agentsPath)) {
      try {
        const raw = readJson(agentsPath);
        if (Array.isArray(raw))
          for (const r of raw as Record<string, unknown>[]) {
            const room: Room = {
              id: str(r.id ?? ""),
              name: str(r.name ?? r.id ?? ""),
              agents: [],
            };
            for (const a of (Array.isArray(r.agents) ? r.agents : []) as Record<
              string,
              unknown
            >[]) {
              const agent = {
                id: str(a.id ?? ""),
                name: str(a.name ?? a.id ?? ""),
                roomId: room.id,
              };
              room.agents.push(agent);
              this.agentNames.set(agent.id, agent.name);
            }
            this.rooms.push(room);
          }
      } catch (error) {
        this.skip(agentsPath, error);
      }
    }
    const usersPath = join(this.stateRoot, "users.json");
    if (existsSync(usersPath)) {
      try {
        const raw = readJson(usersPath) as Record<string, { name?: string }>;
        for (const [id, user] of Object.entries(raw ?? {}))
          this.userNames.set(id, str(user?.name ?? id));
      } catch (error) {
        this.skip(usersPath, error);
      }
    }
  }

  private roomName(id: unknown): string {
    const room = this.rooms.find((r) => r.id === id);
    return room ? room.name : `Room ${str(id ?? "unknown")}`;
  }

  private agentName(id: unknown): string {
    return this.agentNames.get(str(id)) ?? str(id ?? "unknown agent");
  }

  private userName(id: unknown): string {
    return this.userNames.get(str(id)) ?? str(id ?? "");
  }

  // ---- SQLite: tasks, closed asks, audit ----

  private closedAsks: Record<string, unknown>[] = [];

  // A consistent copy of the database in a scratch dir inside the out dir,
  // removed before the export ends. A read-only VACUUM INTO reads the WAL
  // and never checkpoints it; when the read-only open fails (no -shm and a
  // dir it cannot write), the three files are copied and the copy opened.
  private exportDatabase(): void {
    const source = join(this.stateRoot, DATABASE);
    if (!existsSync(source)) return;
    const scratch = this.ensureDir(".scratch");
    try {
      const snapshot = join(scratch, "snapshot.sqlite");
      let db: Database;
      try {
        const live = new Database(source, { readonly: true });
        try {
          live.exec("PRAGMA busy_timeout=5000");
          live.query("VACUUM INTO ?").run(snapshot);
        } finally {
          live.close();
        }
        db = new Database(snapshot, { readonly: true });
      } catch {
        rmSync(snapshot, { force: true });
        const copy = join(scratch, "copy.sqlite");
        copyFileSync(source, copy);
        for (const suffix of ["-wal", "-shm"])
          if (existsSync(source + suffix))
            copyFileSync(source + suffix, copy + suffix);
        db = new Database(copy);
      }
      try {
        this.writeTasks(db);
        this.closedAsks = this.readClosedAsks(db);
        this.writeAudit(db);
      } finally {
        db.close();
      }
    } catch (error) {
      this.skip(source, error);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  private rows<T>(db: Database, sql: string): T[] {
    try {
      return db.query(sql).all() as T[];
    } catch (error) {
      // A table an older office never made.
      if (/no such table/.test((error as Error).message)) return [];
      throw error;
    }
  }

  private writeTasks(db: Database): void {
    const tasks: Record<string, unknown>[] = [];
    for (const row of this.rows<{ record: string }>(
      db,
      "SELECT record FROM tasks",
    )) {
      try {
        tasks.push(JSON.parse(row.record) as Record<string, unknown>);
      } catch {
        // A row that does not parse is not a task.
      }
    }
    this.tasks = tasks.length;
    const closed = new Set(["done", "obsolete", "closed"]);
    const byRoom = new Map<string, Record<string, unknown>[]>();
    for (const task of tasks) {
      const room = this.roomName(task.roomId);
      byRoom.set(room, [...(byRoom.get(room) ?? []), task]);
    }
    const lines = [`# Tasks`, ``, `${tasks.length} tasks.`, ``];
    for (const [room, list] of [...byRoom].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      lines.push(`## ${room}`, ``);
      const order = (t: Record<string, unknown>) =>
        closed.has(str(t.status)) ? 1 : 0;
      list.sort(
        (a, b) =>
          order(a) - order(b) || Number(b.createdAt) - Number(a.createdAt),
      );
      for (const t of list) {
        lines.push(
          `### [${str(t.status ?? "")}] ${str(t.title ?? "")} (${str(t.id ?? "")})`,
          ``,
        );
        const facts = [
          t.priority ? `Priority ${str(t.priority)}` : "",
          t.assignee ? `assignee ${str(t.assignee)}` : "",
          t.createdBy ? `created by ${str(t.createdBy)}` : "",
          isoTime(Number(t.createdAt)),
        ].filter(Boolean);
        if (facts.length) lines.push(facts.join(", "), ``);
        if (t.description) lines.push(str(t.description), ``);
      }
    }
    this.writeText("tasks.md", this.redact(lines.join("\n")));
  }

  private readClosedAsks(db: Database): Record<string, unknown>[] {
    const asks: Record<string, unknown>[] = [];
    for (const row of this.rows<{ record: string }>(
      db,
      "SELECT record FROM ask_history ORDER BY seq",
    )) {
      try {
        const record = JSON.parse(row.record) as {
          entry?: Record<string, unknown>;
          closure?: Record<string, unknown>;
        };
        if (record.entry)
          asks.push({ ...record.entry, closure: record.closure });
      } catch {
        // A row that does not parse is not an ask.
      }
    }
    return asks;
  }

  private writeAudit(db: Database): void {
    const targets = new Map<number, string[]>();
    for (const row of this.rows<{ sequence: number; target: string }>(
      db,
      "SELECT sequence, target FROM audit_targets",
    ))
      targets.set(row.sequence, [
        ...(targets.get(row.sequence) ?? []),
        row.target,
      ]);
    const lines: string[] = [];
    for (const row of this.rows<{
      sequence: number;
      time: number;
      operation: string;
      record: string;
    }>(
      db,
      "SELECT sequence, time, operation, record FROM audit ORDER BY sequence",
    )) {
      let record: unknown = row.record;
      try {
        record = JSON.parse(row.record);
      } catch {
        // Kept as text.
      }
      lines.push(
        JSON.stringify(
          this.redactValue({
            sequence: row.sequence,
            time: new Date(row.time).toISOString(),
            operation: row.operation,
            targets: targets.get(row.sequence) ?? [],
            record,
          }),
        ),
      );
    }
    if (lines.length) this.writeText("audit.jsonl", lines.join("\n") + "\n");
  }

  // ---- asks ----

  private writeAsks(): void {
    let open: Record<string, unknown>[] = [];
    const path = join(this.stateRoot, "asks.json");
    if (existsSync(path)) {
      try {
        const raw = readJson(path);
        open = (Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
      } catch (error) {
        this.skip(path, error);
      }
    }
    if (open.length === 0 && this.closedAsks.length === 0) return;
    const lines = [`# Asks`, ``];
    const render = (ask: Record<string, unknown>) => {
      lines.push(
        `### ${isoTime(Number(ask.createdAt))}: ${this.agentName(ask.agentId)} to ${this.userName(ask.memberUserId)} (${str(ask.id ?? "")})`,
        ``,
        str(ask.prompt ?? ""),
        ``,
      );
      if (Array.isArray(ask.options) && ask.options.length)
        lines.push(
          `Options: ${ask.options.map(String).join(" | ")}` +
            (ask.recommended ? ` (recommended: ${str(ask.recommended)})` : ""),
          ``,
        );
      const closure = ask.closure as Record<string, unknown> | undefined;
      if (closure)
        lines.push(
          `Closed ${isoTime(Number(closure.at))}: ${str(closure.outcome ?? "")}` +
            (closure.byUserId ? ` by ${this.userName(closure.byUserId)}` : ""),
          ``,
        );
      if (closure?.answer) lines.push(str(closure.answer), ``);
    };
    lines.push(`## Open (${open.length})`, ``);
    for (const ask of open) render(ask);
    lines.push(`## Closed (${this.closedAsks.length})`, ``);
    for (const ask of [...this.closedAsks].reverse()) render(ask);
    this.writeText("asks.md", this.redact(lines.join("\n")));
  }

  // ---- conversations ----

  private exportConversations(): void {
    const logs = join(this.stateRoot, "logs");
    if (!existsSync(logs)) return;
    const base = "conversations";
    for (const reserved of [REMOVED_DIR, CRON_DIR, API_TOKENS_DIR])
      this.claim(base, reserved);
    const roomDirs = new Map<string, string>();
    const agentDirs = new Map<string, string>();
    for (const room of this.rooms) {
      const roomDir = this.claim(base, room.name);
      roomDirs.set(room.id, roomDir);
      for (const agent of room.agents)
        agentDirs.set(agent.id, this.claim(roomDir, agent.name));
    }
    for (const name of readdirSync(logs).sort()) {
      const agentDir = join(logs, name);
      try {
        if (!lstatSync(agentDir).isDirectory()) continue;
      } catch {
        continue;
      }
      let target = agentDirs.get(name);
      let label = this.agentName(name);
      if (!target) {
        if (name.startsWith(CRON_LOG_PREFIX)) {
          const id = name.slice(CRON_LOG_PREFIX.length);
          target = this.claim(join(base, CRON_DIR), id);
          label = `Schedule run ${id}`;
        } else {
          target = this.claim(join(base, REMOVED_DIR), name);
          label = `Removed agent ${name}`;
        }
      }
      this.exportAgentLogs(agentDir, target, label, this.roomOf(name));
    }
  }

  private roomOf(agentId: string): string {
    const room = this.rooms.find((r) => r.agents.some((a) => a.id === agentId));
    return room ? room.name : "";
  }

  private exportAgentLogs(
    agentDir: string,
    targetRel: string,
    agentLabel: string,
    roomLabel: string,
  ): void {
    let topics: Record<string, { topic?: string }> = {};
    const sessionsPath = join(agentDir, "sessions.json");
    if (existsSync(sessionsPath)) {
      try {
        topics = (readJson(sessionsPath) ?? {}) as typeof topics;
      } catch {
        // Session names are a nicety: the transcripts still export.
      }
    }
    let names: string[];
    try {
      names = readdirSync(agentDir).sort();
    } catch (error) {
      this.skip(agentDir, error);
      return;
    }
    const seen = new Set<string>();
    for (const name of names) {
      const parsed = sessionIdOfTranscript(name);
      if (!parsed) continue;
      // A session kept both ways: the plain file is the live one.
      if (seen.has(parsed.sessionId)) continue;
      seen.add(parsed.sessionId);
      // The office compresses an idle session (.gz written, .jsonl removed)
      // and inflates it on resume: a file listed above can be gone. Look the
      // session up again once before giving up on it.
      let file = resolveTranscript(agentDir, parsed.sessionId);
      let read: TranscriptRead | null = null;
      try {
        read = file ? readTranscript(file.path) : null;
      } catch (error) {
        if ((error as { code?: unknown }).code !== "ENOENT") {
          this.skip(file?.path ?? join(agentDir, name), error);
          continue;
        }
        file = resolveTranscript(agentDir, parsed.sessionId);
        try {
          read = file ? readTranscript(file.path) : null;
        } catch (again) {
          this.skip(file?.path ?? join(agentDir, name), again);
          continue;
        }
      }
      // Gone for good, or a symbolic link.
      if (!read) continue;
      const entries = parseJsonl(read.text);
      const first = entries.find((e) => e.timestamp !== undefined);
      const day =
        isoDay(Number(first?.timestamp)) || isoDay(read.mtimeMs) || "undated";
      const topic = topics[parsed.sessionId]?.topic;
      const md = this.renderSession(entries, {
        title: topic || parsed.sessionId,
        agent: agentLabel,
        room: roomLabel,
        sessionId: parsed.sessionId,
      });
      this.writeText(join(targetRel, `${day}-${parsed.sessionId}.md`), md);
      this.sessions++;
    }
    const files = join(agentDir, "files");
    if (existsSync(files)) this.copyBytesTree(files, join(targetRel, "files"));
  }

  private renderSession(
    entries: Record<string, unknown>[],
    meta: { title: string; agent: string; room: string; sessionId: string },
  ): string {
    const out: string[] = [
      `# ${this.redact(meta.title)}`,
      ``,
      [
        `Agent: ${meta.agent}`,
        meta.room ? `Room: ${meta.room}` : "",
        `Session: ${meta.sessionId}`,
      ]
        .filter(Boolean)
        .join("  \n"),
      ``,
    ];
    for (const e of entries) {
      const kind = str(e.kind ?? "");
      const time = isoTime(Number(e.timestamp));
      const content = this.redact(
        typeof e.content === "string"
          ? e.content
          : JSON.stringify(e.content ?? ""),
      );
      const meta = (
        e.metadata && typeof e.metadata === "object" ? e.metadata : {}
      ) as Record<string, unknown>;
      switch (kind) {
        case "user_message": {
          const from =
            meta.username ??
            meta.sender_agent_name ??
            meta.sender_name ??
            "Member";
          out.push(`## ${this.redact(str(from))} · ${time}`, ``, content, ``);
          break;
        }
        case "text":
          out.push(
            `## ${meta.agentName ? str(meta.agentName) : "Agent"} · ${time}`,
            ``,
            content,
            ``,
          );
          break;
        case "tool_call": {
          out.push(`**Tool: ${content}** · ${time}`, ``);
          if (meta.input !== undefined)
            out.push(
              fenced(
                this.redact(JSON.stringify(meta.input, null, 2) ?? ""),
                "json",
              ),
              ``,
            );
          break;
        }
        case "tool_result": {
          const cut =
            content.length > TOOL_RESULT_MAX
              ? `${content.slice(0, TOOL_RESULT_MAX)}\n[cut: ${content.length} characters in all]`
              : content;
          out.push(fenced(cut), ``);
          break;
        }
        case "error":
          out.push(`**Error** · ${time}: ${content}`, ``);
          break;
        case "system":
          out.push(`_${content}_ · ${time}`, ``);
          break;
        default:
          out.push(
            `**${this.redact(kind || "entry")}** · ${time}`,
            ``,
            content,
            ``,
          );
      }
    }
    return out.join("\n");
  }

  private exportTokenLogs(): void {
    const dir = join(this.stateRoot, "token-logs");
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      const id = name.slice(0, -".jsonl".length);
      try {
        const entries = parseJsonl(readFileSync(path, "utf8"));
        this.writeText(
          join(this.claim(join("conversations", API_TOKENS_DIR), `${id}.md`)),
          this.renderSession(entries, {
            title: `API token ${id}`,
            agent: `API token ${id}`,
            room: "",
            sessionId: id,
          }),
        );
        this.sessions++;
      } catch (error) {
        this.skip(path, error);
      }
    }
  }

  // ---- copied trees ----

  // A file or dir of the state root, text redacted, binary copied as bytes.
  // Symbolic links and env files are never followed or copied.
  private copyTree(sourceRel: string, targetRel: string): void {
    const source = join(this.stateRoot, sourceRel);
    let st;
    try {
      st = lstatSync(source);
    } catch {
      return;
    }
    if (st.isSymbolicLink() || isEnvFile(basename(source))) return;
    if (st.isDirectory()) {
      let names: string[];
      try {
        names = readdirSync(source).sort();
      } catch (error) {
        this.skip(source, error);
        return;
      }
      this.ensureDir(targetRel);
      for (const name of names)
        this.copyTree(join(sourceRel, name), join(targetRel, name));
      return;
    }
    if (!st.isFile()) return;
    let data: Buffer;
    try {
      data = readFileSync(source);
    } catch (error) {
      this.skip(source, error);
      return;
    }
    const text = decodeUtf8(data);
    if (text === null) this.writeBytes(targetRel, data);
    else this.writeText(targetRel, this.redact(text));
    this.files++;
  }

  // Attachments: bytes as they are.
  private copyBytesTree(source: string, targetRel: string): void {
    let st;
    try {
      st = lstatSync(source);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      let names: string[];
      try {
        names = readdirSync(source).sort();
      } catch (error) {
        this.skip(source, error);
        return;
      }
      this.ensureDir(targetRel);
      for (const name of names)
        this.copyBytesTree(join(source, name), join(targetRel, safeName(name)));
      return;
    }
    if (!st.isFile()) return;
    try {
      const target = join(this.outDir, targetRel);
      copyFileSync(source, target);
      chmodSync(target, 0o600);
      this.bytes += st.size;
      this.files++;
    } catch (error) {
      this.skip(source, error);
    }
  }

  // ---- rooms, users, README ----

  private writeRoomsAndUsers(): void {
    const lines = [`# Rooms and agents`, ``];
    const raw = this.readOptionalJson("agents.json");
    const rooms = (Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
    for (const room of rooms) {
      lines.push(`## ${str(room.name ?? room.id ?? "")}`, ``);
      if (room.prompt) lines.push(`Room prompt:`, ``, str(room.prompt), ``);
      for (const agent of (Array.isArray(room.agents)
        ? room.agents
        : []) as Record<string, unknown>[]) {
        lines.push(`### ${str(agent.name ?? agent.id ?? "")}`, ``);
        const facts = [
          `id ${str(agent.id ?? "")}`,
          agent.agentType ? `engine ${str(agent.agentType)}` : "",
          agent.cwd ? `folder ${str(agent.cwd)}` : "",
        ].filter(Boolean);
        lines.push(facts.join(", "), ``);
        if (agent.customInstructions)
          lines.push(str(agent.customInstructions), ``);
      }
    }
    if (rooms.length)
      this.writeText("rooms-and-agents.md", this.redact(lines.join("\n")));

    const users = this.readOptionalJson("users.json") as Record<
      string,
      Record<string, unknown>
    > | null;
    if (users && typeof users === "object") {
      const out = [`# Members`, ``];
      for (const user of Object.values(users)) {
        if (!user || typeof user !== "object") continue;
        out.push(`## ${str(user.name ?? user.id ?? "")}`, ``);
        const allowed = Array.isArray(user.allowedRooms)
          ? user.allowedRooms.map((id) => this.roomName(id))
          : [];
        out.push(
          [
            `Role: ${str(user.role ?? "member")}`,
            allowed.length ? `rooms: ${allowed.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join(", "),
          ``,
        );
        if (user.memberPrompt) out.push(str(user.memberPrompt), ``);
      }
      this.writeText("users.md", this.redact(out.join("\n")));
    }
  }

  // agents.json and users.json were read once already; a parse error there
  // is on the skipped list.
  private readOptionalJson(name: string): unknown {
    try {
      return readJson(join(this.stateRoot, name));
    } catch {
      return null;
    }
  }

  private writeReadme(): void {
    let entries: string[] = [];
    try {
      entries = readdirSync(this.stateRoot).sort();
    } catch {
      // The README still says what it holds.
    }
    const copied = new Set(COPIED);
    const leftOut = entries.filter(
      (name) => !RENDERED.has(name) && !copied.has(name),
    );
    const lines = [
      `# Office export`,
      ``,
      `Made ${this.now.toISOString()} from the office state at ${this.stateRoot}.`,
      ``,
      `All text in it was redacted: stored secret values read ISOMUX-REDACTED, and text that looks like a key keeps only its first 8 characters. Attachments are copied as they are.`,
      ``,
      `## What is in it`,
      ``,
      `- conversations/<room>/<agent>/: one Markdown file per session, and the agent's files. Tool output is cut after ${TOOL_RESULT_MAX} characters. ${REMOVED_DIR}/ holds agents that were removed, ${CRON_DIR}/ schedule runs, ${API_TOKENS_DIR}/ API token conversations.`,
      `- tasks.md, asks.md: every task and ask.`,
      `- audit.jsonl: the audit log, one entry per line.`,
      `- rooms-and-agents.md, users.md: rooms, agents and members.`,
      `- ${COPIED.join(", ")}: copied, without env files and symbolic links.`,
      ``,
      `## Left out`,
      ``,
      `These items of the office's state folder are not in the export: credentials, keys, tokens, and anything the export does not know how to copy safely. The raw logs and database are not copied either; their content is in the files above.`,
      ``,
      ...leftOut.map(
        (name) =>
          `- ${name}${SECRET_SOURCES.has(name) ? " (read only to find the values to redact)" : ""}`,
      ),
      ``,
    ];
    if (this.skipped.length)
      lines.push(
        `## Could not be read`,
        ``,
        ...this.skipped.map((s) => `- ${s}`),
        ``,
      );
    this.writeText("README.md", lines.join("\n"));
  }
}

interface TranscriptRead {
  text: string;
  mtimeMs: number;
}

// A transcript's text, or null for a symbolic link (never followed).
function readTranscript(path: string): TranscriptRead | null {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return null;
  const raw = readFileSync(path);
  return {
    text: (path.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8"),
    mtimeMs: st.mtimeMs,
  };
}

function decodeUtf8(data: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

// JSONL entries; a line that does not parse (a torn last line while the
// office writes) is dropped.
function parseJsonl(text: string): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object")
        entries.push(value as Record<string, unknown>);
    } catch {
      // Torn or corrupt: dropped.
    }
  }
  return entries;
}
