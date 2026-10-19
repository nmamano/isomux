// The Hosted support reader (control-plane/deploy/vps/support/): the lookup
// query and the read role against a real local Postgres, and the two programs
// of the SSH login against a stub of docker and logger first on PATH. Nothing
// here touches Docker, sshd or sudo.
//
// No psql exists on this box or in CI, so the psql layer the read program
// drives (the -v email variable, :'email', prepare and execute) is proved by
// the install proofs in support/README.md, not here. The tests below pin what
// reaches that layer: the email only as the value of one -v argument, never in
// the script on stdin, and the lookup text itself.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { Store } from "../store.ts";
import {
  LOCAL_DATABASE_URL,
  PG_TEST_HOOK_TIMEOUT_MS,
  TARGET_IS_LOCAL,
} from "../testing/pg.ts";
import { withRoleSuiteLock } from "../testing/role-suite-lock.ts";

const SUPPORT = path.join(import.meta.dir, "vps", "support");
const READ = path.join(SUPPORT, "hosted-support-read");
const SSH = path.join(SUPPORT, "hosted-support-ssh");
const LOOKUP_SQL = fs.readFileSync(path.join(SUPPORT, "lookup.sql"), "utf8");
const ROLE_SQL = fs.readFileSync(path.join(SUPPORT, "role.sql"), "utf8");
const ROLE = "hostedsupport_read";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vps-support-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// The read program and the forced command, against stubs.

// Records each call as call<N>.argv (NUL-separated) and, for exec, its stdin
// as call<N>.stdin; answers from files the test writes next to it. The exec
// branch always writes LEAK to stderr: psql error text can quote its input,
// and the read program must never forward it.
const LEAK = "LEAKED-PSQL-STDERR";
const STUB_DOCKER = `#!/usr/bin/env bash
d=\${0%/*}
n=$(( $(cat "$d/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" >"$d/count"
printf '%s\\0' "$@" >"$d/call$n.argv"
case $1 in
  ps)
    cat "$d/ps.out" 2>/dev/null
    exit "$(cat "$d/ps.code" 2>/dev/null || echo 0)" ;;
  exec)
    cat >"$d/call$n.stdin"
    echo "psql: ERROR: ${LEAK}" >&2
    cat "$d/exec.out" 2>/dev/null
    exit "$(cat "$d/exec.code" 2>/dev/null || echo 0)" ;;
esac
exit 99
`;

// One record per call: its arguments, then a separator. The read program
// passes the message as an argument, so the stub never reads stdin.
const STUB_LOGGER = `#!/usr/bin/env bash
d=\${0%/*}
{ printf '%s ' "$@"; printf '\\n--\\n'; } >>"$d/logger.log"
`;

const CONTAINER = "c0ffee".repeat(10) + "abcd";
const CANNED = '{"generated_at":1,"accounts":[]}';
const GOOD = "Alice.Smith+tag_1%x@Mail-1.Example.co.uk";

interface Call {
  argv: string[];
  stdin: string | null;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: Call[];
  syslog: string[];
}

let stubCounter = 0;
function stubDir(answers: Record<string, string> = {}): string {
  const dir = path.join(scratch, `stub${++stubCounter}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "docker"), STUB_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "logger"), STUB_LOGGER, { mode: 0o755 });
  const defaults = {
    "ps.out": `${CONTAINER}\n`,
    "exec.out": `${CANNED}\n`,
  };
  for (const [name, body] of Object.entries({ ...defaults, ...answers })) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

function collect(dir: string, r: ReturnType<typeof spawnSync>): Run {
  const count = Number(
    fs.existsSync(path.join(dir, "count"))
      ? fs.readFileSync(path.join(dir, "count"), "utf8")
      : 0,
  );
  const calls: Call[] = [];
  for (let n = 1; n <= count; n++) {
    const argv = fs
      .readFileSync(path.join(dir, `call${n}.argv`), "utf8")
      .split("\0")
      .slice(0, -1);
    const stdinFile = path.join(dir, `call${n}.stdin`);
    calls.push({
      argv,
      stdin: fs.existsSync(stdinFile)
        ? fs.readFileSync(stdinFile, "utf8")
        : null,
    });
  }
  const logFile = path.join(dir, "logger.log");
  const syslog = fs.existsSync(logFile)
    ? fs
        .readFileSync(logFile, "utf8")
        .split("\n--\n")
        .filter((entry) => entry.trim() !== "")
    : [];
  return {
    status: r.status,
    stdout: String(r.stdout),
    stderr: String(r.stderr),
    calls,
    syslog,
  };
}

/** The read program as sudo runs it: a reset environment, PATH only. */
function runRead(
  input: string,
  answers: Record<string, string> = {},
  args: string[] = [],
): Run {
  const dir = stubDir(answers);
  const r = spawnSync(READ, args, {
    input,
    env: { PATH: `${dir}:/usr/bin:/bin` },
    encoding: "utf8",
    timeout: 20_000,
  });
  return collect(dir, r);
}

function execCalls(run: Run): Call[] {
  return run.calls.filter((call) => call.argv[0] === "exec");
}

/** One FAIL line on stderr, nothing on stdout, exit 1, and one syslog FAIL
 * record. A stage name is fixed text, so no record carries an address. */
function expectFailure(run: Run): void {
  expect(run.status).toBe(1);
  expect(run.stdout).toBe("");
  expect(run.stderr).toMatch(/^FAIL [^\n]+\n$/);
  expect(run.stderr).not.toContain(LEAK);
  expect(run.syslog).toHaveLength(1);
  expect(run.syslog[0]).toContain("FAIL");
  expect(run.syslog[0]).not.toContain("@");
}

describe("hosted-support-read", () => {
  test("a valid address reaches psql only as the value of the email variable", () => {
    const run = runRead(`${GOOD}\n`);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`${CANNED}\n`);

    expect(run.calls.map((call) => call.argv[0])).toEqual(["ps", "exec"]);
    const ps = run.calls[0].argv;
    expect(ps).toContain("label=com.docker.compose.project=isomux-hosted");
    expect(ps).toContain("label=com.docker.compose.service=db");
    expect(ps).toContain("label=com.docker.compose.oneoff=False");
    // Running containers only: `docker ps` lists only those unless told -a.
    expect(ps).not.toContain("-a");
    expect(ps).not.toContain("--all");

    const exec = run.calls[1];
    const argv = exec.argv;
    const after = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(argv).toContain("-i");
    expect(after("-u")).toBe("postgres");
    expect(argv).toContain(CONTAINER);
    expect(argv).toContain("psql");
    expect(after("-U")).toBe(ROLE);
    expect(after("-d")).toBe("isomux");
    expect(argv).toContain("--no-password");
    expect(argv).toContain("ON_ERROR_STOP=1");

    const lower = GOOD.toLowerCase();
    const carriers = argv
      .map((arg, i) => ({ arg, i }))
      .filter(({ arg }) => arg.toLowerCase().includes(lower));
    expect(carriers.map(({ arg }) => arg)).toEqual([`email=${GOOD}`]);
    expect(argv[carriers[0].i - 1]).toBe("-v");

    // The script on stdin carries the variable reference and the lookup text,
    // never the address itself.
    const stdin = exec.stdin ?? "";
    expect(stdin.toLowerCase()).not.toContain(lower);
    expect(stdin).toContain(":'email'");
    expect(stdin).toContain(LOOKUP_SQL.trim().replace(/;\s*$/, ""));
    expect(stdin).toMatch(/read only/i);
    expect(stdin).toMatch(/statement_timeout/i);

    expect(run.syslog).toHaveLength(1);
    expect(run.syslog[0]).toContain("ok");
    expect(run.syslog[0].toLowerCase()).not.toContain(lower);
  });

  test("the longest accepted address, 64-character local part and 254 in all, is read", () => {
    const local = "a".repeat(64);
    const domain = `${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.com`;
    const address = `${local}@${domain}`;
    expect(address).toHaveLength(254);
    const run = runRead(`${address}\n`);
    expect(run.status).toBe(0);
    expect(execCalls(run)).toHaveLength(1);
    expect(execCalls(run)[0].argv).toContain(`email=${address}`);
  });

  // Each one is refused before any docker call.
  const refused: [string, string][] = [
    ["no input", ""],
    ["an empty line", "\n"],
    ["no line end", GOOD],
    ["two lines", `${GOOD}\n${GOOD}\n`],
    ["a trailing second line", `${GOOD}\nextra`],
    ["a carriage return", `${GOOD}\r\n`],
    ["an apostrophe", "o'brien@example.com\n"],
    ["a double quote", 'a"b@example.com\n'],
    ["a space", "a b@example.com\n"],
    ["a backslash", "a\\b@example.com\n"],
    ["a colon", "a:b@example.com\n"],
    ["a semicolon", "x;drop@example.com\n"],
    ["a non-ASCII letter", "é@example.com\n"],
    ["an empty local part", "@example.com\n"],
    ["no top-level domain", "alice@example\n"],
    ["a numeric top-level domain", "alice@example.123\n"],
    ["two at signs", "a@b@example.com\n"],
    ["a 65-character local part", `${"a".repeat(65)}@example.com\n`],
    [
      "255 characters",
      `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(58)}.com\n`,
    ],
  ];
  for (const [name, input] of refused) {
    test(`refuses ${name} before docker`, () => {
      const run = runRead(input);
      expect(run.calls).toEqual([]);
      expectFailure(run);
    });
  }

  test("refuses a command-line argument before docker", () => {
    const run = runRead(`${GOOD}\n`, {}, ["other@example.com"]);
    expect(run.calls).toEqual([]);
    expectFailure(run);
  });

  const containers: [string, Record<string, string>][] = [
    ["no running db container", { "ps.out": "" }],
    [
      "two running db containers",
      { "ps.out": `${CONTAINER}\n${"f".repeat(64)}\n` },
    ],
    ["a failed docker ps", { "ps.code": "1" }],
  ];
  for (const [name, answers] of containers) {
    test(`fails on ${name} without an exec`, () => {
      const run = runRead(`${GOOD}\n`, answers);
      expect(run.calls.map((call) => call.argv[0])).toEqual(["ps"]);
      expectFailure(run);
    });
  }

  const psql: [string, Record<string, string>][] = [
    ["a failed psql, whatever it printed", { "exec.code": "3" }],
    ["two output lines", { "exec.out": `${CANNED}\n${CANNED}\n` }],
    ["no output", { "exec.out": "" }],
  ];
  for (const [name, answers] of psql) {
    test(`fails on ${name}, printing nothing on stdout`, () => {
      const run = runRead(`${GOOD}\n`, answers);
      expect(execCalls(run)).toHaveLength(1);
      expectFailure(run);
    });
  }
});

describe("hosted-support-ssh", () => {
  test("refuses a login with no command", () => {
    for (const env of [{}, { SSH_ORIGINAL_COMMAND: "" }]) {
      const r = spawnSync(SSH, [], {
        env: { PATH: "/usr/bin:/bin", ...env },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(r.status).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/^FAIL [^\n]+\n$/);
    }
  });

  // The sudoers rule allows the read program with NO arguments, so the command
  // must travel on stdin. The one sudo invocation is swapped for a recorder;
  // the rest of the script runs as written.
  const SUDO = "/usr/bin/sudo -n /usr/local/sbin/hosted-support-read";
  test("passes the command to the read program on stdin, with no arguments", () => {
    const source = fs.readFileSync(SSH, "utf8");
    expect(source.split(SUDO)).toHaveLength(2);
    const dir = fs.mkdtempSync(path.join(scratch, "ssh-"));
    const recorder = path.join(dir, "recorder");
    fs.writeFileSync(
      recorder,
      `#!/usr/bin/env bash\necho "$#" >"${dir}/argc"\ncat >"${dir}/stdin"\n`,
      { mode: 0o755 },
    );
    const copy = path.join(dir, "hosted-support-ssh");
    fs.writeFileSync(copy, source.replace(SUDO, recorder), { mode: 0o755 });
    for (const command of [GOOD, `${GOOD}\nother@example.com`]) {
      const r = spawnSync(copy, [], {
        env: { PATH: "/usr/bin:/bin", SSH_ORIGINAL_COMMAND: command },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(r.status).toBe(0);
      expect(fs.readFileSync(path.join(dir, "argc"), "utf8")).toBe("0\n");
      // A newline inside the command arrives as a second line, which the read
      // program refuses (above).
      expect(fs.readFileSync(path.join(dir, "stdin"), "utf8")).toBe(
        `${command}\n`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The lookup and the role, on a scratch database with the Store schema in
// public, as on the VPS.

const suite = TARGET_IS_LOCAL ? describe : describe.skip;

const admin = new pg.Pool({ connectionString: LOCAL_DATABASE_URL, max: 2 });
admin.on("error", () => {});
const DB = `cp_sup_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
let dsn = "";
let db: pg.Pool | null = null;
let roleTouched = false;

const MARKERS = {
  google_subject: "MARK-google-subject",
  customer_ssh_key: "MARK-customer-ssh-key",
  customer_ssh_key_fingerprint: "MARK-ssh-fingerprint",
  evidence: "MARK-operation-evidence",
  audit_detail: "MARK-audit-detail",
  stripe_detail: "MARK-stripe-detail",
  ipv4: "MARK-ipv4",
  host_key_fingerprint: "MARK-host-key",
  token_hash: "MARK-token-hash",
  checkout_session_id: "MARK-checkout-session",
};

const SEED = `
insert into accounts (id, email, google_subject, stripe_customer_id, version, created_at, updated_at) values
  ('acct_a', 'Alice@Example.com', '${MARKERS.google_subject}', 'cus_a', 1, 1000, 1001),
  ('acct_b', 'bob@example.org', 'sub-b', 'cus_b', 1, 2000, 2001),
  ('acct_c1', 'Case@Dup.io', null, null, 1, 3000, 3001),
  ('acct_c2', 'case@dup.io', null, null, 1, 3100, 3101);
insert into name_reservations (name, id, account_id, instance_id, plan, checkout_session_id, checkout_state, version, created_at, updated_at) values
  ('alpha', 'res_1', 'acct_a', 'inst_1', 'solo', '${MARKERS.checkout_session_id}', 'reconciled', 1, 1100, 1101),
  ('beta', 'res_2', 'acct_a', 'inst_2', 'solo', null, 'pending', 1, 1200, 1201),
  ('gamma', 'res_3', 'acct_b', 'inst_3', 'solo', null, 'reconciled', 1, 2100, 2101);
insert into instances (id, name, plan, region, service_state, goal, attention_state, attention_reason, customer_ssh_key, customer_ssh_key_fingerprint, version, created_at, updated_at) values
  ('inst_1', 'alpha-host', 'solo', 'eu', 'live', 'handed_off', 'clear', null, '${MARKERS.customer_ssh_key}', '${MARKERS.customer_ssh_key_fingerprint}', 1, 1110, 1111),
  ('inst_2', 'beta-host', 'solo', 'eu', 'provisioning', 'first_contact', 'needs_operator', 'install stalled', null, null, 1, 1210, 1211),
  ('inst_3', 'gamma-host', 'solo', 'eu', 'live', 'handed_off', 'clear', null, null, null, 1, 2110, 2111);
insert into subscriptions (id, account_id, instance_id, stripe_customer_id, status, latest_invoice_id, version, created_at, updated_at) values
  ('sub_1', 'acct_a', 'inst_1', 'cus_a', 'active', 'in_1', 1, 1120, 1121),
  ('sub_orphan', 'acct_a', null, 'cus_a', 'incomplete_expired', null, 1, 1130, 1131),
  ('sub_foreign', 'acct_a', 'inst_3', 'cus_a', 'canceled', null, 1, 1140, 1141),
  ('sub_3', 'acct_b', 'inst_3', 'cus_b', 'active', 'in_3', 1, 2120, 2121);
insert into operations (id, instance_id, kind, status, attempt, next_attempt_at, inactivity_deadline_at, absolute_deadline_at, evidence, evidence_at, version, created_at, updated_at) values
  ('op_1a', 'inst_1', 'create_server', 'succeeded', 1, 0, 5000, 9000, '${MARKERS.evidence}', 1150, 1, 1150, 1151),
  ('op_1b', 'inst_1', 'verify_https', 'succeeded', 2, 0, 5000, 9000, '${MARKERS.evidence}', 1160, 1, 1160, 1161),
  ('op_3', 'inst_3', 'verify_https', 'succeeded', 1, 0, 5000, 9000, 'other', 2150, 1, 2150, 2151);
insert into attention_reasons (id, instance_id, reason_class, reason, severity, raised_at) values
  ('ar_1', 'inst_1', 'operation_condition', 'reason-of-alpha', 'warning', 1170),
  ('ar_3', 'inst_3', 'operation_condition', 'reason-of-gamma', 'warning', 2170);
insert into provider_assets (id, instance_id, provider, provider_id, asset_state, ipv4, host_key_fingerprint, next_reconcile_at, version, created_at, updated_at) values
  ('pa_1', 'inst_1', 'contabo', 'prov-1', 'active', '${MARKERS.ipv4}', '${MARKERS.host_key_fingerprint}', 0, 1, 1180, 1181),
  ('pa_3', 'inst_3', 'contabo', 'prov-3', 'active', null, null, 0, 1, 2180, 2181);
insert into audit_events (seq, ts, actor, instance_id, action, target, outcome, detail) values
  (1, 1190, 'provisioner', 'inst_1', 'action-of-alpha', 'inst_1', 'succeeded', '${MARKERS.audit_detail}'),
  (2, 2190, 'provisioner', 'inst_3', 'action-of-gamma', 'inst_3', 'succeeded', null),
  (3, 3190, 'operator', null, 'action-of-nobody', 'box', 'succeeded', null);
insert into stripe_events (id, type, created, received_at, subscription_id, outcome, detail) values
  ('evt_1', 'invoice.paid', 1195, 1196, 'sub_1', 'applied', '${MARKERS.stripe_detail}'),
  ('evt_orphan', 'customer.subscription.deleted', 1197, 1198, 'sub_orphan', 'applied', null),
  ('evt_foreign', 'customer.subscription.deleted', 1199, 1200, 'sub_foreign', 'applied', null),
  ('evt_3', 'invoice.paid', 2195, 2196, 'sub_3', 'applied', null);
insert into certificate_credentials (id, instance_id, token_hash, status, created_at, version) values
  ('cc_1', 'inst_1', '${MARKERS.token_hash}', 'active', 1199, 1);
`;

// The lookup returns one jsonb value, read as a tree.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function lookup(pool: pg.Pool | pg.Client, email: string): Promise<Json> {
  const result = await pool.query(LOOKUP_SQL, [email]);
  expect(result.rows).toHaveLength(1);
  return Object.values(result.rows[0])[0];
}

const keys = (row: Json) => Object.keys(row).sort();
const ids = (rows: Json[]) => rows.map((row) => row.id).sort();
const byName = (rows: Json[]) =>
  [...rows].sort((a, b) => String(a.name).localeCompare(String(b.name)));

const ACCOUNT_KEYS = [
  "created_at",
  "email",
  "id",
  "offices",
  "other_subscriptions",
  "stripe_customer_id",
];
const OFFICE_KEYS = [
  "attention_reasons",
  "audit_events",
  "checkout_state",
  "created_at",
  "id",
  "instance",
  "name",
  "operations",
  "provider_assets",
  "stripe_events",
  "subscriptions",
];
const INSTANCE_KEYS = [
  "attention_reason",
  "attention_state",
  "created_at",
  "goal",
  "id",
  "name",
  "plan",
  "service_state",
  "updated_at",
];
const SUBSCRIPTION_KEYS = [
  "cancel_at_period_end",
  "canceled_at",
  "cancellation_policy",
  "cancellation_reason",
  "created_at",
  "current_period_end",
  "ended_at",
  "episode_state",
  "id",
  "latest_invoice_id",
  "payment_failures",
  "status",
  "stripe_customer_id",
  "updated_at",
];
const OPERATION_KEYS = [
  "absolute_deadline_at",
  "attempt",
  "created_at",
  "evidence_at",
  "id",
  "inactivity_deadline_at",
  "kind",
  "status",
  "updated_at",
];
const ATTENTION_KEYS = [
  "cleared_at",
  "raised_at",
  "reason",
  "reason_class",
  "severity",
];
const ASSET_KEYS = [
  "asset_state",
  "created_at",
  "provider",
  "service_ends_at",
  "updated_at",
];
const AUDIT_KEYS = ["action", "actor", "outcome", "target", "ts"];
const STRIPE_EVENT_KEYS = ["created", "id", "outcome", "received_at", "type"];

suite("lookup.sql and role.sql on the Store schema", () => {
  beforeAll(async () => {
    await admin.query(`create database ${DB}`);
    const url = new URL(LOCAL_DATABASE_URL);
    url.pathname = `/${DB}`;
    dsn = url.toString();
    await (await Store.open(dsn)).close();
    db = new pg.Pool({ connectionString: dsn, max: 2 });
    db.on("error", () => {});
    await db.query(SEED);
  }, PG_TEST_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await db?.end().catch(() => {});
    await withRoleSuiteLock(async () => {
      await admin
        .query(
          "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1",
          [DB],
        )
        .catch(() => {});
      await admin.query(`drop database if exists ${DB}`).catch(() => {});
      if (roleTouched) {
        await admin.query(`drop role if exists ${ROLE}`).catch(() => {});
      }
    });
    if (roleTouched) {
      const left = await admin.query<{ n: string }>(
        "select count(*)::text as n from pg_roles where rolname = $1",
        [ROLE],
      );
      expect(left.rows[0]?.n).toBe("0");
    }
    await admin.end().catch(() => {});
  }, 2 * PG_TEST_HOOK_TIMEOUT_MS);

  test("an address finds its account case-insensitively, with each office's records and nothing of another account", async () => {
    const before = Date.now();
    const out = await lookup(db!, "alice@EXAMPLE.com");
    expect(keys(out)).toEqual(["accounts", "generated_at"]);
    expect(typeof out.generated_at).toBe("number");
    expect(out.generated_at).toBeGreaterThanOrEqual(before - 60_000);
    expect(out.generated_at).toBeLessThanOrEqual(Date.now() + 60_000);

    expect(out.accounts).toHaveLength(1);
    const account = out.accounts[0];
    expect(keys(account)).toEqual(ACCOUNT_KEYS);
    expect(account).toMatchObject({
      id: "acct_a",
      email: "Alice@Example.com",
      stripe_customer_id: "cus_a",
      created_at: 1000,
    });

    const [alpha, beta] = byName(account.offices);
    expect(account.offices).toHaveLength(2);
    for (const office of [alpha, beta]) {
      expect(keys(office)).toEqual(OFFICE_KEYS);
      expect(keys(office.instance)).toEqual(INSTANCE_KEYS);
    }
    expect(alpha).toMatchObject({
      name: "alpha",
      id: "res_1",
      created_at: 1100,
      checkout_state: "reconciled",
    });
    expect(alpha.instance).toMatchObject({
      id: "inst_1",
      name: "alpha-host",
      service_state: "live",
      goal: "handed_off",
    });
    expect(ids(alpha.subscriptions)).toEqual(["sub_1"]);
    expect(keys(alpha.subscriptions[0])).toEqual(SUBSCRIPTION_KEYS);
    expect(alpha.subscriptions[0].latest_invoice_id).toBe("in_1");
    expect(ids(alpha.operations)).toEqual(["op_1a", "op_1b"]);
    for (const op of alpha.operations) expect(keys(op)).toEqual(OPERATION_KEYS);
    expect(alpha.attention_reasons.map((r: Json) => r.reason)).toEqual([
      "reason-of-alpha",
    ]);
    expect(keys(alpha.attention_reasons[0])).toEqual(ATTENTION_KEYS);
    expect(alpha.provider_assets).toHaveLength(1);
    expect(keys(alpha.provider_assets[0])).toEqual(ASSET_KEYS);
    expect(alpha.audit_events.map((e: Json) => e.action)).toEqual([
      "action-of-alpha",
    ]);
    expect(keys(alpha.audit_events[0])).toEqual(AUDIT_KEYS);
    expect(ids(alpha.stripe_events)).toEqual(["evt_1"]);
    expect(keys(alpha.stripe_events[0])).toEqual(STRIPE_EVENT_KEYS);

    // An office with no records has empty lists, not nulls.
    expect(beta).toMatchObject({ name: "beta", id: "res_2", created_at: 1200 });
    expect(beta.instance).toMatchObject({
      id: "inst_2",
      attention_state: "needs_operator",
      attention_reason: "install stalled",
    });
    for (const list of [
      "subscriptions",
      "operations",
      "attention_reasons",
      "provider_assets",
      "audit_events",
      "stripe_events",
    ]) {
      expect(beta[list]).toEqual([]);
    }

    // The account's subscriptions on no instance, or on an instance outside
    // its reservations.
    expect(ids(account.other_subscriptions)).toEqual([
      "sub_foreign",
      "sub_orphan",
    ]);
    for (const sub of account.other_subscriptions) {
      expect(keys(sub)).toEqual(SUBSCRIPTION_KEYS);
    }

    const text = JSON.stringify(out);
    for (const marker of Object.values(MARKERS)) {
      expect(text).not.toContain(marker);
    }
    for (const foreign of [
      "acct_b",
      "bob@",
      "gamma",
      "op_3",
      "ar_3",
      "reason-of-gamma",
      "action-of-gamma",
      "action-of-nobody",
      "evt_3",
      "evt_orphan",
      '"sub_3"',
    ]) {
      expect(text).not.toContain(foreign);
    }
  });

  // The other direction: account A holds a subscription on B's instance
  // (sub_foreign, with evt_foreign). B's office shows only B's own
  // subscription and its events.
  test("an office shows only its own account's subscriptions, even on a shared instance", async () => {
    const out = await lookup(db!, "bob@example.org");
    expect(ids(out.accounts)).toEqual(["acct_b"]);
    const [gamma] = out.accounts[0].offices;
    expect(out.accounts[0].offices).toHaveLength(1);
    expect(gamma.instance.id).toBe("inst_3");
    expect(ids(gamma.subscriptions)).toEqual(["sub_3"]);
    expect(ids(gamma.stripe_events)).toEqual(["evt_3"]);
    const text = JSON.stringify(out);
    for (const foreign of [
      "acct_a",
      "sub_foreign",
      "evt_foreign",
      "Alice",
      "alpha",
      "evt_1",
    ]) {
      expect(text).not.toContain(foreign);
    }
  });

  test("an unknown address gives an empty account list", async () => {
    const out = await lookup(db!, "nobody@example.com");
    expect(keys(out)).toEqual(["accounts", "generated_at"]);
    expect(out.accounts).toEqual([]);
  });

  test("two accounts that differ only in case are both returned", async () => {
    const out = await lookup(db!, "CASE@DUP.IO");
    expect(ids(out.accounts)).toEqual(["acct_c1", "acct_c2"]);
    for (const account of out.accounts) {
      expect(keys(account)).toEqual(ACCOUNT_KEYS);
      expect(account.offices).toEqual([]);
      expect(account.other_subscriptions).toEqual([]);
    }
  });

  test(
    "the role logs in read-only, runs the lookup, and can read no excluded column and write nothing",
    async () => {
      await withRoleSuiteLock(async () => {
        roleTouched = true;
        // Idempotent: the README runs it again after every restore.
        await db!.query(ROLE_SQL);
        await db!.query(ROLE_SQL);

        const facts = await admin.query(
          "select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, " +
            "rolreplication, rolbypassrls, coalesce(rolconfig, '{}') as config, " +
            "(select count(*)::int from pg_auth_members m where m.member = r.oid) as memberships " +
            "from pg_roles r where rolname = $1",
          [ROLE],
        );
        expect(facts.rows).toHaveLength(1);
        const role = facts.rows[0];
        expect(role).toMatchObject({
          rolcanlogin: true,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolinherit: false,
          rolreplication: false,
          rolbypassrls: false,
          memberships: 0,
        });
        expect(role.config).toContain("default_transaction_read_only=on");
        expect(
          role.config.some((entry: string) =>
            entry.startsWith("statement_timeout="),
          ),
        ).toBe(true);

        // Column grants only, and SELECT only.
        const tableGrants = await db!.query(
          "select table_name, privilege_type from information_schema.table_privileges where grantee = $1",
          [ROLE],
        );
        expect(tableGrants.rows).toEqual([]);
        const otherVerbs = await db!.query(
          "select table_name, column_name, privilege_type from information_schema.column_privileges " +
            "where grantee = $1 and privilege_type <> 'SELECT'",
          [ROLE],
        );
        expect(otherVerbs.rows).toEqual([]);

        // The VPS role has no password and logs in over the db container's
        // local socket; this cluster takes scram only, so the case gives it
        // one. A password changes no privilege.
        const password = Math.random().toString(36).slice(2);
        await admin.query(`alter role ${ROLE} password '${password}'`);
        const url = new URL(dsn);
        url.username = ROLE;
        url.password = password;
        const client = new pg.Client({ connectionString: url.toString() });
        client.on("error", () => {});
        await client.connect();
        try {
          const ro = await client.query("show default_transaction_read_only");
          expect(ro.rows[0].default_transaction_read_only).toBe("on");

          const asRole = await lookup(client, "alice@example.com");
          const asOwner = await lookup(db!, "alice@example.com");
          expect({ ...asRole, generated_at: 0 }).toEqual({
            ...asOwner,
            generated_at: 0,
          });

          const code = (sql: string) =>
            client.query(sql).then(
              () => "allowed",
              (err: { code?: string }) => err.code ?? "no code",
            );
          for (const column of [
            "operations.evidence",
            "instances.customer_ssh_key",
            "instances.customer_ssh_key_fingerprint",
            "audit_events.detail",
            "stripe_events.detail",
            "accounts.google_subject",
            "provider_assets.ipv4",
            "provider_assets.host_key_fingerprint",
            "certificate_credentials.token_hash",
            "name_reservations.checkout_session_id",
            "reinstatement_attempts.checkout_session_id",
          ]) {
            const [table, col] = column.split(".");
            expect(
              `${column}: ${await code(`select ${col} from ${table}`)}`,
            ).toBe(`${column}: 42501`);
          }

          // The grant is the wall: a session can turn read-only off.
          await client.query("begin read write");
          for (const sql of [
            "insert into stripe_events (id, type, created, received_at, outcome) values ('evt_x', 't', 1, 1, 'o')",
            "update accounts set email = email",
            "delete from audit_events",
            "create table public.support_probe (a int)",
          ]) {
            await client.query("savepoint probe");
            expect(`${sql}: ${await code(sql)}`).toBe(`${sql}: 42501`);
            await client.query("rollback to savepoint probe");
          }
          await client.query("rollback");
        } finally {
          await client.end().catch(() => {});
        }
      });
    },
    2 * PG_TEST_HOOK_TIMEOUT_MS,
  );
});
