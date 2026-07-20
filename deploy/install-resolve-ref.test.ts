// deploy/install.sh resolve_default_ref — the pinned-release default and its
// fail-closed policy. The function (plus is_official_repo) is extracted from
// the installer with sed and driven with a PATH-stubbed curl, so the
// transport outcomes (200/404/500/curl-fail) are exercised without a network
// or root. Real jq. Zero LLM.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const INSTALL_SH = new URL("./install.sh", import.meta.url).pathname;

let base: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "isomux-resolve-ref-test-"));
  const bin = join(base, "bin");
  mkdirSync(bin);
  // Mimics `curl -sS -w '\n%{http_code}' URL`: body, newline, status code.
  // CURL_STUB_CODE=fail simulates a transport error (non-zero exit, no
  // output), which the resolver maps to the synthetic 000.
  writeFileSync(
    join(bin, "curl"),
    `#!/usr/bin/env bash
[[ \${CURL_STUB_CODE:-} == fail ]] && exit 7
printf '%s\\n%s' "\${CURL_STUB_BODY:-}" "\${CURL_STUB_CODE:-200}"
`,
  );
  chmodSync(join(bin, "curl"), 0o755);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function resolve(env: Record<string, string>): { out: string; code: number } {
  const script = `
eval "$(sed -n '/^is_official_repo()/,/^}/p' "$INSTALL_SH")"
eval "$(sed -n '/^resolve_default_ref()/,/^}/p' "$INSTALL_SH")"
log() { echo "LOG: $*"; }
die() { echo "DIE: $*"; exit 1; }
DRY_RUN=""
resolve_default_ref
echo "REF=$ISOMUX_REF"
`;
  const r = spawnSync("bash", ["-c", script], {
    env: {
      ...process.env,
      PATH: `${join(base, "bin")}:${process.env.PATH}`,
      INSTALL_SH,
      ISOMUX_REF: "",
      ...env,
    },
    encoding: "utf8",
    timeout: 15_000,
  });
  return { out: `${r.stdout}${r.stderr}`, code: r.status ?? -1 };
}

const OFFICIAL = "https://github.com/nmamano/isomux.git";

describe("install.sh resolve_default_ref", () => {
  it("200 with a tag installs the latest release", () => {
    const r = resolve({
      ISOMUX_REPO: OFFICIAL,
      CURL_STUB_CODE: "200",
      CURL_STUB_BODY: '{"tag_name":"v2026.7.19"}',
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("REF=v2026.7.19");
  });

  it("404 on the official repo is the bootstrap case: main", () => {
    const r = resolve({ ISOMUX_REPO: OFFICIAL, CURL_STUB_CODE: "404" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("REF=main");
  });

  it("a 500 on the official repo fails closed", () => {
    const r = resolve({ ISOMUX_REPO: OFFICIAL, CURL_STUB_CODE: "500" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("DIE:");
  });

  it("a transport failure on the official repo fails closed", () => {
    const r = resolve({ ISOMUX_REPO: OFFICIAL, CURL_STUB_CODE: "fail" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("DIE:");
  });

  it("official-repo detection is normalized across URL forms", () => {
    // Same 500, spelled without .git and as ssh: still official, still
    // fail-closed.
    for (const repo of [
      "https://github.com/nmamano/isomux",
      "git@github.com:nmamano/isomux.git",
    ]) {
      const r = resolve({ ISOMUX_REPO: repo, CURL_STUB_CODE: "500" });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("DIE:");
    }
  });

  it("a fork stays lenient: lookup failure falls back to main with a warning", () => {
    const r = resolve({
      ISOMUX_REPO: "https://github.com/someone/isomux-fork.git",
      CURL_STUB_CODE: "500",
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("warning");
    expect(r.out).toContain("REF=main");
  });

  it("a non-GitHub repo goes straight to main", () => {
    const r = resolve({ ISOMUX_REPO: "https://gitlab.com/x/y.git" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("REF=main");
  });

  it("an explicit ISOMUX_REF is left untouched", () => {
    const r = resolve({ ISOMUX_REPO: OFFICIAL, ISOMUX_REF: "v2026.1.1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("REF=v2026.1.1");
  });
});
