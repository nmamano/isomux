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
  SRC.indexOf("migrate_managed_caddyfile() ("),
  SRC.indexOf("\nreport() {"),
);
const TRANSACTION = SRC.slice(
  SRC.indexOf("install_caddyfile_transaction() {"),
  SRC.indexOf("\nassert_caddy_file() {"),
);
const ASSERT_FILE_AT = SRC.indexOf("\nassert_caddy_file() {");
const ASSERT_FILE = SRC.slice(
  ASSERT_FILE_AT,
  SRC.indexOf("\n}\n", ASSERT_FILE_AT) + 3,
);
const roots: string[] = [];

function run(options: {
  kind?: "hosted" | "self-hosted";
  // pre-log: render_caddyfile_without_access_log (generation 1, both kinds).
  // forward-auth: render_caddyfile_hosted_forward_auth (generation 2, hosted
  // only). post-log: the current render_caddyfile.
  rendering?: "pre-log" | "forward-auth" | "post-log";
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
  const render =
    options.rendering === "post-log"
      ? `render_caddyfile ${kind}`
      : options.rendering === "forward-auth"
        ? "render_caddyfile_hosted_forward_auth"
        : `render_caddyfile_without_access_log ${kind}`;
  const setup = `${RENDER_OLD}
${RENDER_NEW}
CADDY_MARKER='# Managed by the isomux installer'
${render} "$CADDYFILE" office.example
`;
  let proc = Bun.spawnSync(["bash", "-c", setup], {
    env: { ...process.env, CADDYFILE: caddyfile },
  });
  expect(proc.exitCode).toBe(0);
  if (options.mutate) {
    writeFileSync(caddyfile, options.mutate(readFileSync(caddyfile, "utf8")));
  }
  const input = readFileSync(caddyfile, "utf8");
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
migrate_managed_caddyfile
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
    input,
    caddyfilePath: caddyfile,
    caddyfile: readFileSync(caddyfile, "utf8"),
    calls: existsSync(calls) ? readFileSync(calls, "utf8") : "",
  };
}

// What a fresh install writes for this kind today: the migration's target.
function currentRendering(kind: "hosted" | "self-hosted"): string {
  const proc = Bun.spawnSync([
    "bash",
    "-c",
    `${RENDER_NEW}
CADDY_MARKER='# Managed by the isomux installer'
out=$(mktemp)
render_caddyfile ${kind} "$out" office.example
cat "$out"
rm -f "$out"
`,
  ]);
  expect(proc.exitCode).toBe(0);
  return proc.stdout.toString();
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("deps-only managed Caddyfile migration", () => {
  it("migrates either exact known pre-log rendering to the current rendering of its kind", () => {
    for (const kind of ["hosted", "self-hosted"] as const) {
      const result = run({ kind });
      expect(result.code).toBe(0);
      expect(result.calls.split("\n").filter(Boolean)).toHaveLength(1);
      expect(result.caddyfile).toContain("roll_keep_for 312h");
      expect(result.caddyfile).toContain("request>uri regexp");
      expect(result.caddyfile).toBe(currentRendering(kind));
    }
  });

  it("migrates the exact shipped hosted forward_auth rendering to the current hosted rendering", () => {
    // Every Hosted box runs these bytes until this update. Their forward_auth
    // answers each app request with the office's 404 (task 1fa3c1de).
    const result = run({ kind: "hosted", rendering: "forward-auth" });
    expect(result.input).toContain("forward_auth 127.0.0.1:4000");
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("ISOMUX_UPDATE_WARNING=");
    expect(result.calls.split("\n").filter(Boolean)).toHaveLength(1);
    expect(result.caddyfile).not.toContain("forward_auth");
    expect(result.caddyfile).toBe(currentRendering("hosted"));
  });

  it("leaves a one-byte-different hosted forward_auth rendering untouched and warns", () => {
    const result = run({
      kind: "hosted",
      rendering: "forward-auth",
      mutate: (text) =>
        text.replace(
          "forward_auth 127.0.0.1:4000",
          "forward_auth 127.0.0.1:4001",
        ),
    });
    expect(result.input).toContain("forward_auth 127.0.0.1:4001");
    expect(result.code).toBe(0);
    expect(result.calls).toBe("");
    expect(result.caddyfile).toBe(result.input);
    const warning = result.out.match(/^ISOMUX_UPDATE_WARNING=.*$/m)?.[0];
    expect(warning).toContain(result.caddyfilePath);
  });

  it("silently leaves either exact known post-log rendering byte-identical", () => {
    for (const kind of ["hosted", "self-hosted"] as const) {
      const result = run({ kind, rendering: "post-log" });
      expect(result.code).toBe(0);
      expect(result.out).toBe("");
      expect(result.calls).toBe("");
      expect(result.caddyfile).toBe(result.input);
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
    const warning = result.out.match(/^ISOMUX_UPDATE_WARNING=.*$/m)?.[0];
    expect(warning).toContain(result.caddyfilePath);
  });

  it("warns and continues when the prior Caddy config was restored", () => {
    const result = run({ transactionFails: true });
    expect(result.code).toBe(0);
    expect(result.calls).toMatch(/^transaction /m);
    expect(result.out).toMatch(/^ISOMUX_UPDATE_WARNING=\S/m);
  });

  it("fails when migration leaves Caddy down", () => {
    const result = run({
      transactionFails: true,
      caddyAfterFailure: "inactive",
    });
    expect(result.code).not.toBe(0);
    // It stops and names the file the operator must restore.
    expect(result.out.match(/^DIE: .*$/m)?.[0]).toContain(result.caddyfilePath);
  });

  it("fails when Caddy still reports active but the restored front door is dead", () => {
    const result = run({
      transactionFails: true,
      caddyAfterFailure: "active",
      frontDoorAfterFailure: "dead",
    });
    expect(result.code).not.toBe(0);
    // It stops and names the file the operator must restore.
    expect(result.out.match(/^DIE: .*$/m)?.[0]).toContain(result.caddyfilePath);
  });
});

function runTransaction(options: {
  existingLogs?: boolean;
  officeLogSymlink?: boolean;
  invalidExtraction?: boolean;
  logDirectoryAbsent?: boolean;
  frontDoor?: "healthy" | "active-then-dead" | "dead" | "new-dead-old-healthy";
  // A hosted box whose TLS key only root can read: Caddy could not load it.
  rootOnlyKey?: boolean;
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
  if (options.rootOnlyKey) {
    writeFileSync(join(tlsDir, "key.pem"), "key\n");
    executable("stat", "echo root:root:600");
  }

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
${ASSERT_FILE}
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
    tlsDir,
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

  it("refuses a root-only key before replacing the Caddyfile", () => {
    expect(ASSERT_FILE).toContain("assert_caddy_file() {");
    const result = runTransaction({ rootOnlyKey: true });
    expect(result.code).not.toBe(0);
    expect(result.calls).toContain("caddy validate");
    expect(result.out).toContain(join(result.tlsDir, "key.pem"));
    expect(result.config).toBe(
      "# old config\noffice.example {\n\trespond 404\n}\n",
    );
    expect(result.calls).not.toContain("systemctl restart");
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
