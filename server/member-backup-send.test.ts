// The member's side of the backup of their agent space
// (member-backup-send.ts, slice 3c), run against a real tree. The
// properties:
// - the listing names each folder before what is in it, never names or
//   enters what the exclusions leave out, never enters a link, and marks a
//   socket or FIFO as left out;
// - a file is sent only while it is the file listed (same inode, not
//   shorter), never more bytes than listed, and a file that changed is
//   marked; a FIFO in its place does not hang the call;
// - a path the office could not have listed fails the whole call.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listSpace,
  sendSpaceFiles,
  type SpaceEntry,
  type SpaceFileHeader,
} from "./member-backup-send.ts";

let top = "";
let space = "";
let server: Server;
beforeAll(async () => {
  top = mkdtempSync(join(tmpdir(), "member-backup-send-"));
  space = join(top, "space");
  const files: Record<string, string> = {
    "provider-homes/u1/claude/projects/s.jsonl": "TRANSCRIPT",
    "provider-homes/u1/claude/.credentials.json": "SECRET",
    "apps/units/app1.token": "TOKEN",
    "apps/data/app1/x/cache/keep.txt": "KEEP",
    "codex-home/cache/c.bin": "CACHE",
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(space, rel, ".."), { recursive: true });
    writeFileSync(join(space, rel), text);
  }
  // A link to a folder outside her space, with a file in it.
  mkdirSync(join(top, "outside"));
  writeFileSync(join(top, "outside", "o.txt"), "OUTSIDE");
  symlinkSync(join(top, "outside"), join(space, "out"));
  server = createServer();
  await new Promise<void>((resolve) =>
    server.listen(join(space, "s.sock"), resolve),
  );
});
afterAll(() => {
  server.close();
  rmSync(top, { recursive: true, force: true });
});

async function listing(): Promise<SpaceEntry[]> {
  const out: Buffer[] = [];
  await listSpace({ agentRoot: space }, (chunk) => {
    out.push(Buffer.from(chunk));
  });
  const lines = Buffer.concat(out).toString().trimEnd().split("\n");
  expect(JSON.parse(lines.at(-1)!)).toEqual({ end: true });
  return lines.slice(0, -1).map((line) => JSON.parse(line) as SpaceEntry);
}

// The records of one backup-files call.
async function send(
  files: {
    p: string;
    ino: string;
    size: number;
    mtimeNs: string;
    ctimeNs: string;
  }[],
): Promise<{ header: SpaceFileHeader; bytes: string }[]> {
  const out: Buffer[] = [];
  await sendSpaceFiles(
    { agentRoot: space, files: files.map((f, i) => ({ i, ...f })) },
    (chunk) => {
      out.push(Buffer.from(chunk));
    },
  );
  const all = Buffer.concat(out);
  const records: { header: SpaceFileHeader; bytes: string }[] = [];
  let at = 0;
  for (;;) {
    const length = all.readUInt32BE(at);
    at += 4;
    if (length === 0) break;
    const header = JSON.parse(
      all.subarray(at, at + length).toString(),
    ) as SpaceFileHeader;
    at += length;
    records.push({
      header,
      bytes: all.subarray(at, at + header.size).toString(),
    });
    at += header.size;
  }
  expect(at).toBe(all.length);
  return records;
}

const asListed = (e: SpaceEntry) => ({
  p: e.p,
  ino: e.ino,
  size: e.size,
  mtimeNs: e.mtimeNs,
  ctimeNs: e.ctimeNs,
});

describe("backup-list", () => {
  it("names each folder before its content, leaves out the excluded and never enters a link", async () => {
    const entries = await listing();
    const seen = new Set([""]);
    const orphans = entries.filter((e) => {
      const parent = e.p.includes("/")
        ? e.p.slice(0, e.p.lastIndexOf("/"))
        : "";
      const ok = seen.has(parent);
      if (e.k === "d") seen.add(e.p);
      return !ok;
    });
    expect(orphans).toEqual([]);
    const names = entries.map((e) => e.p);
    expect({
      transcript: names.includes("provider-homes/u1/claude/projects/s.jsonl"),
      deepCache: names.includes("apps/data/app1/x/cache/keep.txt"),
      left: names.filter((p) =>
        /credentials|apps\/units|codex-home\/cache|out\//.test(p),
      ),
      link: entries.find((e) => e.p === "out"),
      socket: entries.find((e) => e.p === "s.sock")?.k,
    }).toEqual({
      transcript: true,
      deepCache: true,
      left: [],
      link: expect.objectContaining({ k: "l", target: join(top, "outside") }),
      socket: "x",
    });
  });
});

describe("backup-files", () => {
  it("sends the listed bytes, and marks a file that grew or whose times moved", async () => {
    const rel = "provider-homes/u1/claude/projects/s.jsonl";
    const listed = (await listing()).find((e) => e.p === rel)!;
    const [same] = await send([asListed(listed)]);
    writeFileSync(join(space, rel), "TRANSCRIPT+MORE");
    const [grew] = await send([asListed(listed)]);
    writeFileSync(join(space, rel), "TRANSCRIPT");
    utimesSync(join(space, rel), 1, 1);
    const [touched] = await send([asListed(listed)]);
    expect([same, grew, touched]).toEqual([
      { header: { i: 0, size: 10 }, bytes: "TRANSCRIPT" },
      { header: { i: 0, size: 10, changed: true }, bytes: "TRANSCRIPT" },
      { header: { i: 0, size: 10, changed: true }, bytes: "TRANSCRIPT" },
    ]);
  });

  it("sends no byte of a file that is gone, shorter, another inode or not a file", async () => {
    const rel = "apps/data/app1/x/cache/keep.txt";
    const path = join(space, rel);
    const listed = asListed((await listing()).find((e) => e.p === rel)!);
    writeFileSync(path, "KE");
    const [shrunk] = await send([listed]);
    // A second name keeps the listed inode alive, so the new file gets
    // another one.
    const kept = join(top, "kept-inode");
    linkSync(path, kept);
    unlinkSync(path);
    const [gone] = await send([listed]);
    writeFileSync(path, "KEEP");
    const [swapped] = await send([listed]);
    unlinkSync(kept);
    // A FIFO in its place: opened without blocking.
    unlinkSync(path);
    expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
    const [fifo] = await send([listed]);
    unlinkSync(path);
    // A link in its place is not followed.
    symlinkSync(join(top, "outside", "o.txt"), path);
    const [link] = await send([listed]);
    unlinkSync(path);
    writeFileSync(path, "KEEP");
    expect(
      [shrunk, gone, swapped, fifo, link].map((r) => [
        r.header.left,
        r.header.size,
        r.bytes,
      ]),
    ).toEqual([
      ["shrunk", 0, ""],
      ["gone", 0, ""],
      ["swapped", 0, ""],
      ["not-a-file", 0, ""],
      ["gone", 0, ""],
    ]);
  });

  it("fails the whole call for a path outside her space or one the exclusions leave out", async () => {
    const one = (p: string) =>
      sendSpaceFiles(
        {
          agentRoot: space,
          files: [{ i: 0, p, ino: "1", size: 1, mtimeNs: "1", ctimeNs: "1" }],
        },
        () => {},
      ).then(
        () => "sent",
        () => "refused",
      );
    expect(
      await Promise.all(
        [
          "../outside/o.txt",
          "out/o.txt/..",
          join(top, "outside", "o.txt"),
          "provider-homes/u1/claude/.credentials.json",
          "apps/units/app1.token",
        ].map(one),
      ),
    ).toEqual(["refused", "refused", "refused", "refused", "refused"]);
  });
});
