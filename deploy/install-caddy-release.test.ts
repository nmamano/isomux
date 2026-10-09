import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const source = readFileSync(new URL("./install.sh", import.meta.url), "utf8");
const filterStart = source.indexOf("drop_output_lines() {");
const filter = source.slice(
  filterStart,
  source.indexOf("\n}\n", filterStart) + 3,
);
const helpers = source.slice(
  source.indexOf("CADDY_VERSION="),
  source.indexOf("install_packages() {"),
);

function exercise(arch = "amd64", checksum = "valid", installed = "") {
  const dir = mkdtempSync(join(tmpdir(), "caddy-release-"));
  try {
    const script = `
set -Eeuo pipefail
${helpers}
${filter}
die() { echo "$*" >&2; exit 1; }
dpkg-query() { printf '%s' "$INSTALLED"; }
dpkg() {
  if [[ $1 == --print-architecture ]]; then echo "$ARCH"; else command dpkg "$@"; fi
}
curl() {
  echo "$2" >> "$FIXTURE/downloads"
  if [[ $2 == *.deb ]]; then printf package > "$4"; return; fi
  asset="caddy_\${CADDY_VERSION}_linux_\${ARCH}.deb"
  hash=$(printf package | sha512sum | cut -d ' ' -f 1)
  case $CHECKSUM in
    valid) printf '%s  %s\\n' "$hash" "$asset" ;;
    wrong) printf '%0128d  %s\\n' 0 "$asset" ;;
    missing) printf '%s  other.deb\\n' "$hash" ;;
    duplicate) printf '%s  %s\\n%s  %s\\n' "$hash" "$asset" "$hash" "$asset" ;;
    malformed) printf 'bad  %s\\n' "$asset" ;;
    download-fails) return 22 ;;
  esac > "$4"
}
apt_install() { test -f "$1"; cat "$1" > "$FIXTURE/installed"; }
drop_output_lines "^ignored$" install_caddy_release
`;
    writeFileSync(join(dir, "run.sh"), script);
    const result = Bun.spawnSync(["bash", join(dir, "run.sh")], {
      env: {
        ...process.env,
        FIXTURE: dir,
        ARCH: arch,
        CHECKSUM: checksum,
        INSTALLED: installed,
      },
    });
    const read = (name: string) => {
      try {
        return readFileSync(join(dir, name), "utf8");
      } catch {
        return "";
      }
    };
    return {
      code: result.exitCode,
      installed: read("installed"),
      downloads: read("downloads"),
      error: result.stderr.toString(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("pinned Caddy release", () => {
  for (const arch of ["amd64", "arm64"]) {
    it(`verifies and installs the ${arch} package`, () => {
      const result = exercise(arch);
      expect(result.code, result.error).toBe(0);
      expect(result.installed).toBe("package");
      expect(result.downloads).toContain(`_linux_${arch}.deb`);
      expect(result.downloads).toContain("_checksums.txt");
    });
  }

  for (const checksum of [
    "wrong",
    "missing",
    "duplicate",
    "malformed",
    "download-fails",
  ]) {
    it(`refuses a ${checksum} checksum before package installation`, () => {
      const result = exercise("amd64", checksum);
      expect(result.code).not.toBe(0);
      expect(result.installed).toBe("");
    });
  }

  it("rejects unsupported architectures before downloading", () => {
    const result = exercise("i386");
    expect(result.code).not.toBe(0);
    expect(result.downloads).toBe("");
    expect(result.installed).toBe("");
  });

  it("leaves equal and newer installed packages untouched", () => {
    const version = source.match(/^CADDY_VERSION=(.+)$/m)![1]!;
    for (const installed of [version, "99.0.0"]) {
      const result = exercise(
        "amd64",
        "valid",
        `install ok installed ${installed}`,
      );
      expect(result.code, result.error).toBe(0);
      expect(result.downloads).toBe("");
      expect(result.installed).toBe("");
    }
    expect(
      exercise("amd64", "valid", "install ok installed 2.0.0").installed,
    ).toBe("package");
    expect(
      exercise("amd64", "valid", `deinstall ok config-files ${version}`)
        .installed,
    ).toBe("package");
  });

  it("removes only the old repository files without service or package commands", () => {
    const cleanup = helpers.slice(
      helpers.indexOf("remove_caddy_apt_source()"),
      helpers.indexOf("install_caddy_release()"),
    );
    const result = Bun.spawnSync([
      "bash",
      "-c",
      `
set -Eeuo pipefail
${cleanup}
run() { printf '%s\\n' "$@"; }
remove_caddy_apt_source
`,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim().split("\n")).toEqual([
      "rm",
      "-f",
      "/etc/apt/sources.list.d/caddy-stable.list",
      "/usr/share/keyrings/caddy-stable-archive-keyring.gpg",
    ]);
    for (const name of ["install_packages", "container_install_packages"]) {
      const start = source.indexOf(`${name}() {`);
      const body = source.slice(start, source.indexOf("\n}\n", start));
      expect(body.indexOf("remove_caddy_apt_source")).toBeGreaterThan(-1);
      expect(body.indexOf("remove_caddy_apt_source")).toBeLessThan(
        body.indexOf("apt_get update"),
      );
      expect(body).toContain("install_caddy_release");
    }
  });
});
