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
  resumeAction,
  resumeRun,
  runFile,
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

  test("everything needed to reconnect is on disk, not just in memory", async () => {
    saveRun(dir, REC);
    const raw = JSON.parse(
      fs.readFileSync(runFile(dir, "cycleX"), "utf8"),
    ) as RunRecord;
    // If any of these were missing, a restart could not reach the box it just
    // asked a provider to rebuild.
    for (const field of [
      "ipv4",
      "loginUser",
      "privateKeyPath",
      "blob",
      "algorithm",
      "knownHostsFile",
      "instanceId",
    ] as const) {
      expect(raw[field]).toBeTruthy();
    }
  });

  test("leaves no temp file behind, so a reader never sees a half-written record", async () => {
    saveRun(dir, REC);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual(["cycleX.json"]);
  });

  test("a missing record reads as absent; a broken one is not silently absent", async () => {
    expect(loadRun(dir, "never-existed")).toBeNull();
    fs.writeFileSync(runFile(dir, "broken"), "{ not json");
    expect(() => loadRun(dir, "broken")).toThrow();
  });
});

// M8. The record must already exist at the instant the provider is asked to
// rebuild, because after that instant we may never get another chance to write.
describe("M8: death between the provider call and the record write", () => {
  test("a restart after the reinstall was issued can still reach the box", async () => {
    // What the CLI does, in order: persist, THEN reinstall.
    saveRun(dir, REC);
    const reinstallIssued = () => {
      throw new Error("process died after Contabo accepted the reinstall");
    };
    expect(reinstallIssued).toThrow();

    // Process loss: nothing in memory survives.
    const recovered = loadRun(dir, "cycleX");
    expect(recovered).not.toBeNull();
    expect(recovered!.privateKeyPath).toBe(REC.privateKeyPath);
    expect(recovered!.blob).toBe(REC.blob);
    expect(recovered!.ipv4).toBe(REC.ipv4);
  });

  test("the resumed run waits for SSH; it does NOT reinstall or mint a second key", async () => {
    saveRun(dir, REC);
    expect(resumeAction(loadRun(dir, "cycleX")!)).toBe("wait_for_ssh");
  });

  test("each later state resumes at its own point, and none of them rebuild", async () => {
    const actions = (
      ["reachable", "first_contact_done", "revoked"] as const
    ).map((state) => resumeAction({ ...REC, state }));
    expect(actions).toEqual(["first_contact", "provision", "done"]);
    // There is no arm that rebuilds. A box we cannot reach is a human's problem.
    for (const state of [
      "reinstall_requested",
      "reachable",
      "first_contact_done",
      "revoked",
    ] as const) {
      expect(resumeAction({ ...REC, state })).not.toBe("reinstall");
    }
  });
});

// The state model has to be something the PROGRAM uses, not a shape that only
// tests know about. These drive the real resume dispatcher through an injected
// seam, so they can assert which steps each state reaches - and that no state
// can reach a rebuild.
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
    for (const [state, expected] of [
      ["reachable", "first_contact"],
      ["first_contact_done", "provision"],
      ["revoked", "done"],
    ] as const) {
      const rec = { ...REC, state };
      saveRun(dir, rec);
      const s = seam();
      expect(await resumeRun(dir, rec, s.steps)).toBe(expected);
    }
  });

  // The seam has no rebuild step at all, which is the point: there is no state
  // from which the program can ask a provider to wipe the box again.
  test("no state reaches a rebuild", async () => {
    for (const state of [
      "reinstall_requested",
      "reachable",
      "first_contact_done",
      "revoked",
    ] as const) {
      const rec = { ...REC, state };
      saveRun(dir, rec);
      const s = seam();
      await resumeRun(dir, rec, s.steps);
      expect(s.took.join(",")).not.toContain("reinstall");
      expect(Object.keys(s.steps)).not.toContain("reinstall");
    }
  });
});
