// The recycle crash window.
//
// Between "Contabo accepted the reinstall" and "we wrote down which key we put
// on it" there is a gap. Die in that gap and the box comes back holding a key
// whose private half we can still find on disk but whose runId, paths and blob
// we no longer associate with any box - so nothing ever connects to it, and
// nothing ever puts a ceiling on the key it carries.
//
// The record therefore goes down BEFORE the provider call, and a restart reads
// its state rather than starting over.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadAnyRun,
  loadRun,
  resumeRun,
  saveRun,
  type RunRecord,
} from "./run-record.ts";

let dir = "";

const REC: RunRecord = {
  runId: "cycleX",
  state: "reinstall_requested",
  host: "cp1.test.isomux.app",
  instanceId: "203474835",
  ipv4: "169.58.97.2",
  loginUser: "root",
  privateKeyPath: "/keys/cycleX",
  publicKeyPath: "/keys/cycleX.pub",
  algorithm: "ssh-ed25519",
  blob: "AAAAblob",
  knownHostsFile: "/keys/cycleX.known_hosts",
  secretId: 444452,
};

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "isomux-cp-runs-"));
});
afterEach(async () => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("durability", () => {
  test("prepared records carry null provider facts and stay off operator paths", () => {
    saveRun(dir, {
      ...REC,
      state: "prepared",
      instanceId: null,
      ipv4: null,
    });
    expect(loadAnyRun(dir, REC.runId)).toMatchObject({
      state: "prepared",
      instanceId: null,
      ipv4: null,
    });
    expect(() => loadRun(dir, REC.runId)).toThrow(/no provider address/);
  });

  test("a missing record reads as absent; a broken one is not silently absent", async () => {
    expect(loadRun(dir, "never-existed")).toBeNull();
    fs.writeFileSync(path.join(dir, "broken.json"), "{ not json");
    expect(() => loadRun(dir, "broken")).toThrow();
  });
});

// M8. The record must already exist at the instant the provider is asked to
// rebuild, because after that instant we may never get another chance to write.
describe("M8: death between the provider call and the record write", () => {
  test("a restart after the reinstall was issued reads back the whole record", async () => {
    // What the CLI does, in order: persist, THEN reinstall. Process loss
    // leaves only the disk.
    saveRun(dir, REC);
    expect(loadRun(dir, "cycleX")).toEqual(REC);
    // Written atomically: no temp file is left for a reader to find.
    expect(fs.readdirSync(dir)).toEqual(["cycleX.json"]);
  });
});

// The state model has to be something the PROGRAM uses, not a shape that only
// tests know about. These drive the real resume dispatcher through an injected
// seam, so they can assert which steps each state reaches. The seam has no
// rebuild step, so no state can reach one.
describe("resumeRun", () => {
  function seam() {
    const took: string[] = [];
    return {
      took,
      steps: {
        waitForSsh: (r: RunRecord) => {
          took.push(`wait:${r.runId}`);
          return Promise.resolve();
        },
        firstContact: () => {
          took.push("first_contact");
          return Promise.resolve();
        },
        provision: () => {
          took.push("provision");
          return Promise.resolve();
        },
        report: () => undefined,
      },
    };
  }

  test("an interrupted rebuild WAITS, and advances to reachable on disk", async () => {
    saveRun(dir, REC);
    const s = seam();
    const action = await resumeRun(dir, loadRun(dir, "cycleX")!, s.steps);
    expect(action).toBe("wait_for_ssh");
    expect(s.took).toEqual(["wait:cycleX"]);
    // Persisted, so a second interruption does not repeat the same step.
    expect(loadRun(dir, "cycleX")!.state).toBe("reachable");
  });

  test("each later state resumes at its own point", async () => {
    for (const [state, expected, took] of [
      ["reachable", "first_contact", ["first_contact"]],
      ["first_contact_done", "provision", ["provision"]],
      ["revoked", "done", []],
    ] as const) {
      const rec = { ...REC, state };
      saveRun(dir, rec);
      const s = seam();
      expect(await resumeRun(dir, rec, s.steps)).toBe(expected);
      expect(s.took).toEqual([...took]);
    }
  });
});
