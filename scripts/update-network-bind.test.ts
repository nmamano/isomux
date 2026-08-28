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
const FUNCTION = INSTALL.slice(
  INSTALL.indexOf("write_loopback_bind_if_proxied() {"),
  INSTALL.indexOf("\nconfigure_caddy() {"),
);
const roots: string[] = [];

function run(options: {
  caddyState?: "active" | "inactive";
  proxyLine?: string;
  config?: Record<string, unknown> | null;
  mode?: number;
  twice?: boolean;
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
  if (options.config !== null) {
    writeFileSync(config, JSON.stringify(options.config ?? { sibling: 7 }));
    chmodSync(config, options.mode ?? 0o640);
  }
  const before = options.config !== null ? statSync(config) : null;
  const user = process.env.USER!;
  const script = `${FUNCTION}
log() { :; }
run_as_service_user() { "$@"; }
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
`;
  const result = Bun.spawnSync(["bash", "-c", script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CADDY_STATE: options.caddyState ?? "active",
    },
  });
  const after = statSync(config, { throwIfNoEntry: false });
  return {
    code: result.exitCode,
    out: `${result.stdout.toString()}${result.stderr.toString()}`,
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

describe("deps-only networkBind convergence", () => {
  it("adds loopback once and preserves siblings, owner, group, and mode", () => {
    const result = run({ config: { sibling: 7 }, mode: 0o640, twice: true });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.contents!)).toEqual({
      sibling: 7,
      networkBind: "loopback",
    });
    expect(result.after!.uid).toBe(result.before!.uid);
    expect(result.after!.gid).toBe(result.before!.gid);
    expect(result.after!.mode & 0o777).toBe(0o640);
    expect(result.contents).toBe(result.firstContents);
    expect(result.finalStat).toBe(result.firstStat);
  });

  it("preserves every explicit networkBind value", () => {
    for (const value of ["auto", "loopback", "all"]) {
      const result = run({ config: { networkBind: value, sibling: true } });
      expect(JSON.parse(result.contents!)).toEqual({
        networkBind: value,
        sibling: true,
      });
    }
  });

  it("creates a missing config for the service user", () => {
    const result = run({ config: null });
    expect(JSON.parse(result.contents!)).toEqual({ networkBind: "loopback" });
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
