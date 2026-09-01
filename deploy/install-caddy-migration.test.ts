import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SRC = readFileSync(new URL("./install.sh", import.meta.url), "utf8");
const RENDER_OLD = SRC.slice(
  SRC.indexOf("render_caddyfile_without_access_log() {"),
  SRC.indexOf("\nrender_caddyfile() {"),
);
const RENDER_NEW = SRC.slice(
  SRC.indexOf("render_caddyfile() {"),
  SRC.indexOf("\nconfigure_caddy() {"),
);
const MIGRATE = SRC.slice(
  SRC.indexOf("migrate_caddy_access_log() ("),
  SRC.indexOf("\nreport() {"),
);
const TRANSACTION = SRC.slice(
  SRC.indexOf("install_caddyfile_transaction() {"),
  SRC.indexOf("\nassert_caddy_file() {"),
);
const roots: string[] = [];

function run(options: {
  kind?: "hosted" | "self-hosted";
  mutate?: (text: string) => string;
  transactionFails?: boolean;
  caddyAfterFailure?: "active" | "inactive";
  frontDoorAfterFailure?: "healthy" | "dead";
}) {
  const root = mkdtempSync(join(tmpdir(), "isomux-caddy-migration-"));
  roots.push(root);
  const bin = join(root, "bin");
  const caddyDir = join(root, "caddy");
  Bun.spawnSync(["mkdir", "-p", bin, caddyDir]);
  const state = join(root, "caddy-state");
  writeFileSync(state, "active\n");
  writeFileSync(
    join(bin, "systemctl"),
    `#!/usr/bin/env bash
[[ $* == 'is-active --quiet caddy' ]] || exit 90
[[ $(cat "$CADDY_STATE") == active ]]
`,
  );
  chmodSync(join(bin, "systemctl"), 0o755);
  const caddyfile = join(caddyDir, "Caddyfile");
  const calls = join(root, "calls");
  const kind = options.kind ?? "hosted";
  const setup = `${RENDER_OLD}
CADDY_MARKER='# Managed by the isomux installer'
render_caddyfile_without_access_log ${kind} "$CADDYFILE" office.example
`;
  let proc = Bun.spawnSync(["bash", "-c", setup], {
    env: { ...process.env, CADDYFILE: caddyfile },
  });
  expect(proc.exitCode).toBe(0);
  if (options.mutate) {
    writeFileSync(caddyfile, options.mutate(readFileSync(caddyfile, "utf8")));
  }
  const script = `${RENDER_OLD}
${RENDER_NEW}
${MIGRATE}
CADDY_MARKER='# Managed by the isomux installer'
CADDY_DIR=${JSON.stringify(caddyDir)}
CADDYFILE=${JSON.stringify(caddyfile)}
log() { printf '%s\n' "$*"; }
die() { printf 'DIE: %s\n' "$*"; return 1; }
install_caddyfile_transaction() {
  printf 'transaction %s\n' "$1" >> ${JSON.stringify(calls)}
  if [[ ${options.transactionFails ? "1" : "0"} == 1 ]]; then
    echo ${options.caddyAfterFailure ?? "active"} > ${JSON.stringify(state)}
    return 1
  fi
  cp "$1" "$CADDYFILE"
}
verify_caddy_front_door() {
  [[ $(cat ${JSON.stringify(state)}) == active ]] &&
    [[ ${options.frontDoorAfterFailure ?? "healthy"} == healthy ]]
}
migrate_caddy_access_log
`;
  proc = Bun.spawnSync(["bash", "-c", script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CADDY_STATE: state,
    },
  });
  return {
    code: proc.exitCode,
    out: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    caddyfile: readFileSync(caddyfile, "utf8"),
    calls: existsSync(calls) ? readFileSync(calls, "utf8") : "",
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("deps-only Caddy access-log migration", () => {
  it("migrates either exact known pre-log rendering", () => {
    for (const kind of ["hosted", "self-hosted"] as const) {
      const result = run({ kind });
      expect(result.code).toBe(0);
      expect(result.calls.split("\n").filter(Boolean)).toHaveLength(1);
      expect(result.caddyfile).toContain("roll_keep_for 312h");
      expect(result.caddyfile).toContain("request>uri regexp");
    }
  });

  it("leaves a one-byte-different managed file and restart calls untouched", () => {
    const result = run({
      mutate: (text) =>
        text.replace(
          "reverse_proxy 127.0.0.1:4000",
          "reverse_proxy 127.0.0.1:4001",
        ),
    });
    expect(result.code).toBe(0);
    expect(result.calls).toBe("");
    expect(result.caddyfile).toContain("reverse_proxy 127.0.0.1:4001");
    expect(result.caddyfile).not.toContain("roll_keep_for");
    expect(result.out).toContain(
      "differs from both known installer renderings",
    );
  });

  it("warns and continues when the prior Caddy config was restored", () => {
    const result = run({ transactionFails: true });
    expect(result.code).toBe(0);
    expect(result.out).toContain("previous configuration was restored");
  });

  it("fails when migration leaves Caddy down", () => {
    const result = run({
      transactionFails: true,
      caddyAfterFailure: "inactive",
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("Caddy is down");
  });

  it("fails when Caddy still reports active but the restored front door is dead", () => {
    const result = run({
      transactionFails: true,
      caddyAfterFailure: "active",
      frontDoorAfterFailure: "dead",
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("Caddy is down");
  });
});

function runTransaction(options: {
  existingLogs?: boolean;
  officeLogSymlink?: boolean;
  invalidExtraction?: boolean;
  logDirectoryAbsent?: boolean;
  frontDoor?: "healthy" | "active-then-dead" | "dead" | "new-dead-old-healthy";
}) {
  const root = mkdtempSync(join(tmpdir(), "isomux-caddy-transaction-"));
  roots.push(root);
  const bin = join(root, "bin");
  const caddyDir = join(root, "etc-caddy");
  const logDir = join(root, "var-log-caddy");
  const tlsDir = join(root, "etc-isomux-tls");
  const calls = join(root, "calls");
  const activeChecks = join(root, "active-checks");
  mkdirSync(bin);
  mkdirSync(caddyDir);
  if (!options.logDirectoryAbsent) mkdirSync(logDir);
  mkdirSync(tlsDir);
  writeFileSync(activeChecks, "0\n");
  const officeLog = join(logDir, "isomux-office-access.log");
  const appLog = join(logDir, "isomux-app-access.log");
  const operatorFile = join(root, "operator-file");
  if (options.officeLogSymlink) {
    writeFileSync(operatorFile, "operator\n");
    symlinkSync(operatorFile, officeLog);
  } else if (options.existingLogs) {
    writeFileSync(officeLog, "old office log\n");
  }
  if (options.existingLogs) writeFileSync(appLog, "old app log\n");
  const executable = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  executable(
    "caddy",
    `echo "caddy $*" >> "$CALLS"
[[ $1 == validate ]] || exit 91`,
  );
  executable(
    "systemctl",
    `echo "systemctl $*" >> "$CALLS"
case $1 in
  show)
    if [[ $* == *property=User* ]]; then echo proxy-user; fi
    if [[ $* == *property=Group* ]]; then echo proxy-group; fi
    ;;
  restart) exit 0 ;;
  is-active)
    count=$(cat "$ACTIVE_CHECKS")
    count=$((count + 1))
    echo "$count" > "$ACTIVE_CHECKS"
    case "$FRONT_DOOR" in
      healthy) exit 0 ;;
      active-then-dead) ((count == 1)) ;;
      dead) exit 3 ;;
      new-dead-old-healthy) exit 0 ;;
    esac
    ;;
  *) exit 92 ;;
esac`,
  );
  executable(
    "id",
    "if [[ $1 == -u && $2 == proxy-user ]]; then echo 123; elif [[ $1 == -gn && $2 == proxy-user ]]; then echo fallback-group; fi",
  );
  executable("getent", "[[ $1 == group && $2 == proxy-group ]]");
  executable(
    "install",
    'echo "install $*" >> "$CALLS"; if [[ $1 == -d ]]; then mkdir -p "${@: -1}"; else : > "${@: -1}"; fi',
  );
  executable("chown", 'echo "chown $*" >> "$CALLS"');
  executable("chmod", 'echo "chmod $*" >> "$CALLS"');
  executable(
    "curl",
    `echo "curl $*" >> "$CALLS"
[[ "$FRONT_DOOR" == dead ]] && exit 7
if [[ "$FRONT_DOOR" == active-then-dead ]]; then echo 000; exit 0; fi
if [[ "$FRONT_DOOR" == new-dead-old-healthy ]]; then
  if grep -q '^# old config$' "$FINAL_CONFIG"; then echo 308; else echo 000; fi
  exit 0
fi
echo 308`,
  );
  executable("sleep", ":");

  const final = join(caddyDir, "Caddyfile");
  const rendered = join(caddyDir, "rendered");
  writeFileSync(final, "# old config\noffice.example {\n\trespond 404\n}\n");
  writeFileSync(
    rendered,
    `office.example {
\tlog {
\t\toutput ${options.invalidExtraction ? "files" : "file"} ${officeLog} {
\t\t}
\t}
\treverse_proxy 127.0.0.1:4000
}
*.office.example {
\tlog {
\t\toutput file ${appLog} {
\t\t}
\t}
}
`,
  );
  const localized = TRANSACTION.replaceAll("/etc/caddy", caddyDir)
    .replaceAll("/var/log/caddy", logDir)
    .replaceAll("/etc/isomux/tls", tlsDir);
  const script = `set -Eeuo pipefail
${localized}
CADDY_VERIFY_ATTEMPTS=2
CADDY_VERIFY_INTERVAL_SECONDS=0
run() { "$@"; }
log() { printf '%s\\n' "$*"; }
die() { printf 'DIE: %s\\n' "$*"; return 1; }
install_caddyfile_transaction ${JSON.stringify(rendered)}
`;
  const proc = Bun.spawnSync(["bash", "-c", script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CALLS: calls,
      ACTIVE_CHECKS: activeChecks,
      FRONT_DOOR: options.frontDoor ?? "healthy",
      OFFICE_LOG: officeLog,
      APP_LOG: appLog,
      FINAL_CONFIG: final,
    },
  });
  return {
    code: proc.exitCode,
    out: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    calls: existsSync(calls) ? readFileSync(calls, "utf8") : "",
    config: readFileSync(final, "utf8"),
    officeLog: existsSync(officeLog) ? readFileSync(officeLog, "utf8") : "",
    appLog: existsSync(appLog) ? readFileSync(appLog, "utf8") : "",
    operatorFile: existsSync(operatorFile)
      ? readFileSync(operatorFile, "utf8")
      : "",
  };
}

describe("Caddyfile transaction", () => {
  it("normalizes both newly-created access logs for the unit account", () => {
    const result = runTransaction({ logDirectoryAbsent: true });
    expect(result.code).toBe(0);
    expect(result.calls).toMatch(
      /^install -o proxy-user -g proxy-group -m 0600 \/dev\/null .*\/isomux-office-access\.log$/m,
    );
    expect(result.calls).toMatch(
      /^install -o proxy-user -g proxy-group -m 0600 \/dev\/null .*\/isomux-app-access\.log$/m,
    );
  });

  it("fails before validation when log-path extraction does not yield both paths", () => {
    const result = runTransaction({ invalidExtraction: true });
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("two expected access-log paths");
    expect(result.calls).not.toContain("caddy validate");
  });

  it("unconditionally repairs both existing access logs without truncating them", () => {
    const result = runTransaction({ existingLogs: true });
    expect(result.code).toBe(0);
    expect(result.officeLog).toBe("old office log\n");
    expect(result.appLog).toBe("old app log\n");
    expect(
      result.calls.match(/^chown -h .*isomux-.*-access\.log$/gm),
    ).toHaveLength(2);
  });

  it("refuses to follow an operator-created access-log symlink", () => {
    const result = runTransaction({ officeLogSymlink: true });
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("refusing to change ownership");
    expect(result.calls).not.toContain("chown");
    expect(result.operatorFile).toBe("operator\n");
  });

  it("keeps the backup and rolls back when active Caddy then loses its front door", () => {
    const result = runTransaction({ frontDoor: "active-then-dead" });
    expect(result.code).not.toBe(0);
    expect(result.calls).toContain(
      "curl --silent --show-error --output /dev/null --write-out %{http_code} --max-time 1 --resolve office.example:80:127.0.0.1 http://office.example/__isomux/front-door-check",
    );
    expect(result.calls.match(/^systemctl restart caddy$/gm)).toHaveLength(2);
    expect(result.config).toContain("# old config\n");
    expect(result.out).toContain("did not restore a serving front door");
  });

  it("reports restoration only after the previous config serves again", () => {
    const result = runTransaction({ frontDoor: "new-dead-old-healthy" });
    expect(result.code).not.toBe(0);
    expect(result.config).toContain("# old config\n");
    expect(result.out).toContain("the previous file was restored");
    expect(result.out).not.toContain("did not restore a serving front door");
  });

  it("commits a healthy fresh self-hosted front door without needing a certificate or upstream", () => {
    const result = runTransaction({ frontDoor: "healthy" });
    expect(result.code).toBe(0);
    expect(result.config).toContain("reverse_proxy 127.0.0.1:4000");
    expect(result.calls.match(/^curl /gm)).toHaveLength(1);
    expect(result.calls).toContain("http://office.example/");
    expect(result.calls).not.toContain("https://");
  });
});
