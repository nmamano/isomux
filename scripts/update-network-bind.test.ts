import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const INSTALL = readFileSync(
  new URL("../deploy/install.sh", import.meta.url),
  "utf8",
);
const START = INSTALL.indexOf("write_loopback_bind_if_proxied() {");
const END = INSTALL.indexOf("\nconfigure_caddy() {");
if (START < 0 || END < START)
  throw new Error("install.sh no longer has write_loopback_bind_if_proxied");
const FUNCTION = INSTALL.slice(START, END);
const RUN_START = INSTALL.indexOf("\nrun() {\n");
if (RUN_START < 0) throw new Error("install.sh no longer has run()");
const RUN = INSTALL.slice(RUN_START, INSTALL.indexOf("\n}\n", RUN_START) + 3);
// The installer's own default for the flag, if it declares one; the harness
// runs under set -u, as the installer does.
const FLAG_DEFAULT = INSTALL.match(/^PROXY_SETTINGS_WRITTEN=.*$/m)?.[0] ?? "";
const roots: string[] = [];

function run(options: {
  caddyState?: "active" | "inactive";
  proxyLine?: string;
  config?: Record<string, unknown> | null;
  rawConfig?: string;
  mode?: number;
  twice?: boolean;
  apply?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), "isomux-network-bind-"));
  roots.push(root);
  const bin = join(root, "bin");
  const serviceHome = join(root, "service-home");
  const state = join(serviceHome, ".isomux");
  Bun.spawnSync(["mkdir", "-p", bin, state]);
  writeFileSync(
    join(bin, "systemctl"),
    `#!/usr/bin/env bash
if [[ $* == 'restart isomux' ]]; then echo restart >>"$CALLS"; exit 0; fi
[[ $* == 'is-active --quiet caddy' ]] || exit 90
[[ $CADDY_STATE == active ]]
`,
  );
  chmodSync(join(bin, "systemctl"), 0o755);
  const caddyfile = join(root, "Caddyfile");
  writeFileSync(
    caddyfile,
    `office.example {\n\t${options.proxyLine ?? "reverse_proxy 127.0.0.1:4000"}\n}\n`,
  );
  const config = join(state, "office-config.json");
  const firstContent = join(root, "first-content");
  const firstStat = join(root, "first-stat");
  const calls = join(root, "calls");
  writeFileSync(calls, "");
  if (options.config !== null) {
    writeFileSync(
      config,
      options.rawConfig ?? JSON.stringify(options.config ?? { sibling: 7 }),
    );
    chmodSync(config, options.mode ?? 0o640);
  }
  const before = options.config !== null ? statSync(config) : null;
  const user = process.env.USER!;
  const script = `set -Eeuo pipefail
${FLAG_DEFAULT}
${FUNCTION}
${RUN}
log() { :; }
step() { :; }
run_as_service_user() { "$@"; }
wait_for_server() { echo wait >>"$CALLS"; }
SERVICE_USER=${JSON.stringify(user)}
SERVICE_HOME=${JSON.stringify(serviceHome)}
CADDYFILE=${JSON.stringify(caddyfile)}
BASE_URL=http://127.0.0.1:4000
DRY_RUN=""
write_loopback_bind_if_proxied
${
  options.twice
    ? `cp ${JSON.stringify(config)} ${JSON.stringify(firstContent)}
stat -c '%i:%u:%g:%a:%s:%Y' ${JSON.stringify(config)} > ${JSON.stringify(firstStat)}
write_loopback_bind_if_proxied`
    : ""
}
${options.apply ? "apply_proxy_settings" : ""}
`;
  const result = Bun.spawnSync(["bash", "-c", script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CADDY_STATE: options.caddyState ?? "active",
      CALLS: calls,
    },
  });
  const after = statSync(config, { throwIfNoEntry: false });
  // A missing function exits 127 and leaves the config as it was.
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return {
    code: result.exitCode,
    out: `${result.stdout.toString()}${result.stderr.toString()}`,
    calls: readFileSync(calls, "utf8").split("\n").filter(Boolean),
    before,
    after,
    contents: after ? readFileSync(config, "utf8") : null,
    firstContents: options.twice ? readFileSync(firstContent, "utf8") : null,
    firstStat: options.twice ? readFileSync(firstStat, "utf8").trim() : null,
    finalStat: after
      ? `${after.ino}:${after.uid}:${after.gid}:${(after.mode & 0o777).toString(8)}:${after.size}:${Math.floor(after.mtimeMs / 1000)}`
      : null,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("deps-only networkBind and trustedProxy convergence", () => {
  it("adds loopback and same-host once and preserves siblings, owner, group, and mode", () => {
    const result = run({ config: { sibling: 7 }, mode: 0o640, twice: true });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.contents!)).toEqual({
      sibling: 7,
      networkBind: "loopback",
      trustedProxy: "same-host",
    });
    expect(result.after!.uid).toBe(result.before!.uid);
    expect(result.after!.gid).toBe(result.before!.gid);
    expect(result.after!.mode & 0o777).toBe(0o640);
    expect(result.contents).toBe(result.firstContents);
    expect(result.finalStat).toBe(result.firstStat);
  });

  it("preserves every explicit networkBind value and adds the missing trustedProxy", () => {
    for (const value of ["auto", "loopback", "all"]) {
      const result = run({ config: { networkBind: value, sibling: true } });
      expect(JSON.parse(result.contents!)).toEqual({
        networkBind: value,
        sibling: true,
        trustedProxy: "same-host",
      });
    }
  });

  it("preserves every explicit trustedProxy value and adds the missing networkBind", () => {
    for (const value of ["none", "same-host", "load-balancer"]) {
      const result = run({ config: { trustedProxy: value, sibling: true } });
      expect(JSON.parse(result.contents!)).toEqual({
        trustedProxy: value,
        sibling: true,
        networkBind: "loopback",
      });
    }
  });

  it("leaves a config with both keys untouched", () => {
    const config = { networkBind: "all", trustedProxy: "none", sibling: 7 };
    const result = run({ config });
    expect(JSON.parse(result.contents!)).toEqual(config);
    expect(result.after!.ino).toBe(result.before!.ino);
    expect(result.after!.mtimeMs).toBe(result.before!.mtimeMs);
  });

  it("creates a missing config for the service user", () => {
    const result = run({ config: null });
    expect(JSON.parse(result.contents!)).toEqual({
      networkBind: "loopback",
      trustedProxy: "same-host",
    });
    expect(result.after!.uid).toBe(process.getuid!());
    expect(result.after!.gid).toBe(process.getgid!());
    expect(result.after!.mode & 0o777).toBe(0o644);
  });

  it("leaves the key absent when the caddy unit is inactive", () => {
    // Outage mutant: the systemctl stub returns the verbatim state `inactive`
    // while the Caddyfile still says `reverse_proxy 127.0.0.1:4000`.
    const result = run({ caddyState: "inactive", config: { sibling: 7 } });
    expect(JSON.parse(result.contents!)).toEqual({ sibling: 7 });
    expect(result.after!.mode & 0o777).toBe(result.before!.mode & 0o777);
  });

  it("leaves the key absent when caddy proxies another port", () => {
    const result = run({
      proxyLine: "reverse_proxy 127.0.0.1:4001",
      config: { sibling: 7 },
    });
    expect(JSON.parse(result.contents!)).toEqual({ sibling: 7 });
  });
});

// A full install writes the settings after its last office restart, and the
// server reads them only at boot (task 1ae5b2ba).
describe("full install: apply_proxy_settings", () => {
  it("restarts the office once and waits for it after a write", () => {
    const configs = [
      null,
      { sibling: 7 },
      { networkBind: "all" },
      { trustedProxy: "none" },
    ];
    for (const config of configs) {
      const result = run({ config, apply: true });
      // The merge replaced the file: this run wrote.
      expect(result.after!.ino).not.toBe(result.before?.ino);
      expect({ config, calls: result.calls }).toEqual({
        config,
        calls: ["restart", "wait"],
      });
    }
  });

  it("restarts nothing when the merge writes nothing", () => {
    const cases = [
      { config: { networkBind: "all", trustedProxy: "none" } },
      { caddyState: "inactive" as const },
      { proxyLine: "reverse_proxy 127.0.0.1:4001" },
      { config: {}, rawConfig: "[1]" },
    ];
    for (const options of cases) {
      const result = run({ ...options, apply: true });
      expect(result.after!.ino).toBe(result.before!.ino);
      expect({ options, calls: result.calls }).toEqual({ options, calls: [] });
    }
  });
});
