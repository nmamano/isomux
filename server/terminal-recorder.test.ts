// The terminal recorder (task 749cb7fd): what one recording file holds, and
// what it never holds. A recording keeps the redacted output, the resizes and
// who typed when, never a keystroke or a keystroke count.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AuditActor } from "../shared/audit.ts";
import {
  TERMINAL_RECORDING_ID_PATTERN,
  type TerminalRecordingEvent,
} from "../shared/terminal-recording.ts";
import { setSecretValuesForRedaction } from "./log-redaction.ts";
import {
  INPUT_BURST_GAP_MS,
  TERMINAL_RECORDINGS_DIR,
  listTerminalRecordings,
  parseTerminalRecording,
  startTerminalRecording,
  terminalRecordingPath,
  type TerminalRecording,
} from "./terminal-recorder.ts";

const roots: string[] = [];
afterEach(() => {
  setSecretValuesForRedaction([]);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const alice: AuditActor = { kind: "member", id: "u-alice", name: "Alice" };
const bob: AuditActor = { kind: "member", id: "u-bob", name: "Bob" };

function bed(
  opts: {
    capBytes?: number;
    agentId?: string;
    root?: string;
    start?: number;
  } = {},
) {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), "isomux-recorder-"));
  if (!opts.root) roots.push(root);
  let now = opts.start ?? 1_700_000_000_000;
  const rec = startTerminalRecording({
    agentId: opts.agentId ?? "agent-1",
    cols: 80,
    rows: 24,
    startedBy: { ...alice, ownerId: "u-owner" },
    root,
    now: () => now,
    flushMs: 1_000_000,
    ...(opts.capBytes === undefined ? {} : { capBytes: opts.capBytes }),
  });
  const file = () => terminalRecordingPath(rec.id, root)!;
  const read = () => parseTerminalRecording(readFileSync(file(), "utf8"));
  return {
    root,
    rec,
    file,
    read,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const kinds = (events: TerminalRecordingEvent[]) => events.map((e) => e[1]);
const typists = (events: TerminalRecordingEvent[]) =>
  events.filter((e) => e[1] === "u").map((e) => (e[2] as { id: string }).id);
const outputText = (events: TerminalRecordingEvent[]) =>
  events
    .filter((e) => e[1] === "o")
    .map((e) => e[2])
    .join("");

describe("one terminal recording", () => {
  it("has the header and the events of the session, in order and on their times", async () => {
    const b = bed();
    b.rec.output("$ ");
    b.advance(1500);
    b.rec.resize(100, 30);
    b.advance(250);
    b.rec.input(alice);
    b.rec.output("ls\r\n");
    await b.rec.close();
    const { header, events } = b.read();
    expect(header).toEqual({
      version: 2,
      width: 80,
      height: 24,
      timestamp: 1_700_000_000,
      isomux: {
        agentId: "agent-1",
        recordingId: b.rec.id,
        // Only the three typist fields: no owner or run ids.
        startedBy: { kind: "member", id: "u-alice", name: "Alice" },
        notice: "panel",
      },
    });
    expect(b.rec.id).toMatch(TERMINAL_RECORDING_ID_PATTERN);
    // Output may be split or held back for redaction; the rest is exact.
    const rest = events.filter((e) => e[1] !== "o");
    expect(rest[0]).toEqual([1.5, "r", "100x30"]);
    expect(rest[1]).toEqual([
      1.75,
      "u",
      { kind: "member", id: "u-alice", name: "Alice" },
    ]);
    expect(rest).toHaveLength(3);
    expect(events.at(-1)).toEqual([1.75, "x", "end"]);
    expect(outputText(events)).toBe("$ ls\r\n");
  });

  it("is a 0600 file in a 0700 directory under the state root", async () => {
    const b = bed();
    await b.rec.close();
    expect(b.file()).toBe(
      join(b.root, TERMINAL_RECORDINGS_DIR, `${b.rec.id}.cast`),
    );
    expect(statSync(b.file()).mode & 0o777).toBe(0o600);
    expect(statSync(join(b.root, TERMINAL_RECORDINGS_DIR)).mode & 0o777).toBe(
      0o700,
    );
  });
});

describe("resizes", () => {
  // A resize comes from a member's socket as sent. The replay resizes an
  // owner's terminal to it, and 100000x100000 cells hang that browser tab.
  it("keeps only a size a terminal can have", async () => {
    const b = bed();
    b.rec.resize(100_000, 100_000);
    b.rec.resize(0, 24);
    b.rec.resize(1.5, 24);
    b.rec.resize(Number.NaN, 24);
    b.rec.resize(120, 40);
    await b.rec.close();
    expect(
      b
        .read()
        .events.filter((e) => e[1] === "r")
        .map((e) => e[2]),
    ).toEqual(["120x40"]);
  });
});

describe("who typed", () => {
  const keys = (
    rec: TerminalRecording,
    actor: AuditActor,
    n: number,
    advance: (ms: number) => void,
    gap: number,
  ) => {
    for (let i = 0; i < n; i++) {
      rec.input(actor);
      advance(gap);
    }
  };

  it("one member typing a command is one event", async () => {
    const b = bed();
    keys(b.rec, alice, 20, b.advance, 50);
    await b.rec.close();
    expect(typists(b.read().events)).toEqual(["u-alice"]);
  });

  it("two members taking turns give one event per turn", async () => {
    const b = bed();
    for (const actor of [alice, bob, alice])
      keys(b.rec, actor, 3, b.advance, 50);
    await b.rec.close();
    expect(typists(b.read().events)).toEqual(["u-alice", "u-bob", "u-alice"]);
  });

  it("a pause with output in between starts a new event", async () => {
    const b = bed();
    keys(b.rec, alice, 3, b.advance, 50);
    b.rec.output("done\r\n$ ");
    b.advance(INPUT_BURST_GAP_MS + 100);
    keys(b.rec, alice, 3, b.advance, 50);
    await b.rec.close();
    expect(typists(b.read().events)).toEqual(["u-alice", "u-alice"]);
  });

  it("a silent prompt is one event at any typing speed", async () => {
    // A password prompt echoes nothing: slow typing must not count the keys.
    const b = bed();
    b.rec.output("[sudo] password for alice: ");
    keys(b.rec, alice, 12, b.advance, INPUT_BURST_GAP_MS * 2);
    await b.rec.close();
    expect(typists(b.read().events)).toEqual(["u-alice"]);
  });

  it("an input event names the member and carries nothing else", async () => {
    const b = bed();
    keys(b.rec, { ...alice, ownerId: "x", runId: "y" }, 30, b.advance, 10);
    await b.rec.close();
    const { events } = b.read();
    for (const event of events.filter((e) => e[1] === "u")) {
      expect(event).toHaveLength(3);
      expect(Object.keys(event[2] as object).sort()).toEqual([
        "id",
        "kind",
        "name",
      ]);
    }
  });
});

describe("secrets in the output", () => {
  const stored = "plain words/that+look=harmless";

  it("never reach the file, raw, URL-encoded, base64, or split across chunks", async () => {
    const b = bed();
    // Stored after the recording started: it applies from now on.
    setSecretValuesForRedaction([stored]);
    const basic = Buffer.from(`user:${stored}`).toString("base64");
    const shaped = "sk-ant-api03-" + "A1b2C3d4E5f6G7h8I9j0K1l2";
    b.rec.output(
      `a ${stored} b ${encodeURIComponent(stored)} c Basic ${basic}\r\n`,
    );
    b.rec.output(`X=${stored.slice(0, 11)}`);
    b.rec.output(`${stored.slice(11)}\r\n`);
    b.rec.output(`${shaped.slice(0, 15)}`);
    b.rec.output(`${shaped.slice(15)} done\r\n`);
    await b.rec.close();
    const raw = readFileSync(b.file(), "utf8");
    for (const form of [stored, encodeURIComponent(stored), basic, shaped])
      expect(raw).not.toContain(form);
    expect(outputText(b.read().events)).toContain("ISOMUX-REDACTED");
    expect(outputText(b.read().events)).toContain(" done\r\n");
  });

  it("the tail held back for a possible match is written at close", async () => {
    const b = bed();
    b.rec.output("$ echo abcdefghij");
    await b.rec.close();
    expect(outputText(b.read().events)).toBe("$ echo abcdefghij");
  });
});

describe("a server stop", () => {
  // systemd stops the service with SIGTERM to the server and every terminal
  // sidecar at once (server/server-stop.ts): each live recording still ends.
  it("writes the held tail and the end of every live recording", async () => {
    const root = mkdtempSync(join(tmpdir(), "isomux-recorder-"));
    roots.push(root);
    const script = join(root, "stop.ts");
    writeFileSync(
      script,
      `import { startTerminalRecording } from ${JSON.stringify(join(import.meta.dir, "terminal-recorder.ts"))};
const startedBy = { kind: "member", id: "u-alice", name: "Alice" } as const;
for (const agentId of ["agent-1", "agent-2"]) {
  const rec = startTerminalRecording({ agentId, cols: 80, rows: 24, startedBy, root: ${JSON.stringify(root)} });
  rec.output("$ before stop");
}
process.kill(process.pid, "SIGTERM");
setTimeout(() => {}, 10_000);
`,
    );
    const proc = Bun.spawn([process.execPath, script], {
      env: { ...process.env, ISOMUX_HOME: root },
      stdout: "ignore",
      stderr: "pipe",
    });
    await proc.exited;
    // Died by the signal, as the server does after its stop hooks.
    expect(proc.signalCode).toBe("SIGTERM");
    const listed = listTerminalRecordings({ root });
    expect(listed.map((r) => r.agentId).sort()).toEqual(["agent-1", "agent-2"]);
    for (const { id } of listed) {
      const { events } = parseTerminalRecording(
        readFileSync(terminalRecordingPath(id, root)!, "utf8"),
      );
      expect(outputText(events)).toBe("$ before stop");
      expect(events.at(-1)?.slice(1)).toEqual(["x", "end"]);
    }
  });
});

describe("limits and failures", () => {
  it("at the cap it writes one cap event and nothing after it", async () => {
    const b = bed({ capBytes: 400 });
    for (let i = 0; i < 20; i++)
      b.rec.output(`line ${i} ${"x".repeat(40)}\r\n`);
    b.rec.resize(120, 40);
    b.rec.input(bob);
    await b.rec.close();
    const { events } = b.read();
    expect(events.at(-1)?.[1]).toBe("x");
    expect(events.at(-1)?.[2]).toBe("cap");
    expect(events.filter((e) => e[1] === "x")).toHaveLength(1);
    expect(typists(events)).toEqual([]);
    expect(statSync(b.file()).size).toBeLessThan(400 + 200);
  });

  it("at the cap it writes the held tail first, when the tail fits", async () => {
    const header = statSync(bed().file()).size;
    const line = (event: TerminalRecordingEvent) =>
      JSON.stringify(event).length + 1;
    // Room for the tail, not for the input event that reaches the cap.
    const room = line([0, "o", "abcdefghij"]) + 10;
    expect(room).toBeLessThan(line([0, "u", { ...bob }]));
    const b = bed({ capBytes: header + line([0, "o", "$ echo "]) + room });
    b.rec.output("$ echo abcdefghij");
    b.rec.input(bob);
    await b.rec.close();
    const { events } = b.read();
    expect(outputText(events)).toBe("$ echo abcdefghij");
    expect(kinds(events)).toEqual(["o", "o", "x"]);
    expect(events.at(-1)?.[2]).toBe("cap");
  });

  it("a failed write stops the recording, and the session goes on", async () => {
    const b = bed();
    b.rec.output("before\r\n");
    await b.rec.flush();
    rmSync(join(b.root, TERMINAL_RECORDINGS_DIR), {
      recursive: true,
      force: true,
    });
    // A file where the directory was: the next append cannot succeed.
    writeFileSync(join(b.root, TERMINAL_RECORDINGS_DIR), "");
    b.rec.output("after\r\n");
    b.rec.input(alice);
    await b.rec.flush();
    b.rec.output("more\r\n");
    await b.rec.close();
    await b.rec.close();
  });
});

describe("reading recordings back", () => {
  it("lists recordings newest first, by agent, with what they hold", async () => {
    const root = mkdtempSync(join(tmpdir(), "isomux-recorder-"));
    roots.push(root);
    const first = bed({ root, agentId: "agent-a", start: 1_700_000_000_000 });
    first.rec.output("one\r\n");
    first.advance(2000);
    await first.rec.close();
    const capped = bed({
      root,
      agentId: "agent-a",
      capBytes: 300,
      start: 1_700_000_100_000,
    });
    for (let i = 0; i < 20; i++) capped.rec.output(`y ${i}\r\n`.repeat(4));
    await capped.rec.close();
    const live = bed({ root, agentId: "agent-b", start: 1_700_000_050_000 });
    live.rec.output("live\r\n");
    await live.rec.flush();
    try {
      const all = listTerminalRecordings({ root });
      expect(all.map((r) => r.agentId).sort()).toEqual([
        "agent-a",
        "agent-a",
        "agent-b",
      ]);
      expect(all.map((r) => r.id)).toEqual([
        capped.rec.id,
        live.rec.id,
        first.rec.id,
      ]);
      const a = listTerminalRecordings({ root, agentId: "agent-a" });
      expect(a.map((r) => r.id)).toEqual([capped.rec.id, first.rec.id]);
      const done = a.find((r) => r.id === first.rec.id)!;
      expect(done.startedBy).toEqual({
        kind: "member",
        id: "u-alice",
        name: "Alice",
      });
      expect(done.endedAt).toBe(done.startedAt + 2000);
      expect(done.bytes).toBe(statSync(first.file()).size);
      expect(done.capped).toBeUndefined();
      expect(a.find((r) => r.id === capped.rec.id)?.capped).toBe(true);
      const running = listTerminalRecordings({ root, agentId: "agent-b" });
      expect(running).toHaveLength(1);
      expect(running[0].endedAt).toBeUndefined();
    } finally {
      await live.rec.close();
    }
  });

  it("resolves only a recording id to a path, never a path outside", () => {
    const root = "/state";
    expect(terminalRecordingPath("tr-0123456789abcdef", root)).toBe(
      join(root, TERMINAL_RECORDINGS_DIR, "tr-0123456789abcdef.cast"),
    );
    for (const id of [
      "../x",
      "tr-0123456789abcdef/../../etc",
      "tr-0123456789ABCDEF",
      "tr-0123456789abcde",
      "tr-0123456789abcdef0",
      "",
    ])
      expect(terminalRecordingPath(id, root), id).toBeNull();
  });

  it("parses a recording a crash cut off, and refuses one without a header", async () => {
    const b = bed();
    // A newline: the redactor holds back a trailing run of key characters.
    b.rec.output("hello\r\n");
    await b.rec.flush();
    const text = readFileSync(b.file(), "utf8") + '[0.5,"o","torn';
    const parsed = parseTerminalRecording(text);
    expect(parsed.header.isomux.recordingId).toBe(b.rec.id);
    expect(kinds(parsed.events)).toEqual(["o"]);
    expect(() => parseTerminalRecording('[0,"o","x"]\n')).toThrow();
    expect(() => parseTerminalRecording("")).toThrow();
    await b.rec.close();
  });
});
