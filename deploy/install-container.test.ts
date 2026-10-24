import { afterAll, describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserRecord } from "../shared/types.ts";

const source = readFileSync(new URL("./install.sh", import.meta.url), "utf8");
const definitions = source.slice(0, source.lastIndexOf('\nmain "$@"'));
const fixtures: string[] = [];
// The cases run concurrently, each in its own fixture. Measured 2026-10-25:
// the whole file took 3.9 s with 16 competing CPU workers. Each Bash process
// has a 10 s limit.
const INSTALL_CASE_TIMEOUT_MS = 15_000;
const INSTALL_PROCESS_TIMEOUT_MS = 10_000;
const digest = `ghcr.io/nmamano/isomux@sha256:${"a".repeat(64)}`;

// Real Bash and generated files; root, mounts, network and service mutations are
// simulated. No test changes host packages, services, mounts or Docker objects.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "isomux-container-install-"));
  fixtures.push(dir);
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "data"));
  writeFileSync(join(dir, "installer"), source);
  writeFileSync(
    join(dir, "bin", "docker"),
    `#!/bin/bash
printf 'docker %s\\n' "$*" >> "$FIXTURE/events"
case "$1 $2" in
  'ps -aq') cat "$FIXTURE/containers" 2>/dev/null || true ;;
  'inspect '*) cat "$FIXTURE/container.json" ;;
  'image inspect') if [[ "$*" == *org.opencontainers.image.revision* ]]; then cat "$FIXTURE/revision"; exit 0; fi; printf '["%s"]\\n' "$(cat "$FIXTURE/digest")" ;;
  'version --format') echo 29.1.3 ;;
  'pull '*) [[ ! -e "$FIXTURE/fail-pull" ]] ;;
  *) exit 0 ;;
esac
`,
  );
  chmodSync(join(dir, "bin", "docker"), 0o755);
  writeFileSync(join(dir, "digest"), digest);
  writeFileSync(join(dir, "revision"), "0".repeat(39) + "1\n");
  // The guard is a separate Bash process and finds these stubs through PATH.
  // Both record the query, so a refusal shows how far the mount check got.
  writeFileSync(
    join(dir, "bin", "mountpoint"),
    '#!/bin/bash\necho mountpoint >> "$FIXTURE/events"\n[[ ! -e "$FIXTURE/missing-mount" ]]\n',
  );
  writeFileSync(
    join(dir, "bin", "findmnt"),
    '#!/bin/bash\necho "findmnt ${*: -1}" >> "$FIXTURE/events"\ncase "${*: -1}" in UUID) cat "$FIXTURE/uuid";; OPTIONS) cat "$FIXTURE/options";; esac\n',
  );
  chmodSync(join(dir, "bin", "mountpoint"), 0o755);
  chmodSync(join(dir, "bin", "findmnt"), 0o755);
  writeFileSync(join(dir, "uuid"), "fixture-uuid\n");
  writeFileSync(join(dir, "options"), "rw,relatime\n");
  return dir;
}

let harnesses = 0;

async function run(dir: string, script: string, alternate = definitions) {
  const prefix = `
CONTAINER_DIR="$FIXTURE/config"
CONTAINER_DATA="$FIXTURE/data"
CONTAINER_UNIT="$FIXTURE/unit"
CONTAINER_LOCK="$FIXTURE/install.lock"
CONTAINER_STAGE_PARENT="$FIXTURE"
CONTAINER_INSTALLER="$FIXTURE/installer"
CADDY_DIR="$FIXTURE"
CADDYFILE="$FIXTURE/Caddyfile"
INSTALL_DIR="$FIXTURE/host-office"
SERVICE_HOME="$FIXTURE/host-home"
UPDATE_CONF="$FIXTURE/update.conf"
STATE_DIR="$FIXTURE/state"
ISOMUX_REF=v2026.9.21
DOMAIN=office.example.com
HEALTH_TIMEOUT_S=1
stat() { command stat "$@" | sed 's/^[0-9]*:/0:/'; }
systemctl() {
  printf 'systemctl %s\\n' "$*" >> "$FIXTURE/events"
  case "$1" in
    cat) return 1;;
    is-active) return 1;;
    restart) [[ ! -e "$FIXTURE/fail-start" ]];;
  esac
}
curl() {
  if [[ "$*" == *api.github.com* ]]; then echo "curl api.github.com" >> "$FIXTURE/events"; printf '{"sha":"%040d"}\\n' 1;
  elif [[ "$*" == *raw.githubusercontent.com* ]]; then echo "curl raw.githubusercontent.com" >> "$FIXTURE/events"; cp "$FIXTURE/installer" "\${@: -1}";
  else printf 200; fi
}
dpkg-query() { echo dpkg-query >> "$FIXTURE/events"; [[ ! -e "$FIXTURE/default-caddy" ]] || printf '/etc/caddy/Caddyfile %s\\n' "$(md5sum "$FIXTURE/default-caddy" | cut -d ' ' -f 1)"; }
# Record which function refused the run, so a refusal names its guard.
if declare -F die >/dev/null; then
  eval "recorded_$(declare -f die)"
  die() { echo "\${FUNCNAME[1]}" >> "$FIXTURE/refused-by"; recorded_die "$@"; }
fi
container_require_root() { :; }
preflight() { printf 'preflight\\n' >> "$FIXTURE/events"; }
container_install_updater() {
  printf 'container-updater\\n' >> "$FIXTURE/events"
  printf 'DEPLOYMENT_KIND=container\\nSERVICE_KIND=system\\n' > "$UPDATE_CONF"
  printf 'DEPLOYMENT_KIND=container\\nSERVICE_KIND=system\\n' > "$CONTAINER_STAGE/client-update.conf"
  chmod 644 "$CONTAINER_STAGE/client-update.conf"
}
container_install_packages() { printf 'packages\\n' >> "$FIXTURE/events"; }
configure_firewall() { printf 'firewall\\n' >> "$FIXTURE/events"; }
enable_auto_updates() { printf 'security-updates\\n' >> "$FIXTURE/events"; }
caddy() { printf 'caddy %s\\n' "$*" >> "$FIXTURE/events"; }
install_caddyfile_transaction() { cp "$1" "$CADDYFILE"; }
`;
  // One file per run: a case may run several shells at once.
  const harness = join(dir, `harness-${++harnesses}.sh`);
  writeFileSync(harness, alternate + prefix + script);
  const started = performance.now();
  // Async, so the cases run concurrently.
  const child = Bun.spawn(["bash", harness], {
    // TMPDIR keeps the installer's failure sentinel in the fixture.
    env: {
      PATH: `${dir}/bin:${process.env.PATH}`,
      FIXTURE: dir,
      HOME: dir,
      TMPDIR: dir,
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: INSTALL_PROCESS_TIMEOUT_MS,
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  // A killed shell is a harness failure, including in cases that expect the
  // installer to refuse a configuration. A null exit code must not pass those.
  if (child.signalCode) {
    throw new Error(
      performance.now() - started >= INSTALL_PROCESS_TIMEOUT_MS
        ? `installer shell timed out after ${INSTALL_PROCESS_TIMEOUT_MS} ms`
        : `installer shell terminated by ${child.signalCode}`,
    );
  }
  return { code, out, err };
}

function events(dir: string) {
  const path = join(dir, "events");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function lastEvent(dir: string) {
  return events(dir).trimEnd().split("\n").at(-1);
}

// The function whose die refused the run, or "" when no die ran.
function refusedBy(dir: string) {
  const path = join(dir, "refused-by");
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

// The container office's data disk records a claimed owner.
function writeOwner(dir: string) {
  mkdirSync(join(dir, "data/home/.isomux"), { recursive: true });
  writeFileSync(
    join(dir, "data/home/.isomux/users.json"),
    JSON.stringify({
      a1b2c3d4: {
        id: "a1b2c3d4",
        name: "Owner",
        role: "owner",
        createdAt: 1,
        notifRooms: [],
        allowedRooms: [],
        hidden: [],
        tucked: [],
        pushRooms: [],
        order: [],
        avatarColor: "#112233",
        avatarVariant: "classic",
        memberPrompt: null,
        language: null,
      },
    } satisfies Record<string, UserRecord>),
  );
}

// Cases run concurrently, so fixtures go only after the whole file.
afterAll(() => {
  for (const dir of fixtures.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe.concurrent("container installer", () => {
  it(
    "keeps the direct-host default and dependency-only dispatch",
    async () => {
      // Stub every step the direct-host main calls. The order is pinned in
      // install-sh.test.ts; here only the dispatch matters.
      const body = source.slice(
        source.lastIndexOf("\nmain() {"),
        source.lastIndexOf('\nmain "$@"'),
      );
      const start = body.indexOf("\n  preflight\n");
      expect(start).toBeGreaterThan(0);
      const steps = [...body.slice(start).matchAll(/^ {2}([a-z_]+)$/gm)].map(
        (match) => match[1],
      );
      expect(steps.at(-1)).toBe("report");
      const names = [...steps, "deps_only", "bun_only", "container_main"];
      const stubs = names
        .map((name) => `${name}() { echo ${name}; }`)
        .join("\n");
      const dispatch = async (setup: string, record?: string) => {
        const dir = fixture();
        if (record === "directory") mkdirSync(join(dir, "config"));
        if (record === "unit") writeFileSync(join(dir, "unit"), "");
        const result = await run(dir, `${stubs}\n${setup}main`);
        const reached = result.out
          .split("\n")
          .filter((line) => names.includes(line));
        return { code: result.code, reached, refusedBy: refusedBy(dir) };
      };
      const [host, deps, container, invalid, ...recorded] = await Promise.all([
        dispatch(""),
        dispatch("ISOMUX_DEPS_ONLY=1; "),
        dispatch("ISOMUX_INSTALL_MODE=container; "),
        dispatch("ISOMUX_INSTALL_MODE=invalid; "),
        dispatch("", "directory"),
        dispatch("", "unit"),
      ]);
      expect(host.code).toBe(0);
      expect(host.reached[0]).toBe("preflight");
      expect(host.reached.at(-1)).toBe("report");
      expect(deps).toEqual({ code: 0, reached: ["deps_only"], refusedBy: "" });
      expect(container).toEqual({
        code: 0,
        reached: ["container_main"],
        refusedBy: "",
      });
      expect(invalid).toEqual({ code: 1, reached: [], refusedBy: "main" });
      // A recorded container installation refuses host mode before any step.
      for (const result of recorded)
        expect(result).toEqual({ code: 1, reached: [], refusedBy: "main" });
    },
    INSTALL_CASE_TIMEOUT_MS,
  );

  it(
    "installs once, records identity and repairs with the same secret and digest",
    async () => {
      const dir = fixture();
      const first = await run(dir, "container_main");
      expect(first).toEqual({ code: 0, out: expect.any(String), err: "" });
      expect(events(dir).indexOf("container-updater")).toBeGreaterThanOrEqual(
        0,
      );
      expect(events(dir).indexOf("container-updater")).toBeLessThan(
        events(dir).indexOf("systemctl restart isomux-container.service"),
      );
      const env = readFileSync(join(dir, "config/office.env"), "utf8");
      const key = env.match(/ISOMUX_SETUP_KEY=(.+)/)![1];
      expect(key).toMatch(/^[a-f0-9]{64}$/);
      expect(first.out + first.err + events(dir)).not.toContain(key);
      expect(env).toContain(`ISOMUX_IMAGE=${digest}`);
      expect(readFileSync(join(dir, "config/mount.uuid"), "utf8")).toBe(
        "fixture-uuid\n",
      );
      const second = await run(dir, "container_main");
      expect(second.code).toBe(0);
      expect(readFileSync(join(dir, "config/office.env"), "utf8")).toBe(env);
      expect(events(dir)).toContain(`docker pull ${digest}`);
      const config = readFileSync(join(dir, "Caddyfile"), "utf8");
      expect(config).toContain("127.0.0.1:10000");
      expect(config).not.toContain("127.0.0.1:4000");
      expect(readFileSync(join(dir, "unit"), "utf8")).toContain(
        "ExecStartPre=/opt/isomux-container/mount-check.sh",
      );
      const compose = readFileSync(join(dir, "config/compose.yaml"), "utf8");
      expect(compose).toContain('restart: "no"');
      expect(compose).toContain("create_host_path: false");
      expect(compose).toContain("seccomp=./seccomp/chromium.json");
      expect(events(dir)).not.toMatch(
        /host-office|(?:restart|enable) isomux\.service|nodejs|bun install/,
      );
    },
    INSTALL_CASE_TIMEOUT_MS,
  );

  it(
    "preserves an absent setup key only with a confirmed owner",
    async () => {
      const dir = fixture();
      expect((await run(dir, "container_main")).code).toBe(0);
      const path = join(dir, "config/office.env");
      const env = readFileSync(path, "utf8").replace(
        /^ISOMUX_SETUP_KEY=.*\n/m,
        "",
      );
      writeFileSync(path, env);
      expect((await run(dir, "container_main")).code).not.toBe(0);
      writeOwner(dir);
      expect((await run(dir, "container_main")).code).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(env);
    },
    INSTALL_CASE_TIMEOUT_MS,
  );

  it(
    "points to the setup key only while the office has no owner",
    async () => {
      const dir = fixture();
      const keyFile = join(dir, "config/office.env");
      const first = await run(dir, "container_main");
      expect(first.code).toBe(0);
      expect(first.out).toContain(keyFile);
      const unclaimed = await run(dir, "container_main");
      expect(unclaimed.code).toBe(0);
      expect(unclaimed.out).toContain(keyFile);
      writeOwner(dir);
      const claimed = await run(dir, "container_main");
      expect(claimed.code).toBe(0);
      expect(claimed.out).toContain("https://office.example.com");
      expect(claimed.out).not.toContain(keyFile);
    },
    INSTALL_CASE_TIMEOUT_MS,
  );

  it(
    "rejects a changed tag digest before restarting the office",
    async () => {
      const dir = fixture();
      expect((await run(dir, "container_main")).code).toBe(0);
      writeFileSync(join(dir, "events"), "");
      writeFileSync(
        join(dir, "digest"),
        `ghcr.io/nmamano/isomux@sha256:${"b".repeat(64)}`,
      );
      expect((await run(dir, "container_main")).code).not.toBe(0);
      expect(events(dir)).not.toContain("restart isomux-container");
      expect(readFileSync(join(dir, "config/image"), "utf8").trim()).toBe(
        digest,
      );
    },
    INSTALL_CASE_TIMEOUT_MS,
  );

  it(
    "recovers from service failure without replacing the setup key",
    async () => {
      const dir = fixture();
      writeFileSync(join(dir, "fail-start"), "");
      expect((await run(dir, "container_main")).code).not.toBe(0);
      const env = readFileSync(join(dir, "config/office.env"), "utf8");
      rmSync(join(dir, "fail-start"));
      expect((await run(dir, "container_main")).code).toBe(0);
      expect(readFileSync(join(dir, "config/office.env"), "utf8")).toBe(env);
    },
    INSTALL_CASE_TIMEOUT_MS,
  );

  // Each row names its guard: the function whose die refused the run ("" for
  // a failed command), and the last event before the refusal.
  for (const [condition, guard, reached] of [
    ["missing-mount", "container_mount_identity", "mountpoint"],
    ["read-only", "container_mount_identity", "findmnt OPTIONS"],
    [
      "host-office",
      "container_check_other_office",
      "curl raw.githubusercontent.com",
    ],
    ["custom-caddy", "container_check_caddy", "dpkg-query"],
    ["wrong-installer", "container_main", "curl raw.githubusercontent.com"],
    ["pull-failure", "", "docker pull ghcr.io/nmamano/isomux:v2026.9.21"],
  ]) {
    it(
      `refuses ${condition} without replacing a proxy or starting an office`,
      async () => {
        const dir = fixture();
        if (condition === "missing-mount")
          writeFileSync(join(dir, condition), "");
        if (condition === "read-only")
          writeFileSync(join(dir, "options"), "ro,relatime\n");
        if (condition === "host-office") mkdirSync(join(dir, condition));
        if (condition === "custom-caddy")
          writeFileSync(
            join(dir, "Caddyfile"),
            "unrelated.example.com { respond hello }\n",
          );
        if (condition === "pull-failure")
          writeFileSync(join(dir, "fail-pull"), "");
        const extra =
          condition === "wrong-installer"
            ? 'cp "$CONTAINER_INSTALLER" "$FIXTURE/different-installer"; echo changed >> "$FIXTURE/different-installer"; CONTAINER_INSTALLER="$FIXTURE/different-installer"; '
            : "";
        expect((await run(dir, extra + "container_main")).code).not.toBe(0);
        expect(refusedBy(dir)).toBe(guard);
        expect(lastEvent(dir)).toBe(reached);
        expect(events(dir)).not.toContain("restart isomux-container");
        if (condition !== "pull-failure")
          expect(events(dir)).not.toContain("packages");
        expect(existsSync(join(dir, "config"))).toBe(false);
      },
      INSTALL_CASE_TIMEOUT_MS,
    );
  }

  it(
    "accepts the package default but refuses a modified managed Caddyfile",
    async () => {
      const dir = fixture();
      writeFileSync(join(dir, "Caddyfile"), ":80 { respond default }\n");
      writeFileSync(
        join(dir, "default-caddy"),
        readFileSync(join(dir, "Caddyfile")),
      );
      expect((await run(dir, "container_main")).code).toBe(0);
      writeFileSync(
        join(dir, "Caddyfile"),
        "# Managed by the isomux installer\nother.example.com { respond private }\n",
      );
      writeFileSync(join(dir, "events"), "");
      expect((await run(dir, "container_main")).code).not.toBe(0);
      expect(events(dir)).not.toContain("packages");
    },
    INSTALL_CASE_TIMEOUT_MS,
  );

  it(
    "refuses a different mount UUID on repair and on unit startup",
    async () => {
      const dir = fixture();
      expect((await run(dir, "container_main")).code).toBe(0);
      writeFileSync(join(dir, "uuid"), "other-disk\n");
      writeFileSync(join(dir, "events"), "");
      expect((await run(dir, "container_main")).code).not.toBe(0);
      expect(events(dir)).not.toContain("packages");
      expect(
        (
          await run(
            dir,
            '"$CONTAINER_DIR/mount-check.sh" "$CONTAINER_DATA" "$CONTAINER_DIR/mount.uuid"',
          )
        ).code,
      ).not.toBe(0);
    },
    INSTALL_CASE_TIMEOUT_MS,
  );

  it(
    "does not evaluate shell syntax or expose secrets from saved settings",
    async () => {
      const dir = fixture();
      expect((await run(dir, "container_main")).code).toBe(0);
      writeFileSync(
        join(dir, "config/office.env"),
        `ISOMUX_SETUP_KEY=$(touch ${dir}/executed)\n`,
      );
      const result = await run(dir, "container_main");
      expect(result.code).not.toBe(0);
      expect(existsSync(join(dir, "executed"))).toBe(false);
      expect(result.out + result.err).not.toContain("$(touch");
    },
    INSTALL_CASE_TIMEOUT_MS,
  );

  it(
    "refuses a conflicting data writer or Compose project",
    async () => {
      const install = async (dataWriter: boolean, project: string) => {
        const dir = fixture();
        const source = dataWriter ? join(dir, "data") : "/srv/other";
        writeFileSync(join(dir, "containers"), "other\n");
        writeFileSync(
          join(dir, "container.json"),
          JSON.stringify([
            {
              Mounts: [{ Source: source }],
              Config: {
                Labels: { "com.docker.compose.project": project },
              },
            },
          ]),
        );
        const { code } = await run(dir, "container_main");
        return { dir, code, refusedBy: refusedBy(dir) };
      };
      const [writer, compose, unrelated] = await Promise.all([
        install(true, "other"),
        install(false, "isomux"),
        install(false, "other"),
      ]);
      // An unrelated container is accepted, so the refusals come from the
      // match, not from reading the metadata.
      expect(unrelated).toMatchObject({ code: 0, refusedBy: "" });
      for (const refused of [writer, compose]) {
        expect(refused).toMatchObject({
          code: 1,
          refusedBy: "container_check_docker",
        });
        expect(events(refused.dir)).toContain("docker inspect other");
        expect(events(refused.dir)).not.toMatch(
          /packages|restart isomux-container/,
        );
      }
    },
    INSTALL_CASE_TIMEOUT_MS,
  );
  it(
    "requires Docker 28 or later",
    async () => {
      const dir = fixture();
      for (const version of ["27.5.1", "28.0.0", "29.1.3", "invalid"]) {
        const result = await run(
          dir,
          `docker() { [[ $1 != version ]] || echo ${version}; }; container_check_docker_version`,
        );
        expect(result.code === 0).toBe(
          version === "28.0.0" || version === "29.1.3",
        );
      }
    },
    INSTALL_CASE_TIMEOUT_MS,
  );

  it(
    "repairs a recorded installation interrupted before the unit was written",
    async () => {
      const dir = fixture();
      const result = await run(dir, "install() { return 1; }; container_main");
      expect(result.code).not.toBe(0);
      expect(existsSync(join(dir, "config/release"))).toBe(true);
      expect(existsSync(join(dir, "unit"))).toBe(false);
      const env = readFileSync(join(dir, "config/office.env"), "utf8");
      expect((await run(dir, "container_main")).code).toBe(0);
      expect(readFileSync(join(dir, "config/office.env"), "utf8")).toBe(env);
    },
    INSTALL_CASE_TIMEOUT_MS,
  );

  it(
    "checks the mount before every service start",
    async () => {
      const dir = fixture();
      expect((await run(dir, "container_main")).code).toBe(0);
      const check =
        '"$CONTAINER_DIR/mount-check.sh" "$CONTAINER_DATA" "$CONTAINER_DIR/mount.uuid"';
      expect((await run(dir, check)).code).toBe(0);
      writeFileSync(join(dir, "options"), "ro,relatime\n");
      expect((await run(dir, check)).code).not.toBe(0);
      writeFileSync(join(dir, "options"), "rw,relatime\n");
      writeFileSync(join(dir, "missing-mount"), "");
      expect((await run(dir, check)).code).not.toBe(0);
    },
    INSTALL_CASE_TIMEOUT_MS,
  );

  it(
    "serializes installers before package or service mutation",
    async () => {
      const dir = fixture();
      expect(
        (await run(dir, 'exec 8>"$CONTAINER_LOCK"; flock -n 8; container_main'))
          .code,
      ).not.toBe(0);
      expect(events(dir)).toBe("");
    },
    INSTALL_CASE_TIMEOUT_MS,
  );

  it(
    "refuses damaged or changed private records before package changes",
    async () => {
      const dir = fixture();
      expect((await run(dir, "container_main")).code).toBe(0);
      for (const change of [
        "DOMAIN=other.example.com",
        "ISOMUX_REF=v2026.9.22",
      ]) {
        writeFileSync(join(dir, "events"), "");
        expect((await run(dir, change + "; container_main")).code).not.toBe(0);
        expect(events(dir)).not.toContain("packages");
      }
      writeFileSync(join(dir, "config/compose.yaml"), "custom configuration");
      writeFileSync(join(dir, "events"), "");
      expect((await run(dir, "container_main")).code).not.toBe(0);
      expect(events(dir)).not.toContain("packages");
    },
    INSTALL_CASE_TIMEOUT_MS,
  );

  it(
    "installs only host infrastructure packages and restores Caddy on failure",
    async () => {
      const dir = fixture();
      const packages = source.slice(
        source.indexOf("container_install_packages() {"),
        source.indexOf("container_select_image() {"),
      );
      const script =
        packages +
        `
remove_caddy_apt_source() { rm -f "$FIXTURE/keyring" "$FIXTURE/source.list"; }
install_caddy_release() { apt_install caddy; }
snapshot_caddy_state() { echo snapshot >> "$FIXTURE/events"; CADDY_SNAPSHOT_ARMED=1; }
restore_caddy_state() { [[ -z $CADDY_SNAPSHOT_ARMED ]] || echo restore >> "$FIXTURE/events"; CADDY_SNAPSHOT_ARMED=""; }
apt_get() { echo "apt $*" >> "$FIXTURE/events"; }
apt_install() { echo "packages $*" >> "$FIXTURE/events"; [[ ! -e "$FIXTURE/fail-apt" ]]; }
curl() { echo repository; }
gpg() { cat >"\${@: -1}"; }
container_install_packages
`;
      expect((await run(dir, script)).code).toBe(0);
      expect(events(dir)).toContain(
        "packages ca-certificates curl gnupg git python3 jq openssl ufw unattended-upgrades",
      );
      expect(events(dir)).toContain("packages caddy");
      expect(events(dir)).not.toMatch(
        /nodejs|polkitd|build-essential|docker.io|docker-compose-v2/,
      );
      expect(events(dir).match(/restore/g)?.length).toBe(1);
      writeFileSync(join(dir, "events"), "");
      const fresh = script.replace(
        /container_install_packages\n$/,
        `
command() {
  if [[ $1 == -v && $2 == docker ]]; then return 1; fi
  builtin command "$@"
}
container_install_packages
`,
      );
      expect((await run(dir, fresh)).code).toBe(0);
      expect(events(dir)).toContain("packages docker.io docker-compose-v2");
      writeFileSync(join(dir, "fail-apt"), "");
      writeFileSync(join(dir, "events"), "");
      expect((await run(dir, script)).code).not.toBe(0);
      expect(events(dir)).toContain("restore");
    },
    INSTALL_CASE_TIMEOUT_MS,
  );

  it(
    "removes retired Caddy metadata before apt, including repair",
    async () => {
      const dir = fixture();
      const packages = source.slice(
        source.indexOf("container_install_packages() {"),
        source.indexOf("container_select_image() {"),
      );
      const script =
        packages +
        `
remove_caddy_apt_source() { rm -f "$FIXTURE/keyring" "$FIXTURE/source.list"; }
install_caddy_release() { apt_install caddy; }
snapshot_caddy_state() { :; }
restore_caddy_state() { :; }
apt_install() { :; }
curl() { echo repository; }
gpg() { cat >"\${@: -1}"; }
apt_get() {
  [[ ! -e "$FIXTURE/keyring" && ! -e "$FIXTURE/source.list" ]]
}
umask 077
container_install_packages
`;
      expect((await run(dir, script)).code).toBe(0);
      for (const name of ["keyring", "source.list"]) {
        expect(existsSync(join(dir, name))).toBe(false);
        writeFileSync(join(dir, name), "retired", { mode: 0o600 });
      }
      expect((await run(dir, script)).code).toBe(0);
    },
    INSTALL_CASE_TIMEOUT_MS,
  );

  // Needs the real Docker CLI; a box without it reports the case as skipped.
  const docker = Bun.which("docker");
  it.skipIf(!docker)(
    "renders a Compose contract the installed CLI accepts",
    async () => {
      const dir = fixture();
      expect((await run(dir, "container_main")).code).toBe(0);
      const compose = Bun.spawn(
        [
          docker!,
          "compose",
          "--env-file",
          "office.env",
          "-f",
          "compose.yaml",
          "config",
          "--format",
          "json",
        ],
        {
          cwd: join(dir, "config"),
          env: { PATH: process.env.PATH, HOME: dir },
          stdout: "pipe",
          timeout: INSTALL_PROCESS_TIMEOUT_MS,
        },
      );
      const [stdout, code] = await Promise.all([
        new Response(compose.stdout).text(),
        compose.exited,
      ]);
      expect(code).toBe(0);
      const service = JSON.parse(stdout).services.office;
      expect(service.image).toBe(digest);
      expect(service.ports[0].host_ip).toBe("127.0.0.1");
      expect(service.ports[0].published).toBe("10000");
      expect(service.restart).toBe("no");
      expect(service.volumes[0].source).toBe("/srv/isomux-data");
      expect(service.volumes[0].target).toBe("/var/data");
      expect(service.volumes[0].bind.create_host_path ?? false).toBe(false);
      expect(
        service.volumes
          .slice(1)
          .map(
            (volume: {
              source: string;
              target: string;
              read_only: boolean;
            }) => [volume.source, volume.target, volume.read_only],
          ),
      ).toEqual([
        ["/run/isomux-update", "/run/isomux-update", true],
        [
          "/opt/isomux-container/client-update.conf",
          "/etc/isomux/update.conf",
          true,
        ],
      ]);
      expect(
        service.volumes.some((volume: { source: string }) =>
          volume.source.includes("docker.sock"),
        ),
      ).toBe(false);
      expect(service.security_opt).toEqual(["seccomp=./seccomp/chromium.json"]);
      expect(service.privileged ?? false).toBe(false);
    },
    INSTALL_CASE_TIMEOUT_MS,
  );

  it(
    "refuses an image from another source revision",
    async () => {
      const dir = fixture();
      writeFileSync(join(dir, "revision"), "b".repeat(40));
      expect((await run(dir, "container_main")).code).not.toBe(0);
      expect(events(dir)).not.toContain("restart isomux-container");
      expect(existsSync(join(dir, "config"))).toBe(false);
    },
    INSTALL_CASE_TIMEOUT_MS,
  );

  it(
    "refuses an old existing engine or missing Compose before package mutation",
    async () => {
      const dir = fixture();
      for (const [version, composeCode] of [
        ["27.5.1", 0],
        ["29.1.3", 1],
      ]) {
        writeFileSync(join(dir, "events"), "");
        const result = await run(
          dir,
          `docker() { if [[ $1 == version ]]; then echo ${version}; elif [[ $1 == compose ]]; then return ${composeCode}; fi; }; container_main`,
        );
        expect(result.code).not.toBe(0);
        expect(events(dir)).not.toContain("packages");
        expect(existsSync(join(dir, "config"))).toBe(false);
      }
    },
    INSTALL_CASE_TIMEOUT_MS,
  );
});

it.concurrent(
  "updater finalization preserves the installer rerun record contract",
  async () => {
    const dir = fixture();
    expect((await run(dir, "container_main")).code).toBe(0);
    const updater = readFileSync(
      new URL("../scripts/update.sh", import.meta.url),
      "utf8",
    );
    const start = updater.indexOf("container_finalize() {");
    const end = updater.indexOf("# --- Main", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const finalize = updater.slice(start, end);
    const result = await run(
      dir,
      finalize +
        `
CONTAINER_STAGE="$FIXTURE/next"
container_assets "$CONTAINER_STAGE"
cp "$CONTAINER_DIR/installer.sha256" "$CONTAINER_STAGE/installer.sha256"
TARGET_TAG=v2099.1.2
target_commit=${"b".repeat(40)}
CONTAINER_DIGEST=${digest}
container_finalize
ISOMUX_REF=$TARGET_TAG
CONTAINER_REVISION=$target_commit
CONTAINER_UUID=fixture-uuid
container_check_saved
`,
    );
    expect(result.code).toBe(0);
    expect(statSync(join(dir, "config/office.env")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, "config/release"), "utf8").trim()).toBe(
      "v2099.1.2",
    );
    expect(readFileSync(join(dir, "config/revision"), "utf8").trim()).toBe(
      "b".repeat(40),
    );
  },
  INSTALL_CASE_TIMEOUT_MS,
);

it.concurrent(
  "other-office guard accepts its container config on retry and refuses host or ambiguous configs",
  async () => {
    const dir = fixture();
    for (const conf of [
      "DEPLOYMENT_KIND=container\nSERVICE_KIND=system\n",
      "SERVICE_KIND=system\nDEPLOYMENT_KIND=container\n",
    ]) {
      writeFileSync(join(dir, "update.conf"), conf);
      expect((await run(dir, "container_check_other_office")).code).toBe(0);
    }
    for (const conf of [
      "SERVICE_KIND=system\n",
      "DEPLOYMENT_KIND=git\n",
      "DEPLOYMENT_KIND=container\nDEPLOYMENT_KIND=git\n",
      "DEPLOYMENT_KIND=container\nDEPLOYMENT_KIND=container\n",
    ]) {
      writeFileSync(join(dir, "update.conf"), conf);
      expect((await run(dir, "container_check_other_office")).code).not.toBe(0);
    }
  },
  INSTALL_CASE_TIMEOUT_MS,
);

it.concurrent(
  "retries a first install interrupted after writing the container updater config",
  async () => {
    const dir = fixture();
    const interrupted = await run(
      dir,
      `container_start() { return 1; }; container_main`,
    );
    expect(interrupted.code).not.toBe(0);
    expect(existsSync(join(dir, "update.conf"))).toBe(true);
    expect(existsSync(join(dir, "config"))).toBe(false);
    expect((await run(dir, "container_main")).code).toBe(0);
  },
  INSTALL_CASE_TIMEOUT_MS,
);
