// deploy/install.sh rides out a GitHub outage (task 6f9db7cd). On 2026-11-08
// every GitHub release download answered HTTP 504 for about an hour, and one
// 504 failed the whole install. Each GitHub download now retries for minutes,
// and a download that still fails says that GitHub did not answer.
//
// The installer's own functions are extracted and run with the real curl
// against deploy/github-stub.ts. The Bun download is covered in
// install-bun.test.ts and the container mode lookups in
// install-container.test.ts, beside their other cases. Zero LLM.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  callsFor,
  retryWaitSeconds,
  startGithubStub,
  type GithubStub,
} from "./github-stub.ts";

const source = readFileSync(new URL("./install.sh", import.meta.url), "utf8");

function region(from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`install.sh lost ${from}`);
  return source.slice(start, end);
}

function fn(name: string): string {
  const body = source.match(
    new RegExp(`^${name}\\(\\) [({][\\s\\S]*?^[)}]$`, "m"),
  )?.[0];
  if (!body) throw new Error(`install.sh lost ${name}`);
  return body;
}

// The retry flags, the message and github_download, which sit together just
// above the Caddy pin, and the Caddy pin and its installer.
const RETRY = region("GITHUB_RETRY=", "\n# Caddy releases");
const CADDY = region("CADDY_VERSION=", "install_packages() {");
const CADDY_VERSION = source.match(/^CADDY_VERSION=(.+)$/m)![1]!;

// What the installer says when GitHub does not answer, read from the
// installer so a copy edit does not break the tests.
const GITHUB_DOWN = spawnSync(
  "bash",
  ["-c", `log() { :; }\n${RETRY}\nprintf %s "$GITHUB_DOWN"`],
  { encoding: "utf8" },
).stdout;

// Waits under 2 minutes ride out less than the 2026-11-08 outage's bursts.
const MIN_RETRY_WAIT_S = 90;
// Five retries at the stub's 1 s delay, plus margin for a loaded box.
const CASE_TIMEOUT_MS = 20_000;

let base: string;
let stub: GithubStub;
let cases = 0;

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "isomux-github-retry-"));
  stub = await startGithubStub(base);
});

afterAll(() => {
  stub.stop();
  rmSync(base, { recursive: true, force: true });
});

function newCase() {
  const id = `c${++cases}`;
  const dir = join(base, id);
  mkdirSync(dir);
  return { id, dir, calls: join(dir, "calls") };
}

async function run(
  c: ReturnType<typeof newCase>,
  script: string,
  env: Record<string, string> = {},
) {
  // One stream, so the order of log lines and curl's errors is kept.
  const child = Bun.spawn(["bash", "-c", `exec 2>&1\n${script}`], {
    env: { HOME: c.dir, FIXTURE: c.dir, ...stub.env(c.id, c.calls), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const calls = existsSync(c.calls) ? readFileSync(c.calls, "utf8") : "";
  return { code, out: out + err, calls };
}

describe.concurrent("install.sh: the pinned Caddy release from GitHub", () => {
  const release = `https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}`;
  const deb = `${release}/caddy_${CADDY_VERSION}_linux_amd64.deb`;
  const sums = `${release}/caddy_${CADDY_VERSION}_checksums.txt`;
  const hash = new Bun.CryptoHasher("sha512").update("package").digest("hex");

  function caddyCase(
    debFailures: number,
    sumFailures: number,
    fail: "504" | "drop" = "504",
  ) {
    const c = newCase();
    stub.plan(c.id, deb, { failures: debFailures, fail, body: "package" });
    stub.plan(c.id, sums, {
      failures: sumFailures,
      body: `${hash}  caddy_${CADDY_VERSION}_linux_amd64.deb\n`,
    });
    const script = `
set -Eeuo pipefail
log() { echo "LOG: $*"; }
die() { echo "DIE: $*" >&2; exit 1; }
${RETRY}
${CADDY}
dpkg-query() { :; }
dpkg() { echo amd64; }
apt_install() { cat "$1" > "$FIXTURE/installed"; }
install_caddy_release
`;
    return { c, script };
  }

  it(
    "installs after five 504s on the package and one on its checksums",
    async () => {
      const { c, script } = caddyCase(5, 1);
      const r = await run(c, script);
      expect({ code: r.code, out: r.out }).toEqual({
        code: 0,
        out: expect.any(String),
      });
      expect(readFileSync(join(c.dir, "installed"), "utf8")).toBe("package");
      expect(stub.hits(c.id, deb)).toBe(6);
      expect(stub.hits(c.id, sums)).toBe(2);
      for (const url of [deb, sums]) {
        const made = callsFor(r.calls, url);
        expect(made).toHaveLength(1);
        expect(retryWaitSeconds(made[0]!)).toBeGreaterThanOrEqual(
          MIN_RETRY_WAIT_S,
        );
      }
      // The minutes of retries come after a line that says what downloads.
      const lines = r.out.split("\n");
      const said = lines.findIndex(
        (l) => l.startsWith("LOG: ") && l.includes(CADDY_VERSION),
      );
      const firstRetry = lines.findIndex((l) => l.startsWith("curl: "));
      expect(said).toBeGreaterThan(-1);
      expect(said).toBeLessThan(firstRetry);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "installs after the connection closes twice with no reply",
    async () => {
      const { c, script } = caddyCase(2, 0, "drop");
      const r = await run(c, script);
      expect({ code: r.code, out: r.out }).toEqual({
        code: 0,
        out: expect.any(String),
      });
      expect(readFileSync(join(c.dir, "installed"), "utf8")).toBe("package");
      expect(stub.hits(c.id, deb)).toBe(3);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "stops after six tries, installs nothing and says GitHub did not answer",
    async () => {
      const { c, script } = caddyCase(1_000, 0);
      const r = await run(c, script);
      expect(r.code).not.toBe(0);
      expect(existsSync(join(c.dir, "installed"))).toBe(false);
      expect(stub.hits(c.id, deb)).toBe(6);
      expect(stub.hits(c.id, sums)).toBe(0);
      expect(GITHUB_DOWN.length).toBeGreaterThan(0);
      expect(r.out).toContain(GITHUB_DOWN);
    },
    CASE_TIMEOUT_MS,
  );
});

describe.concurrent("install.sh: the latest release lookup on GitHub", () => {
  const OFFICIAL = "https://github.com/nmamano/isomux.git";
  const latest = (repo: string) =>
    `https://api.github.com/repos/${repo}/releases/latest`;

  const script = `
${RETRY}
${fn("is_official_repo")}
${fn("resolve_default_ref")}
log() { echo "LOG: $*"; }
die() { echo "DIE: $*"; exit 1; }
DRY_RUN=""
resolve_default_ref
echo "REF=$ISOMUX_REF"
`;

  it(
    "resolves the tag after five 504s, each with a body",
    async () => {
      const c = newCase();
      const url = latest("nmamano/isomux");
      stub.plan(c.id, url, {
        failures: 5,
        body: '{"tag_name":"v2026.11.8"}',
      });
      const r = await run(c, script, { ISOMUX_REPO: OFFICIAL, ISOMUX_REF: "" });
      expect({ code: r.code, out: r.out }).toEqual({
        code: 0,
        out: expect.stringMatching(/^REF=v2026\.11\.8$/m),
      });
      expect(stub.hits(c.id, url)).toBe(6);
      const made = callsFor(r.calls, url);
      expect(made).toHaveLength(1);
      expect(retryWaitSeconds(made[0]!)).toBeGreaterThanOrEqual(
        MIN_RETRY_WAIT_S,
      );
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "resolves the tag after the connection closes twice with no reply",
    async () => {
      const c = newCase();
      const url = latest("nmamano/isomux");
      stub.plan(c.id, url, {
        failures: 2,
        fail: "drop",
        body: '{"tag_name":"v2026.11.8"}',
      });
      const r = await run(c, script, { ISOMUX_REPO: OFFICIAL, ISOMUX_REF: "" });
      expect({ code: r.code, out: r.out }).toEqual({
        code: 0,
        out: expect.stringMatching(/^REF=v2026\.11\.8$/m),
      });
      expect(stub.hits(c.id, url)).toBe(3);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "on the official repo, a 403 (rate limit) stops at once and does not claim six tries",
    async () => {
      const c = newCase();
      const url = latest("nmamano/isomux");
      stub.plan(c.id, url, { failures: 0, status: 403, body: "{}" });
      const r = await run(c, script, { ISOMUX_REPO: OFFICIAL, ISOMUX_REF: "" });
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(/^DIE: /m);
      expect(r.out).not.toContain(GITHUB_DOWN);
      expect(stub.hits(c.id, url)).toBe(1);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "takes a 404 (no releases yet) at once: main, one request",
    async () => {
      const c = newCase();
      const url = latest("nmamano/isomux");
      stub.plan(c.id, url, { failures: 0, status: 404, body: "{}" });
      const r = await run(c, script, { ISOMUX_REPO: OFFICIAL, ISOMUX_REF: "" });
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/^REF=main$/m);
      expect(stub.hits(c.id, url)).toBe(1);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "on the official repo, stops after six tries and says GitHub did not answer",
    async () => {
      const c = newCase();
      const url = latest("nmamano/isomux");
      stub.plan(c.id, url, { failures: 1_000 });
      const r = await run(c, script, { ISOMUX_REPO: OFFICIAL, ISOMUX_REF: "" });
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(/^DIE: /m);
      expect(r.out).not.toMatch(/^REF=/m);
      expect(r.out).toContain(GITHUB_DOWN);
      expect(stub.hits(c.id, url)).toBe(6);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "on a fork, retries too, then installs main with a warning",
    async () => {
      const c = newCase();
      const url = latest("someone/isomux-fork");
      stub.plan(c.id, url, { failures: 1_000 });
      const r = await run(c, script, {
        ISOMUX_REPO: "https://github.com/someone/isomux-fork.git",
        ISOMUX_REF: "",
      });
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/^REF=main$/m);
      expect(r.out).toMatch(/^LOG: warning: /m);
      expect(stub.hits(c.id, url)).toBe(6);
    },
    CASE_TIMEOUT_MS,
  );
});

describe.concurrent("install.sh: the GitHub CLI key", () => {
  const KEY = "https://cli.github.com/packages/githubcli-archive-keyring.gpg";

  // install_github_cli with its system paths moved into the case directory,
  // as in install-deps-mode.test.ts.
  function githubCliScript(dir: string): string {
    const body = fn("install_github_cli")
      .replaceAll(
        "/usr/share/keyrings/githubcli-archive-keyring.gpg",
        join(dir, "keyring.gpg"),
      )
      .replaceAll(
        "/etc/apt/sources.list.d/github-cli.list",
        join(dir, "github-cli.list"),
      )
      .replaceAll(
        "/usr/share/keyrings/.githubcli-keyring.XXXXXXXXXX",
        join(dir, ".keyring.XXXXXXXXXX"),
      )
      .replaceAll(
        "/etc/apt/sources.list.d/.github-cli.XXXXXXXXXX",
        join(dir, ".source.XXXXXXXXXX"),
      );
    return `
set -Eeuo pipefail
log() { echo "LOG: $*"; }
${RETRY}
${body}
DRY_RUN=""
apt_get() { :; }
apt_install() { echo "APT_INSTALL: $*"; }
dpkg() { echo amd64; }
install_github_cli
`;
  }

  it(
    "adds the repository after two 504s on the key",
    async () => {
      const c = newCase();
      stub.plan(c.id, KEY, { failures: 2, body: "key" });
      writeFileSync(join(c.dir, "github-cli.list"), "stale\n");
      const r = await run(c, githubCliScript(c.dir));
      expect({ code: r.code, out: r.out }).toEqual({
        code: 0,
        out: expect.not.stringMatching(/^LOG: warning: /m),
      });
      expect(readFileSync(join(c.dir, "keyring.gpg"), "utf8")).toBe("key");
      expect(r.out).toContain("APT_INSTALL: gh");
      expect(stub.hits(c.id, KEY)).toBe(3);
      const made = callsFor(r.calls, KEY);
      expect(made).toHaveLength(1);
      expect(retryWaitSeconds(made[0]!)).toBeGreaterThanOrEqual(
        MIN_RETRY_WAIT_S,
      );
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "adds the repository after the connection closes twice with no reply",
    async () => {
      const c = newCase();
      stub.plan(c.id, KEY, { failures: 2, fail: "drop", body: "key" });
      const r = await run(c, githubCliScript(c.dir));
      expect(r.code).toBe(0);
      expect(readFileSync(join(c.dir, "keyring.gpg"), "utf8")).toBe("key");
      expect(stub.hits(c.id, KEY)).toBe(3);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "after six tries goes on without gh, with a warning and no advice to retry the install",
    async () => {
      const c = newCase();
      stub.plan(c.id, KEY, { failures: 1_000 });
      const r = await run(c, githubCliScript(c.dir));
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/^LOG: warning: /m);
      expect(r.out).not.toContain("APT_INSTALL:");
      expect(r.out).not.toContain(GITHUB_DOWN);
      expect(stub.hits(c.id, KEY)).toBe(6);
    },
    CASE_TIMEOUT_MS,
  );
});
