// Key identity is EXACT, in both languages.
//
// The rewrite, the revocation and the box-local backstop all decide "is this
// our line?" A substring match on the base64 blob says yes to a longer key that
// contains ours, and to any line whose COMMENT contains ours - and a comment is
// attacker-controllable text. Saying yes wrongly means rewriting or deleting
// somebody else's key, and certifying the wrong line as proof.
//
// The shell helpers and the TypeScript reader are checked against the same
// adversarial fixtures, because a disagreement between them is its own bug.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { blobOf, composeRemoteScript } from "./driver.ts";
import type { RuntimeRepoFile } from "./runtime-files.ts";

const OURS = "AAAAC3NzaC1lZDI1NTE5AAAAIourkeyblob";

/** Lines that a substring match would wrongly claim, plus one that is ours. */
const FIXTURE = [
  `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIcustomerkey customer@laptop`,
  // The blob appears inside a LONGER key. Not ours.
  `ssh-ed25519 ${OURS}EXTRA someone-elses-longer-key`,
  // The blob appears in the COMMENT, which anyone can choose.
  `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIanotherkey ${OURS}`,
  // Ours, carrying options with spaces inside quotes.
  `expiry-time="20260809140000Z",no-agent-forwarding ssh-ed25519 ${OURS} isomux-cp`,
  // The blob as a SUFFIX of a longer key. Not ours.
  `ssh-ed25519 PREFIX${OURS} yet-another`,
].join("\n");

let dir = "";
let keyDir = "";
let akFile = "";

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "isomux-cp-ak-"));
  // authorized_keys lives in its own subdirectory so a test can make THAT
  // unwritable without also blocking the composed script next to it.
  keyDir = path.join(dir, "keys");
  fs.mkdirSync(keyDir, { mode: 0o700 });
  akFile = path.join(keyDir, "authorized_keys");
  fs.writeFileSync(akFile, `${FIXTURE}\n`, { mode: 0o600 });
});
afterEach(async () => {
  try {
    fs.chmodSync(keyDir, 0o700);
  } catch {
    // Already gone.
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function runComposed(
  scripts: RuntimeRepoFile[],
  args: string[],
): { code: number; stdout: string; stderr: string } {
  const script = path.join(dir, "composed.sh");
  fs.writeFileSync(script, composeRemoteScript(scripts), { mode: 0o755 });
  const proc = Bun.spawnSync(["bash", script, ...args]);
  return {
    code: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

describe("the TypeScript reader", () => {
  test("finds the blob past options that contain spaces", async () => {
    expect(
      blobOf(`expiry-time="20260809140000Z" ssh-ed25519 ${OURS} isomux-cp`),
    ).toBe(OURS);
  });
  test("does not confuse a longer key that contains ours", async () => {
    expect(blobOf(`ssh-ed25519 ${OURS}EXTRA c`)).not.toBe(OURS);
  });
  test("does not read a blob out of a comment", async () => {
    expect(blobOf(`ssh-ed25519 AAAAother ${OURS}`)).toBe("AAAAother");
  });
  test("returns null for a line with no key", async () => {
    expect(blobOf("# just a comment")).toBeNull();
  });
});

describe("revoke-key.sh removes exactly one line", () => {
  test("keeps the customer key and proves it is still present", () => {
    const customer = "AAAAC3NzaC1lZDI1NTE5AAAAIcustomerkey";
    const res = runComposed(
      ["authorizedKeys", "revokeKey"],
      [akFile, OURS, customer],
    );
    expect(res.stdout).toContain("RESULT: removed");
    expect(fs.readFileSync(akFile, "utf8")).toContain(customer);
  });

  test("reports a missing customer key without blocking revocation", () => {
    const res = runComposed(
      ["authorizedKeys", "revokeKey"],
      [akFile, OURS, "AAAAnotpresent"],
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("RESULT: removed");
    expect(res.stdout).toContain("CUSTOMER-KEY: missing");
  });
  test("takes ours and leaves every impostor byte-for-byte", async () => {
    const before = fs.readFileSync(akFile, "utf8").split("\n").filter(Boolean);
    const res = runComposed(["authorizedKeys", "revokeKey"], [akFile, OURS]);
    expect(res.stdout).toContain("RESULT: removed");
    const after = fs.readFileSync(akFile, "utf8").split("\n").filter(Boolean);
    expect(after).toHaveLength(before.length - 1);
    // Every surviving line is one of the originals, unchanged.
    for (const line of after) expect(before).toContain(line);
    // The one that went is ours, and only ours.
    expect(after.filter((l) => blobOf(l) === OURS)).toHaveLength(0);
    expect(after.some((l) => l.includes(`${OURS}EXTRA`))).toBe(true);
    expect(after.some((l) => l.endsWith(OURS))).toBe(true);
  });

  test("is idempotent: a second run changes nothing and still succeeds", async () => {
    runComposed(["authorizedKeys", "revokeKey"], [akFile, OURS]);
    const mid = fs.readFileSync(akFile, "utf8");
    const res = runComposed(["authorizedKeys", "revokeKey"], [akFile, OURS]);
    expect(res.stdout).toContain("RESULT: removed");
    expect(fs.readFileSync(akFile, "utf8")).toBe(mid);
  });
});

describe("install-customer-key.sh", () => {
  test("a retry leaves exactly one normalized customer line", () => {
    const customer = "AAAAC3NzaC1lZDI1NTE5AAAAInewcustomer";
    const scripts: RuntimeRepoFile[] = ["authorizedKeys", "installCustomerKey"];
    expect(
      runComposed(scripts, [akFile, "ssh-ed25519", customer, OURS]).code,
    ).toBe(0);
    expect(
      runComposed(scripts, [akFile, "ssh-ed25519", customer, OURS]).code,
    ).toBe(0);
    const lines = fs.readFileSync(akFile, "utf8").split("\n");
    expect(lines.filter((line) => blobOf(line) === customer)).toEqual([
      `ssh-ed25519 ${customer} hosted-isomux-customer`,
    ]);
  });

  test("does not rewrite one pre-existing customer line", () => {
    const customer = "AAAAC3NzaC1lZDI1NTE5AAAAIcustomerkey";
    const before = fs.readFileSync(akFile, "utf8");
    const res = runComposed(
      ["authorizedKeys", "installCustomerKey"],
      [akFile, "ssh-ed25519", customer, OURS],
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("CUSTOMER-KEY: existing");
    expect(fs.readFileSync(akFile, "utf8")).toBe(before);
  });

  test("adds a separating newline when authorized_keys has none", () => {
    const customer = "AAAAC3NzaC1lZDI1NTE5AAAAInewcustomer";
    fs.writeFileSync(akFile, `ssh-ed25519 ${OURS} no-newline`);
    const res = runComposed(
      ["authorizedKeys", "installCustomerKey"],
      [akFile, "ssh-ed25519", customer, "AAAAprovisioning"],
    );
    expect(res.code).toBe(0);
    expect(fs.readFileSync(akFile, "utf8")).toContain(
      `no-newline\nssh-ed25519 ${customer}`,
    );
  });

  test("refuses a customer key that is our provisioning key", () => {
    const res = runComposed(
      ["authorizedKeys", "installCustomerKey"],
      [akFile, "ssh-ed25519", OURS, OURS],
    );
    expect(res.code).not.toBe(0);
  });
});

describe("rewrite-key.sh rewrites exactly one line", () => {
  test("puts the expiry on ours and leaves the impostors alone", async () => {
    const res = runComposed(
      ["authorizedKeys", "rewriteKey"],
      [akFile, "ssh-ed25519", OURS, "20260810060000Z"],
    );
    expect(res.stdout).toContain("RESULT: ok");
    const lines = fs.readFileSync(akFile, "utf8").split("\n").filter(Boolean);
    const ours = lines.filter((l) => blobOf(l) === OURS);
    expect(ours).toHaveLength(1);
    expect(ours[0]).toContain('expiry-time="20260810060000Z"');
    // Nothing else acquired an expiry.
    expect(lines.filter((l) => l.includes("expiry-time"))).toHaveLength(1);
  });

  test("refuses when our key is not on the box", async () => {
    const res = runComposed(
      ["authorizedKeys", "rewriteKey"],
      [akFile, "ssh-ed25519", "AAAAnotpresent", "20260810060000Z"],
    );
    expect(res.code).not.toBe(0);
    expect(res.stdout).toContain("key-not-present");
  });

  test("the read-back reports our line and only ours", async () => {
    const res = runComposed(
      ["authorizedKeys", "rewriteKey"],
      [akFile, "ssh-ed25519", OURS, "20260810060000Z"],
    );
    const readback = res.stdout
      .split("\n")
      .filter((l) => l.startsWith("READBACK: "));
    expect(readback).toHaveLength(1);
    expect(blobOf(readback[0].slice("READBACK: ".length))).toBe(OURS);
  });
});

describe("the cleanup backstop refuses to claim success it did not achieve", () => {
  const CLEANUP: RuntimeRepoFile[] = ["authorizedKeys", "cleanup"];

  test("fails, and stays installed, when the file cannot be replaced", async () => {
    // A read-only directory: mktemp and the rename inside it cannot work, so
    // the removal cannot happen. The script must fail rather than write a
    // success record - the unit deletes this script and the timer on success,
    // so a false success would remove enforcement AND evidence.
    fs.chmodSync(keyDir, 0o500);
    const res = runComposed(CLEANUP, [akFile, OURS]);
    fs.chmodSync(keyDir, 0o700);
    expect(res.code).not.toBe(0);
    expect(fs.existsSync("/var/lib/isomux-access-record.json")).toBe(false);
    // Our key is still there, which is exactly why it had to fail.
    const lines = fs.readFileSync(akFile, "utf8").split("\n").filter(Boolean);
    expect(lines.filter((l) => blobOf(l) === OURS)).toHaveLength(1);
  });

  test("removes our key and keeps the customer key byte-identical", () => {
    const customer = "AAAAC3NzaC1lZDI1NTE5AAAAIcustomerkey";
    const before = fs
      .readFileSync(akFile, "utf8")
      .split("\n")
      .find((line) => line.includes(customer));
    const record = path.join(dir, "access-record.json");
    const runRoot = path.join(dir, "run-root");
    const wrapper = path.join(dir, "wrapper");
    fs.mkdirSync(runRoot);
    fs.writeFileSync(wrapper, "wrapper");
    const original = composeRemoteScript(CLEANUP);
    const body = original
      .replace("RECORD=/var/lib/isomux-access-record.json", `RECORD=${record}`)
      .replace("RUN_ROOT=/var/lib/isomux-cp", `RUN_ROOT=${runRoot}`)
      .replace("WRAPPER=/usr/local/sbin/isomux-cp-run", `WRAPPER=${wrapper}`);
    expect(body).not.toBe(original);
    const script = path.join(dir, "cleanup-customer.sh");
    fs.writeFileSync(script, body, { mode: 0o755 });
    const proc = Bun.spawnSync(["bash", script, akFile, OURS, customer]);
    expect(proc.exitCode).toBe(0);
    const after = fs
      .readFileSync(akFile, "utf8")
      .split("\n")
      .find((line) => line.includes(customer));
    expect(after).toBe(before);
    expect(fs.existsSync(record)).toBe(true);
    expect(fs.readFileSync(record, "utf8")).toContain(
      '"customerKey": "present"',
    );
  });
});
