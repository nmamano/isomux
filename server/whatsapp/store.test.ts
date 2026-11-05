// A member's saved chat times (task 876d6e50): the Add picker's order kept
// across restarts. A real temp STATE_ROOT.

import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  ensureMemberDir,
  memberDir,
  readChatTimes,
  removeSession,
  whatsappRoot,
  writeChatTimes,
} from "./store.ts";

const U = "u-alice";
const FILE = "chat-times.json";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function root(): string {
  const r = mkdtempSync(join(tmpdir(), "t-876d6e50-store-"));
  roots.push(r);
  return r;
}

describe("whatsapp store: chat times", () => {
  it("round trip: the times come back as written, in a 0600 file, with no temp file left", () => {
    const r = root();
    const dir = ensureMemberDir(r, U);
    const times = new Map([
      ["447700900123@s.whatsapp.net", 1_800_000_000_500],
      ["120363000000000001@g.us", 1_800_000_000_100],
    ]);
    writeChatTimes(r, U, times);
    expect([...readChatTimes(r, U)].sort()).toEqual([...times].sort());
    expect(statSync(join(dir, FILE)).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual([FILE]);

    // A second write replaces the first.
    writeChatTimes(r, U, new Map([["x@g.us", 7]]));
    expect([...readChatTimes(r, U)]).toEqual([["x@g.us", 7]]);
  });

  it("writes nothing and creates no directory when the member's directory is gone", () => {
    const r = root();
    writeChatTimes(r, U, new Map([["a@g.us", 1]]));
    expect(existsSync(memberDir(r, U))).toBe(false);
    expect(existsSync(whatsappRoot(r))).toBe(false);
    expect(readChatTimes(r, U).size).toBe(0);
  });

  it("a missing or bad file reads as no times; a value that is not a finite number is dropped", () => {
    const r = root();
    expect(readChatTimes(r, U).size).toBe(0);
    const dir = ensureMemberDir(r, U);
    expect(readChatTimes(r, U).size).toBe(0);
    for (const bad of ["{", "", "null", "5", '"a"', "[1,2]", '[["a",1]]']) {
      writeFileSync(join(dir, FILE), bad);
      expect([bad, readChatTimes(r, U).size]).toEqual([bad, 0]);
    }
    // 1e400 parses as Infinity.
    writeFileSync(
      join(dir, FILE),
      '{"ok":5,"str":"6","nul":null,"inf":1e400,"bool":true,"obj":{},"neg":-1}',
    );
    expect([...readChatTimes(r, U)].sort()).toEqual([
      ["neg", -1],
      ["ok", 5],
    ]);
    // A directory where the file goes reads as no times.
    rmSync(join(dir, FILE));
    mkdirSync(join(dir, FILE));
    expect(readChatTimes(r, U).size).toBe(0);
  });

  it("a new link's session clear deletes the times and keeps the contact rows", () => {
    const r = root();
    const dir = ensureMemberDir(r, U);
    writeFileSync(join(dir, "routes.json"), "{}");
    writeChatTimes(r, U, new Map([["a@g.us", 1]]));
    expect(existsSync(join(dir, FILE))).toBe(true);
    removeSession(r, U);
    expect(readdirSync(dir)).toEqual(["routes.json"]);
  });
});
