// The provisioner state move, as the operator runs it: the export from stdin
// on the old host's image, the import from the new host's image. What has to
// hold is that no create latch is lost, that nothing moves while a run holds a
// key or a DNS challenge is open, and that no key byte leaves the old volume.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CreateLatch, LatchRefused } from "./create-latch.ts";
import { IntentJournal } from "./intents.ts";
import {
  DNS_INTENTS_NAME,
  FORMAT,
  ROOT_NAME,
  VERSION,
  type StateExport,
} from "./state-move.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "./testing/pg.ts";

const SCRIPT = path.join(import.meta.dir, "state-move.ts");
const temps: string[] = [];

afterEach(async () => {
  await releaseTestStores();
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, PG_TEST_HOOK_TIMEOUT_MS);

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-state-move-"));
  temps.push(dir);
  return dir;
}

function marker(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}

function write(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, contents, { mode: 0o600 });
}

/** The acceptance fixture: intents, a revoked run with a key, an active run,
 * a pending DNS challenge, an audit file and a symlink. */
function fixture() {
  const base = tempDir();
  const data = path.join(base, "data");
  const root = path.join(data, ROOT_NAME);
  const secrets = {
    revokedKey: marker("REVOKED-PRIVATE-KEY"),
    activeKey: marker("ACTIVE-PRIVATE-KEY"),
    blob: marker("PUBLIC-BLOB"),
    acmeKey: marker("ACME-ACCOUNT-KEY"),
    linked: marker("LINK-TARGET"),
    reason: marker("FREE-TEXT-REASON"),
    detail: marker("AUDIT-DETAIL"),
  };
  const run = (runId: string, state: string) =>
    JSON.stringify({
      runId,
      state,
      host: "cp9.example.test",
      instanceId: "100200",
      ipv4: "192.0.2.10",
      loginUser: "root",
      privateKeyPath: path.join(root, "keys", runId),
      publicKeyPath: path.join(root, "keys", `${runId}.pub`),
      algorithm: "ssh-ed25519",
      blob: secrets.blob,
      knownHostsFile: path.join(root, "keys", `${runId}.known_hosts`),
      secretId: 77,
    });

  write(
    path.join(root, "intents", "intent-latched.json"),
    JSON.stringify({
      intentId: "intent-latched",
      state: "intended",
      latchedAt: 1_700_000_000_000,
      plan: "V153",
      region: "EU",
    }),
  );
  write(
    path.join(root, "intents", "intent-created.json"),
    JSON.stringify({
      intentId: "intent-created",
      state: "created",
      latchedAt: 1_700_000_100_000,
      plan: "V153",
      region: "EU",
      providerId: "100200",
      reason: secrets.reason,
    }),
  );
  write(path.join(root, "intents", "intent-corrupt.json"), "{ not json");
  write(path.join(root, "intents", "intent-created.json.41.tmp"), "{}");

  write(
    path.join(root, "runs", "run-revoked.json"),
    run("run-revoked", "revoked"),
  );
  write(path.join(root, "keys", "run-revoked"), secrets.revokedKey);
  write(
    path.join(root, "keys", "run-revoked.pub"),
    `ssh-ed25519 ${secrets.blob}`,
  );
  write(
    path.join(root, "runs", "run-active.json"),
    run("run-active", "reachable"),
  );
  write(path.join(root, "keys", "run-active"), secrets.activeKey);
  write(path.join(root, "keys", "run-active.known_hosts"), "host key");

  write(
    path.join(root, "certificates", "accounts", "key.pem"),
    secrets.acmeKey,
  );
  write(path.join(root, ".deployment"), "fly-release-24\n");

  write(path.join(data, DNS_INTENTS_NAME, `${"a".repeat(64)}.json`), "{}");

  write(
    path.join(root, "audit.jsonl"),
    [
      JSON.stringify({
        ts: "2026-08-12T10:00:00.000Z",
        actor: "control-plane-cli",
        action: "reinstall",
        target: "100200",
        outcome: "succeeded",
      }),
      JSON.stringify({
        ts: "2026-08-12T10:05:00.000Z",
        actor: "control-plane-cli",
        action: "resume",
        target: "100200",
        outcome: "succeeded",
        detail: secrets.detail,
      }),
      JSON.stringify({
        ts: "2026-08-12T10:06:00.000Z",
        actor: "control-plane-cli",
        action: "connect",
        target: "100200",
        outcome: "maybe",
      }),
      "not json",
      "",
    ].join("\n"),
  );

  // A symlink in the state root, to a file outside it. The exporter does not
  // read this path, so it does not refuse; its target must still not travel.
  const outside = path.join(base, "outside");
  write(outside, secrets.linked);
  fs.symlinkSync(outside, path.join(root, "stray-link"));

  /** Clear what refuses: the run finishes, the challenge is cleaned up. */
  const clear = () => {
    write(
      path.join(root, "runs", "run-active.json"),
      run("run-active", "revoked"),
    );
    fs.rmSync(path.join(data, DNS_INTENTS_NAME), { recursive: true });
  };
  return { base, data, root, secrets, clear, run };
}

/** The export as the cutover runs it: the script on stdin, not on disk. */
function runExport(data: string) {
  const proc = Bun.spawnSync(["bun", "run", "-", "export", "--data", data], {
    stdin: Bun.file(SCRIPT),
    cwd: os.tmpdir(),
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function runImport(data: string, input: string) {
  const proc = Bun.spawnSync(["bun", SCRIPT, "import", "--data", data], {
    stdin: Buffer.from(input),
  });
  return { code: proc.exitCode, stderr: proc.stderr.toString() };
}

/** Every file under a directory, for "nothing was written". */
function tree(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}

describe("the export refuses", () => {
  test("while a run is not revoked, naming it", () => {
    const f = fixture();
    fs.rmSync(path.join(f.data, DNS_INTENTS_NAME), { recursive: true });
    const out = runExport(f.data);
    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("run-active");
    expect(out.stderr).not.toContain("run-revoked");
  });

  test.each(["prepared", "reinstall_requested", "first_contact_done"])(
    "while a run is %s",
    (state) => {
      const f = fixture();
      f.clear();
      write(
        path.join(f.root, "runs", "run-other.json"),
        f.run("run-other", state),
      );
      const out = runExport(f.data);
      expect(out.code).toBe(1);
      expect(out.stderr).toContain("run-other");
    },
  );

  test("while a run record is unreadable", () => {
    const f = fixture();
    f.clear();
    write(path.join(f.root, "runs", "run-torn.json"), "{ half");
    const out = runExport(f.data);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("run-torn");
  });

  test.each([
    ["the data directory", (f: ReturnType<typeof fixture>) => f.data],
    ["the state root", (f: ReturnType<typeof fixture>) => f.root],
  ])("while a DNS challenge is pending in %s", (_where, dirOf) => {
    const f = fixture();
    f.clear();
    const dir = path.join(dirOf(f), DNS_INTENTS_NAME);
    write(path.join(dir, `${"b".repeat(64)}.json.9.partial`), "{}");
    const out = runExport(f.data);
    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain(dir);
  });

  test("on the full fixture, naming the run and the challenge at once", () => {
    const f = fixture();
    const out = runExport(f.data);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("run-active");
    expect(out.stderr).toContain(path.join(f.data, DNS_INTENTS_NAME));
  });

  test.each([
    ["an intent file", "intents/intent-link.json"],
    ["the intents directory", "intents"],
    ["the runs directory", "runs"],
    ["a run record", "runs/run-link.json"],
    ["the audit log", "audit.jsonl"],
    ["a DNS journal directory", DNS_INTENTS_NAME],
  ])("on a symlink at %s", (_what, rel) => {
    const f = fixture();
    f.clear();
    const at = path.join(f.root, rel);
    const target = path.join(f.base, "elsewhere");
    if (fs.existsSync(at)) fs.renameSync(at, target);
    else write(target, "{}");
    fs.symlinkSync(target, at);
    const out = runExport(f.data);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(at);
  });

  test("on an intent entry that is not a regular file", () => {
    const f = fixture();
    f.clear();
    fs.mkdirSync(path.join(f.root, "intents", "intent-dir.json"));
    expect(runExport(f.data).code).toBe(1);
  });

  test("when there is no state root, rather than exporting nothing", () => {
    const f = fixture();
    f.clear();
    fs.rmSync(f.root, { recursive: true });
    const out = runExport(f.data);
    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
  });
});

describe("the round trip", () => {
  test("exports key-free records, imports them into an empty volume, and the latch holds there", async () => {
    const f = fixture();
    f.clear();
    const out = runExport(f.data);
    expect(out.code).toBe(0);

    for (const secret of Object.values(f.secrets)) {
      expect(out.stdout).not.toContain(secret);
    }
    const doc = JSON.parse(out.stdout) as StateExport;
    expect(doc.format).toBe(FORMAT);
    expect(doc.version).toBe(VERSION);
    expect(
      Object.fromEntries(doc.intents.map((i) => [i.intentId, i.state])),
    ).toEqual({
      "intent-corrupt": "ambiguous",
      "intent-created": "created",
      "intent-latched": "intended",
    });
    expect(doc.intents.find((i) => i.intentId === "intent-created")).toEqual({
      intentId: "intent-created",
      state: "created",
      latchedAt: 1_700_000_100_000,
      plan: "V153",
      region: "EU",
      providerId: "100200",
    });
    expect(doc.audit.map((e) => e.action)).toEqual(["reinstall", "resume"]);
    expect(doc.audit.every((e) => !("detail" in e))).toBe(true);
    expect(doc.left).toEqual({ revokedRuns: 2, auditLinesDropped: 2 });
    // Nothing was written on the source.
    expect(
      fs.existsSync(path.join(f.root, "intents", "intent-corrupt.json")),
    ).toBe(true);

    const target = path.join(f.base, "vps-volume");
    fs.mkdirSync(target);
    const imported = runImport(target, out.stdout);
    expect(imported.code).toBe(0);
    const root = path.join(target, ROOT_NAME);
    expect(tree(target)).toEqual([
      ROOT_NAME,
      path.join(ROOT_NAME, "audit.jsonl"),
      path.join(ROOT_NAME, "intents"),
      path.join(ROOT_NAME, "intents", "intent-corrupt.json"),
      path.join(ROOT_NAME, "intents", "intent-created.json"),
      path.join(ROOT_NAME, "intents", "intent-latched.json"),
    ]);
    expect(
      fs.statSync(path.join(root, "intents", "intent-latched.json")).mode &
        0o777,
    ).toBe(0o600);
    const journal = new IntentJournal(path.join(root, "intents"));
    expect(journal.read("intent-created")?.providerId).toBe("100200");
    expect(
      journal
        .pending()
        .map((r) => r.intentId)
        .sort(),
    ).toEqual(["intent-corrupt", "intent-latched"]);
    expect(
      fs
        .readFileSync(path.join(root, "audit.jsonl"), "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(2);

    // A second import finds the volume in use.
    const again = runImport(target, out.stdout);
    expect(again.code).toBe(1);

    // The provisioner on the new volume: a valid operation and fence, an
    // empty create_intents, and the imported journal as the only reason the
    // create is refused.
    const store = await openTestStore();
    await store.createInstance({
      id: "inst-move",
      run_id: null,
      name: "cp9.example.test",
      plan: "V153",
      region: "EU",
      service_state: "provisioning",
      goal: "live",
      access_window_expires_at: null,
    });
    const op = await store.enqueue({
      id: "op-move",
      instance_id: "inst-move",
      kind: "create_instance",
      inactivity_deadline_at: store.now() + 900_000,
      absolute_deadline_at: store.now() + 900_000,
    });
    const now = store.now();
    const leased = (await store.tryLease(
      op.id,
      op.version,
      "holder-a",
      now + 60_000,
      now,
    ))!;
    const fence = { id: op.id, version: leased.version, holder: "holder-a" };
    const latch = new CreateLatch(store, journal);
    for (const intentId of [
      "intent-latched",
      "intent-created",
      "intent-corrupt",
    ]) {
      expect(await store.getIntent(intentId)).toBeNull();
      const refused = await latch
        .armOnce({ intentId, plan: "V153", region: "EU" }, fence)
        .then(
          () => null,
          (err: unknown) => err,
        );
      expect(refused).toBeInstanceOf(LatchRefused);
    }
    expect(await store.getIntent("intent-latched")).toBeNull();
    // The same fence still arms an intent the journal does not hold.
    const armed = await latch.armOnce(
      { intentId: "intent-fresh", plan: "V153", region: "EU" },
      fence,
    );
    expect(armed.permit.intentId).toBe("intent-fresh");
  });
});

describe("the import refuses, and writes nothing", () => {
  function exported(): { doc: StateExport; text: string } {
    const f = fixture();
    f.clear();
    const out = runExport(f.data);
    expect(out.code).toBe(0);
    return { doc: JSON.parse(out.stdout) as StateExport, text: out.stdout };
  }

  test.each<[string, (d: Record<string, unknown>) => void]>([
    ["an unknown top-level field", (d) => (d.keys = [])],
    ["another format", (d) => (d.format = "something-else")],
    ["another version", (d) => (d.version = 2)],
    [
      "an intent with a field the export never writes",
      (d) => {
        (d.intents as Record<string, unknown>[])[0].reason = "free text";
      },
    ],
    [
      "an intent id that is a path",
      (d) => {
        (d.intents as Record<string, unknown>[])[0].intentId = "../escape";
      },
    ],
    [
      "an intent named twice",
      (d) => {
        const intents = d.intents as Record<string, unknown>[];
        intents.push({ ...intents[0] });
      },
    ],
    [
      "an unknown intent state",
      (d) => {
        (d.intents as Record<string, unknown>[])[0].state = "spent";
      },
    ],
    [
      "an audit event with detail",
      (d) => {
        (d.audit as Record<string, unknown>[])[0].detail = "free text";
      },
    ],
  ])("%s", (_what, mutate) => {
    const { doc } = exported();
    const changed = structuredClone(doc) as unknown as Record<string, unknown>;
    mutate(changed);
    const target = tempDir();
    expect(runImport(target, JSON.stringify(changed)).code).toBe(1);
    expect(tree(target)).toEqual([]);
  });

  test("stdin that is not JSON", () => {
    const target = tempDir();
    expect(runImport(target, "{ half").code).toBe(1);
    expect(tree(target)).toEqual([]);
  });

  test.each([
    ".isomux-control-plane/.deployment",
    "certificate-dns-intents/x.json",
    "lost+found/x",
  ])("a volume that already holds %s", (rel) => {
    const { text } = exported();
    const target = tempDir();
    write(path.join(target, rel), "x");
    const before = tree(target);
    expect(runImport(target, text).code).toBe(1);
    expect(tree(target)).toEqual(before);
  });
});
