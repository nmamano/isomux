// deploy/install.sh - the hosted certificate renewal helper and its refresh on
// update. Both run for real under bash, with the box paths moved into a
// temporary root and stubs for the commands that need root or the network
// (curl, chown, install's owner flags, runuser, systemctl, sync). openssl and
// jq are real, so the certificate checks the helper makes are the real ones.
// One case runs real curl against a local server.

import { describe, it, expect, afterEach } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SRC = readFileSync(new URL("./install.sh", import.meta.url), "utf8");

function between(start: string, end: string): string {
  const from = SRC.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = SRC.indexOf(end, from + start.length);
  expect(to).toBeGreaterThan(from);
  return SRC.slice(from + start.length, to);
}

/** A function's source. `next` names the function after it, for a body whose
 * heredoc holds a closing brace at column 0. */
const fnBody = (name: string, next?: string) => {
  const start = SRC.indexOf(`\n${name}() {`);
  expect(start).toBeGreaterThan(-1);
  const end = next
    ? SRC.indexOf(`\n}\n`, SRC.indexOf(`\n${next}() {`, start) - 3)
    : SRC.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start + 1, end + 3);
};

const HELPER = between("<<'RENEW_HELPER'\n", "\nRENEW_HELPER\n") + "\n";
const DOMAIN = "office.example";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function sh(script: string, ...args: string[]): string {
  const result = Bun.spawnSync(["bash", "-c", script, "bash", ...args]);
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

/** A key and the control plane's answer for it, made once for every case. */
function issuedFor(dir: string, name: string) {
  const key = join(dir, `${name}.key`);
  const pem = sh(
    `openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1" 2>/dev/null
openssl req -new -key "$1" -subj "/CN=$2" -addext "subjectAltName=DNS:$2,DNS:*.$2" |
  openssl x509 -req -signkey "$1" -days 30 -copy_extensions copy 2>/dev/null`,
    key,
    DOMAIN,
  );
  const answer = JSON.stringify({ certificate: pem });
  // The bytes the helper writes from that answer.
  const installed = sh(`jq -er .certificate <<<"$1"`, answer);
  return { key: readFileSync(key, "utf8"), answer, installed };
}
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "isomux-renew-keys-"));
const OFFICE = issuedFor(FIXTURE_DIR, "office");
const OTHER = issuedFor(FIXTURE_DIR, "other");
rmSync(FIXTURE_DIR, { recursive: true, force: true });

function stub(dir: string, name: string, body: string) {
  writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
}

/**
 * A temporary box: the helper with its paths moved under `root`, and stubs.
 * `installed` gives it OFFICE's key and certificate, as after a renewal.
 * `endpoint` with `realCurl` sends the helper's calls to a real server.
 */
function makeBox(
  opts: { installed?: boolean; endpoint?: string; realCurl?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "isomux-renew-"));
  roots.push(root);
  const etc = join(root, "etc/isomux");
  const tls = join(etc, "tls");
  mkdirSync(join(etc, "renewal"), { recursive: true });
  writeFileSync(
    join(etc, "renewal/enrollment.json"),
    JSON.stringify({
      endpoint:
        opts.endpoint ?? "https://cp.test/internal/certificates/renew",
      token: "t".repeat(40),
    }),
  );
  if (opts.installed) {
    mkdirSync(tls);
    writeFileSync(join(tls, "key.pem"), OFFICE.key, { mode: 0o640 });
    writeFileSync(join(tls, "cert.pem"), OFFICE.installed, { mode: 0o640 });
  }
  const bin = join(root, "bin");
  mkdirSync(bin);
  const helper = join(root, "isomux-renew-certificate");
  writeFileSync(helper, HELPER.replaceAll("/etc/isomux", etc), {
    mode: 0o700,
  });
  stub(bin, "chown", "exit 0");
  stub(bin, "sync", "exit 0");
  stub(
    bin,
    "install",
    `args=(); while (($#)); do case $1 in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done
exec /usr/bin/install "\${args[@]}"`,
  );
  stub(
    bin,
    "runuser",
    `while [[ $1 != -- ]]; do shift; done; shift; exec "$@"`,
  );
  stub(
    bin,
    "systemctl",
    `printf '%s\\n' "$*" >> "${root}/systemctl.log"
case $1 in
  is-active) exit 0 ;;
  restart) [[ ! -e "${root}/restart-fails" ]] ;;
esac`,
  );
  // The control plane. /renew signs the request with the box key, or returns
  // a canned answer; /status records what the box reported.
  stub(
    bin,
    "curl",
    `${opts.realCurl ? 'exec /usr/bin/curl "$@"' : ""}
url=\${@: -1}
data=""; prev=""; out=/dev/stdout
for arg in "$@"; do
  [[ $prev == --data ]] && data=$arg
  [[ $prev == --output ]] && out=$arg
  prev=$arg
done
printf '%s\\t%s\\t%s\\n' "\${url##*/}" "$data" "$*" >> "${root}/curl.log"
case $url in
  */renew)
    # Read the request first, as curl does: an unread pipe would fail the
    # helper's jq with SIGPIPE before any check this test is about.
    request=$(cat)
    [[ ! -e "${root}/renew-unreachable" ]] || { echo "curl: (7) Failed to connect" >&2; exit 7; }
    if [[ -e "${root}/answer.json" ]]; then cat "${root}/answer.json" > "$out"; exit 0; fi
    jq -r .csr <<<"$request" |
      openssl x509 -req -signkey "${tls}/key.pem" -days 30 \\
        -copy_extensions copy -out "${root}/issued.pem" 2>/dev/null
    jq -n --rawfile c "${root}/issued.pem" '{certificate:$c}' > "$out" ;;
  */status)
    [[ ! -e "${root}/status-unreachable" ]] || { echo "curl: (56) Recv failure" >&2; exit 56; }
    jq -r .status <<<"$data" >> "${root}/status.log" ;;
esac`,
  );
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOMAIN };
  const read = (name: string) =>
    existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : "";
  return {
    root,
    helper,
    env,
    run: () => Bun.spawnSync(["bash", helper], { env }),
    statuses: () => read("status.log").split("\n").filter(Boolean),
    curlCalls: () => read("curl.log").split("\n").filter(Boolean),
    systemctl: () => read("systemctl.log"),
    flag: (name: string) => writeFileSync(join(root, name), ""),
    answer: (body: string) => writeFileSync(join(root, "answer.json"), body),
    cert: () => readFileSync(join(tls, "cert.pem"), "utf8"),
  };
}

describe("certificate renewal helper", () => {
  it("installs a new certificate, restarts Caddy and reports ok", () => {
    const box = makeBox();
    const result = box.run();
    expect(result.exitCode).toBe(0);
    expect(box.cert()).toContain("BEGIN CERTIFICATE");
    expect(box.systemctl()).toContain("restart caddy");
    expect(box.statuses()).toEqual(["ok"]);
  });

  it("reports ok without a restart when the answer is the installed certificate", () => {
    const box = makeBox({ installed: true });
    box.answer(OFFICE.answer);
    expect(box.run().exitCode).toBe(0);
    expect(box.systemctl()).not.toContain("restart");
    expect(box.statuses()).toEqual(["ok"]);
  });

  it("sends no report when the control plane cannot be reached", () => {
    const box = makeBox({ installed: true });
    box.flag("renew-unreachable");
    const result = box.run();
    expect(result.exitCode).not.toBe(0);
    expect(box.cert()).toBe(OFFICE.installed);
    expect(box.statuses()).toEqual([]);
    expect(box.curlCalls().some((c) => c.startsWith("status"))).toBe(false);
  });

  it("does not turn a failed ok report into a failure report", () => {
    const box = makeBox({ installed: true });
    box.answer(OFFICE.answer);
    box.flag("status-unreachable");
    expect(box.run().exitCode).not.toBe(0);
    const reports = box
      .curlCalls()
      .filter((c) => c.startsWith("status"))
      .map((c) => JSON.parse(c.split("\t")[1]).status);
    expect(reports).toEqual(["ok"]);
  });

  it("reports failed and restores the previous certificate when Caddy will not restart", () => {
    const box = makeBox({ installed: true });
    box.flag("restart-fails");
    expect(box.run().exitCode).not.toBe(0);
    expect(box.cert()).toBe(OFFICE.installed);
    expect(box.statuses()).toEqual(["failed"]);
  });

  it("reports failed and keeps the installed certificate when the answer does not fit the key", () => {
    const box = makeBox({ installed: true });
    box.answer(OTHER.answer);
    expect(box.run().exitCode).not.toBe(0);
    expect(box.cert()).toBe(OFFICE.installed);
    expect(box.systemctl()).not.toContain("restart");
    expect(box.statuses()).toEqual(["failed"]);
  });

  it("bounds and retries both calls to the control plane", () => {
    const box = makeBox({ installed: true });
    box.answer(OFFICE.answer);
    expect(box.run().exitCode).toBe(0);
    const calls = box.curlCalls();
    expect(calls.map((c) => c.split("\t")[0])).toEqual(["renew", "status"]);
    for (const call of calls) {
      expect(call).toMatch(/--max-time \d+/);
      expect(call).toContain("--retry-all-errors");
    }
  });

  it("accepts a retried answer after a partial one, with real curl", async () => {
    // The first renew response promises more bytes than it sends and closes:
    // curl fails that transfer and retries. The retry must start a fresh
    // answer, not append to the partial one.
    let renews = 0;
    const statuses: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.url?.endsWith("/renew")) {
          renews++;
          if (renews === 1) {
            res.writeHead(200, { "Content-Length": "4096" });
            res.write('{"certificate":');
            setTimeout(() => res.socket?.destroy(), 20);
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(OFFICE.answer);
          return;
        }
        statuses.push(JSON.parse(body).status);
        res.end("ok\n");
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const { port } = server.address() as AddressInfo;
      const box = makeBox({
        installed: true,
        realCurl: true,
        endpoint: `http://127.0.0.1:${port}/internal/certificates/renew`,
      });
      // The retry delay is not under test; one second keeps the case short.
      const helper = readFileSync(box.helper, "utf8");
      expect(helper).toContain("--retry-delay 30");
      writeFileSync(
        box.helper,
        helper.replace("--retry-delay 30", "--retry-delay 1"),
      );
      const proc = Bun.spawn(["bash", box.helper], {
        env: box.env,
        stderr: "pipe",
      });
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      // The partial first transfer did happen and did fail.
      expect(renews).toBe(2);
      expect(stderr).toMatch(/curl: \(18\)/);
      expect(statuses).toEqual(["ok"]);
      expect(exitCode).toBe(0);
      expect(box.cert()).toBe(OFFICE.installed);
    } finally {
      server.close();
    }
  });
});

describe("certificate renewal refresh on update", () => {
  /** refresh_hosted_tls_renewal with the box paths moved under a temp root. */
  function makeUpdateBox() {
    const root = mkdtempSync(join(tmpdir(), "isomux-renew-update-"));
    roots.push(root);
    for (const dir of ["etc/isomux", "etc/systemd/system", "usr/local/sbin"])
      mkdirSync(join(root, dir), { recursive: true });
    const script = [
      fnBody("write_file"),
      fnBody("write_hosted_tls_renewal", "install_hosted_tls_renewal"),
      fnBody("refresh_hosted_tls_renewal"),
    ]
      .join("\n")
      .replaceAll("/etc/isomux", `${root}/etc/isomux`)
      .replaceAll("/etc/systemd/system", `${root}/etc/systemd/system`)
      .replaceAll("/usr/local/sbin", `${root}/usr/local/sbin`);
    const helperText = HELPER.replaceAll("/etc/isomux", `${root}/etc/isomux`);
    const harness = `set -Eeuo pipefail
DRY_RUN=
run() { printf '%s\\n' "$*" >> "${root}/run.log"; }
log() { printf '%s\\n' "$*" >> "${root}/log"; }
install() { local a=(); while (($#)); do case $1 in -o|-g) shift 2 ;; *) a+=("$1"); shift ;; esac; done; command install "\${a[@]}"; }
${script}
refresh_hosted_tls_renewal`;
    const path = (p: string) => join(root, p);
    const read = (p: string) =>
      existsSync(path(p)) ? readFileSync(path(p), "utf8") : "";
    return {
      path,
      read,
      helperText,
      run: () => Bun.spawnSync(["bash", "-c", harness]),
      helper: "usr/local/sbin/isomux-renew-certificate",
      unit: "etc/systemd/system/isomux-certificate-renew.service",
      timer: "etc/systemd/system/isomux-certificate-renew.timer",
    };
  }

  const enroll = (box: ReturnType<typeof makeUpdateBox>) => {
    mkdirSync(box.path("etc/isomux/renewal"), { recursive: true });
    writeFileSync(box.path("etc/isomux/renewal/enrollment.json"), "{}");
  };

  it("changes nothing on a box with no enrollment", () => {
    const box = makeUpdateBox();
    expect(box.run().exitCode).toBe(0);
    expect(existsSync(box.path(box.helper))).toBe(false);
    expect(existsSync(box.path(box.unit))).toBe(false);
    expect(existsSync(box.path(box.timer))).toBe(false);
    expect(existsSync(box.path("etc/isomux/tls"))).toBe(false);
    expect(box.read("run.log")).toBe("");
  });

  it("rewrites an enrolled box's helper and units for the same domain", () => {
    const box = makeUpdateBox();
    enroll(box);
    writeFileSync(box.path(box.helper), "#!/bin/sh\nold helper\n", {
      mode: 0o700,
    });
    writeFileSync(
      box.path(box.unit),
      `[Service]\nEnvironment=DOMAIN=${DOMAIN}\nExecStart=old\n`,
    );
    expect(box.run().exitCode).toBe(0);
    expect(box.read(box.helper)).toBe(box.helperText);
    expect(statSync(box.path(box.helper)).mode & 0o777).toBe(0o700);
    expect(box.read(box.unit)).toContain(`Environment=DOMAIN=${DOMAIN}\n`);
    expect(box.read(box.unit)).toMatch(
      /\nExecStart=\S*\/usr\/local\/sbin\/isomux-renew-certificate\n/,
    );
    expect(box.read(box.timer)).toContain("OnCalendar=daily");
    const run = box.read("run.log");
    expect(run).toContain("systemctl daemon-reload");
    expect(run).toContain("systemctl enable --now isomux-certificate-renew.timer");
    // The timer runs the new helper. An update does not renew.
    expect(run).not.toContain("isomux-renew-certificate\n");
  });

  it("warns and writes nothing when the unit names no domain", () => {
    const box = makeUpdateBox();
    enroll(box);
    writeFileSync(box.path(box.helper), "#!/bin/sh\nold helper\n");
    expect(box.run().exitCode).toBe(0);
    expect(box.read(box.helper)).toBe("#!/bin/sh\nold helper\n");
    expect(box.read("log")).toContain("ISOMUX_UPDATE_WARNING=");
    expect(box.read("run.log")).toBe("");
  });

  it("is called from the update path", () => {
    expect(fnBody("deps_only")).toContain("refresh_hosted_tls_renewal");
  });
});
