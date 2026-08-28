import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
const roots: string[] = [];

function run(options: {
  kind?: "hosted" | "self-hosted";
  mutate?: (text: string) => string;
  transactionFails?: boolean;
  caddyAfterFailure?: "active" | "inactive";
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
});
