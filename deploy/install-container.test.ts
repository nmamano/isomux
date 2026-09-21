import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserRecord } from "../shared/types.ts";

const source = readFileSync(new URL("./install.sh", import.meta.url), "utf8");
const definitions = source.slice(0, source.lastIndexOf('\nmain "$@"'));
const fixtures: string[] = [];
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
  writeFileSync(
    join(dir, "bin", "mountpoint"),
    '#!/bin/bash\n[[ ! -e "$FIXTURE/missing-mount" ]]\n',
  );
  writeFileSync(
    join(dir, "bin", "findmnt"),
    '#!/bin/bash\ncase "${*: -1}" in UUID) cat "$FIXTURE/uuid";; OPTIONS) cat "$FIXTURE/options";; esac\n',
  );
  chmodSync(join(dir, "bin", "mountpoint"), 0o755);
  chmodSync(join(dir, "bin", "findmnt"), 0o755);
  writeFileSync(join(dir, "uuid"), "fixture-uuid\n");
  writeFileSync(join(dir, "options"), "rw,relatime\n");
  return dir;
}

function run(dir: string, script: string, alternate = definitions) {
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
  if [[ "$*" == *api.github.com* ]]; then printf '{"sha":"%040d"}\\n' 1;
  elif [[ "$*" == *raw.githubusercontent.com* ]]; then cp "$FIXTURE/installer" "\${@: -1}";
  else printf 200; fi
}
dpkg-query() { [[ ! -e "$FIXTURE/default-caddy" ]] || printf '/etc/caddy/Caddyfile %s\\n' "$(md5sum "$FIXTURE/default-caddy" | cut -d ' ' -f 1)"; }
container_require_root() { :; }
preflight() { printf 'preflight\\n' >> "$FIXTURE/events"; }
container_install_packages() { printf 'packages\\n' >> "$FIXTURE/events"; }
configure_firewall() { printf 'firewall\\n' >> "$FIXTURE/events"; }
enable_auto_updates() { printf 'security-updates\\n' >> "$FIXTURE/events"; }
caddy() { printf 'caddy %s\\n' "$*" >> "$FIXTURE/events"; }
install_caddyfile_transaction() { cp "$1" "$CADDYFILE"; }
`;
  const harness = join(dir, "harness.sh");
  writeFileSync(harness, alternate + prefix + script);
  const result = Bun.spawnSync(["bash", harness], {
    env: { PATH: `${dir}/bin:${process.env.PATH}`, FIXTURE: dir, HOME: dir },
    timeout: 10000,
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}

function events(dir: string) {
  const path = join(dir, "events");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

afterEach(() => {
  for (const dir of fixtures.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("container installer", () => {
  it("keeps the direct-host default and dependency-only dispatch", () => {
    const dir = fixture();
    const calls = [
      "preflight",
      "sync_install_kind",
      "install_packages",
      "configure_firewall",
      "harden_ssh",
      "enable_auto_updates",
      "configure_oom_protection",
      "create_service_user",
      "install_claude_cli",
      "configure_user_manager",
      "check_root_reachability",
      "install_browser",
      "configure_codex_sandbox",
      "fetch_isomux",
      "install_bun",
      "build_isomux",
      "install_updater",
      "install_service",
      "wait_for_server",
      "assert_hardening",
      "claim_owner",
      "configure_public_access",
      "mint_invite",
      "configure_caddy",
      "write_loopback_bind_if_proxied",
      "report",
    ];
    const stubs = [...calls, "deps_only", "container_main"]
      .map((name) => `${name}() { echo ${name}; }`)
      .join("\n");
    const normal = run(dir, stubs + "\nmain");
    expect(normal.code).toBe(0);
    expect(normal.out.trim().split("\n")).toEqual(calls);
    expect(run(dir, stubs + "\nISOMUX_DEPS_ONLY=1; main").out.trim()).toBe(
      "deps_only",
    );
    expect(
      run(dir, stubs + "\nISOMUX_INSTALL_MODE=container; main").out.trim(),
    ).toBe("container_main");
    expect(
      run(dir, stubs + "\nISOMUX_INSTALL_MODE=invalid; main").code,
    ).not.toBe(0);
  });

  it("installs once, records identity and repairs with the same secret and digest", () => {
    const dir = fixture();
    const first = run(dir, "container_main");
    expect(first).toEqual({ code: 0, out: expect.any(String), err: "" });
    const env = readFileSync(join(dir, "config/office.env"), "utf8");
    const key = env.match(/ISOMUX_SETUP_KEY=(.+)/)![1];
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(first.out + first.err + events(dir)).not.toContain(key);
    expect(env).toContain(`ISOMUX_IMAGE=${digest}`);
    expect(readFileSync(join(dir, "config/mount.uuid"), "utf8")).toBe(
      "fixture-uuid\n",
    );
    const second = run(dir, "container_main");
    expect(second.code).toBe(0);
    expect(readFileSync(join(dir, "config/office.env"), "utf8")).toBe(env);
    expect(events(dir)).toContain(`docker pull ${digest}`);
    const config = readFileSync(join(dir, "Caddyfile"), "utf8");
    expect(config).toContain("127.0.0.1:10000");
    expect(config).not.toContain("127.0.0.1:4000");
    expect(config).toContain("admin off");
    expect(config).toContain("respond /__isomux/tls-ask 404");
    expect(config).toContain("on_demand_tls");
    expect(config).toContain("isomux-office-access.log");
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
  });

  it("preserves an absent setup key only with a confirmed owner", () => {
    const dir = fixture();
    expect(run(dir, "container_main").code).toBe(0);
    const path = join(dir, "config/office.env");
    const env = readFileSync(path, "utf8").replace(
      /^ISOMUX_SETUP_KEY=.*\n/m,
      "",
    );
    writeFileSync(path, env);
    expect(run(dir, "container_main").code).not.toBe(0);
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
          order: [],
          avatarColor: "#112233",
          avatarVariant: "classic",
          memberPrompt: null,
          language: null,
        },
      } satisfies Record<string, UserRecord>),
    );
    expect(run(dir, "container_main").code).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(env);
  });

  it("rejects a changed tag digest before restarting the office", () => {
    const dir = fixture();
    expect(run(dir, "container_main").code).toBe(0);
    writeFileSync(join(dir, "events"), "");
    writeFileSync(
      join(dir, "digest"),
      `ghcr.io/nmamano/isomux@sha256:${"b".repeat(64)}`,
    );
    expect(run(dir, "container_main").code).not.toBe(0);
    expect(events(dir)).not.toContain("restart isomux-container");
    expect(readFileSync(join(dir, "config/image"), "utf8").trim()).toBe(digest);
  });

  it("recovers from service failure without replacing the setup key", () => {
    const dir = fixture();
    writeFileSync(join(dir, "fail-start"), "");
    expect(run(dir, "container_main").code).not.toBe(0);
    const env = readFileSync(join(dir, "config/office.env"), "utf8");
    rmSync(join(dir, "fail-start"));
    expect(run(dir, "container_main").code).toBe(0);
    expect(readFileSync(join(dir, "config/office.env"), "utf8")).toBe(env);
  });

  for (const condition of [
    "missing-mount",
    "read-only",
    "host-office",
    "custom-caddy",
    "wrong-installer",
    "pull-failure",
  ]) {
    it(`refuses ${condition} without replacing a proxy or starting an office`, () => {
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
      expect(run(dir, extra + "container_main").code).not.toBe(0);
      expect(events(dir)).not.toContain("restart isomux-container");
      if (condition !== "pull-failure")
        expect(events(dir)).not.toContain("packages");
      expect(existsSync(join(dir, "config"))).toBe(false);
    });
  }

  it("accepts the package default but refuses a modified managed Caddyfile", () => {
    const dir = fixture();
    writeFileSync(join(dir, "Caddyfile"), ":80 { respond default }\n");
    writeFileSync(
      join(dir, "default-caddy"),
      readFileSync(join(dir, "Caddyfile")),
    );
    expect(run(dir, "container_main").code).toBe(0);
    writeFileSync(
      join(dir, "Caddyfile"),
      "# Managed by the isomux installer\nother.example.com { respond private }\n",
    );
    writeFileSync(join(dir, "events"), "");
    expect(run(dir, "container_main").code).not.toBe(0);
    expect(events(dir)).not.toContain("packages");
  });

  it("refuses a different mount UUID on repair and on unit startup", () => {
    const dir = fixture();
    expect(run(dir, "container_main").code).toBe(0);
    writeFileSync(join(dir, "uuid"), "other-disk\n");
    writeFileSync(join(dir, "events"), "");
    expect(run(dir, "container_main").code).not.toBe(0);
    expect(events(dir)).not.toContain("packages");
    expect(
      run(
        dir,
        '"$CONTAINER_DIR/mount-check.sh" "$CONTAINER_DATA" "$CONTAINER_DIR/mount.uuid"',
      ).code,
    ).not.toBe(0);
  });

  it("does not evaluate shell syntax or expose secrets from saved settings", () => {
    const dir = fixture();
    expect(run(dir, "container_main").code).toBe(0);
    writeFileSync(
      join(dir, "config/office.env"),
      `ISOMUX_SETUP_KEY=$(touch ${dir}/executed)\n`,
    );
    const result = run(dir, "container_main");
    expect(result.code).not.toBe(0);
    expect(existsSync(join(dir, "executed"))).toBe(false);
    expect(result.out + result.err).not.toContain("$(touch");
  });

  it("refuses a conflicting data writer or Compose project", () => {
    const dir = fixture();
    writeFileSync(join(dir, "containers"), "other\n");
    writeFileSync(
      join(dir, "container.json"),
      JSON.stringify([
        { Mounts: [{ Source: join(dir, "data") }], Config: { Labels: {} } },
      ]),
    );
    expect(run(dir, "container_main").code).not.toBe(0);
    expect(events(dir)).not.toContain("restart isomux-container");
  });
  it("requires Docker 28 or later", () => {
    const dir = fixture();
    for (const version of ["27.5.1", "28.0.0", "29.1.3", "invalid"]) {
      const result = run(
        dir,
        `docker() { [[ $1 != version ]] || echo ${version}; }; container_check_docker_version`,
      );
      expect(result.code === 0).toBe(
        version === "28.0.0" || version === "29.1.3",
      );
    }
  });

  it("repairs a recorded installation interrupted before the unit was written", () => {
    const dir = fixture();
    const result = run(dir, "install() { return 1; }; container_main");
    expect(result.code).not.toBe(0);
    expect(existsSync(join(dir, "config/release"))).toBe(true);
    expect(existsSync(join(dir, "unit"))).toBe(false);
    const env = readFileSync(join(dir, "config/office.env"), "utf8");
    expect(run(dir, "container_main").code).toBe(0);
    expect(readFileSync(join(dir, "config/office.env"), "utf8")).toBe(env);
  });

  it("checks the mount before every service start", () => {
    const dir = fixture();
    expect(run(dir, "container_main").code).toBe(0);
    const check =
      '"$CONTAINER_DIR/mount-check.sh" "$CONTAINER_DATA" "$CONTAINER_DIR/mount.uuid"';
    expect(run(dir, check).code).toBe(0);
    writeFileSync(join(dir, "options"), "ro,relatime\n");
    expect(run(dir, check).code).not.toBe(0);
    writeFileSync(join(dir, "options"), "rw,relatime\n");
    writeFileSync(join(dir, "missing-mount"), "");
    expect(run(dir, check).code).not.toBe(0);
  });

  it("serializes installers before package or service mutation", () => {
    const dir = fixture();
    expect(
      run(dir, 'exec 8>"$CONTAINER_LOCK"; flock -n 8; container_main').code,
    ).not.toBe(0);
    expect(events(dir)).toBe("");
  });

  it("refuses damaged or changed private records before package changes", () => {
    const dir = fixture();
    expect(run(dir, "container_main").code).toBe(0);
    for (const change of [
      "DOMAIN=other.example.com",
      "ISOMUX_REF=v2026.9.22",
    ]) {
      writeFileSync(join(dir, "events"), "");
      expect(run(dir, change + "; container_main").code).not.toBe(0);
      expect(events(dir)).not.toContain("packages");
    }
    writeFileSync(join(dir, "config/compose.yaml"), "custom configuration");
    writeFileSync(join(dir, "events"), "");
    expect(run(dir, "container_main").code).not.toBe(0);
    expect(events(dir)).not.toContain("packages");
  });

  it("installs only host infrastructure packages and restores Caddy on failure", () => {
    const dir = fixture();
    const packages = source.slice(
      source.indexOf("container_install_packages() {"),
      source.indexOf("container_select_image() {"),
    );
    const script =
      packages +
      `
CONTAINER_KEYRING="$FIXTURE/keyring"
CONTAINER_APT_SOURCE="$FIXTURE/source.list"
snapshot_caddy_state() { echo snapshot >> "$FIXTURE/events"; CADDY_SNAPSHOT_ARMED=1; }
restore_caddy_state() { [[ -z $CADDY_SNAPSHOT_ARMED ]] || echo restore >> "$FIXTURE/events"; CADDY_SNAPSHOT_ARMED=""; }
apt_get() { echo "apt $*" >> "$FIXTURE/events"; }
apt_install() { echo "packages $*" >> "$FIXTURE/events"; [[ ! -e "$FIXTURE/fail-apt" ]]; }
curl() { echo repository; }
gpg() { cat >/dev/null; }
container_install_packages
`;
    expect(run(dir, script).code).toBe(0);
    expect(events(dir)).toContain(
      "packages ca-certificates curl gnupg jq openssl ufw unattended-upgrades",
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
    expect(run(dir, fresh).code).toBe(0);
    expect(events(dir)).toContain("packages docker.io docker-compose-v2");
    writeFileSync(join(dir, "fail-apt"), "");
    writeFileSync(join(dir, "events"), "");
    expect(run(dir, script).code).not.toBe(0);
    expect(events(dir)).toContain("restore");
  });

  it("renders a Compose contract the installed CLI accepts", () => {
    const dir = fixture();
    expect(run(dir, "container_main").code).toBe(0);
    const docker = Bun.which("docker");
    if (!docker) return;
    const result = Bun.spawnSync(
      [
        docker,
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
      },
    );
    expect(result.exitCode).toBe(0);
    const service = JSON.parse(result.stdout.toString()).services.office;
    expect(service.image).toBe(digest);
    expect(service.ports[0].host_ip).toBe("127.0.0.1");
    expect(service.ports[0].published).toBe("10000");
    expect(service.restart).toBe("no");
    expect(service.volumes[0].source).toBe("/srv/isomux-data");
    expect(service.volumes[0].target).toBe("/var/data");
    expect(service.volumes[0].bind.create_host_path ?? false).toBe(false);
    expect(service.security_opt).toEqual(["seccomp=./seccomp/chromium.json"]);
    expect(service.privileged ?? false).toBe(false);
  });

  it("refuses an image from another source revision", () => {
    const dir = fixture();
    writeFileSync(join(dir, "revision"), "b".repeat(40));
    expect(run(dir, "container_main").code).not.toBe(0);
    expect(events(dir)).not.toContain("restart isomux-container");
    expect(existsSync(join(dir, "config"))).toBe(false);
  });

  it("refuses an old existing engine or missing Compose before package mutation", () => {
    const dir = fixture();
    for (const [version, composeCode] of [
      ["27.5.1", 0],
      ["29.1.3", 1],
    ]) {
      writeFileSync(join(dir, "events"), "");
      const result = run(
        dir,
        `docker() { if [[ $1 == version ]]; then echo ${version}; elif [[ $1 == compose ]]; then return ${composeCode}; fi; }; container_main`,
      );
      expect(result.code).not.toBe(0);
      expect(events(dir)).not.toContain("packages");
      expect(existsSync(join(dir, "config"))).toBe(false);
    }
  });
});
