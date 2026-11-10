// deploy/install.sh package step in a dependency sync (ISOMUX_DEPS_ONLY=1):
// apt runs only when the box lacks something the release asks for. The whole
// installer is sourced without its main, so install_packages,
// install_github_cli and apt_install are the real ones; apt-get and systemctl
// only record their calls, and dpkg/dpkg-query are the real binaries pointed
// at a fixture package database. Nothing is installed. Zero LLM.

import { afterAll, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const SOURCE = readFileSync(new URL("./install.sh", import.meta.url), "utf8");
const DEFINITIONS = SOURCE.slice(0, SOURCE.lastIndexOf('\nmain "$@"'));
const PACKAGES = (() => {
  const m = SOURCE.match(/^APT_PACKAGES=\(([^)]*)\)$/m);
  return m ? m[1].trim().split(/\s+/) : [];
})();
const CADDY_PIN = SOURCE.match(/^CADDY_VERSION=(\S+)$/m)?.[1] ?? "";
const KEYRING = "/usr/share/keyrings/githubcli-archive-keyring.gpg";
const GH_SOURCE = "/etc/apt/sources.list.d/github-cli.list";

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

interface Box {
  depsOnly: boolean;
  // Package name -> dpkg status word ("installed", "half-configured", ...).
  // Every listed package, caddy at the pin and gh are installed by default.
  packages?: Record<string, string | null>;
  caddyVersion?: string;
  // The GitHub CLI keyring and source line on the box, and the keyring the
  // download returns. By default the box holds what the installer writes,
  // and GitHub serves key-v1.
  keyringOnBox?: string | null;
  sourceOnBox?: string | null;
  keyringServed?: string;
  // Shell run after install_packages: the later steps of the same sync.
  after?: string;
}

function stub(bin: string, name: string, body: string) {
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

function statusFile(entries: [string, string, string][]) {
  return entries
    .map(
      ([pkg, status, version]) =>
        `Package: ${pkg}\nStatus: install ok ${status}\nPriority: optional\nSection: misc\nMaintainer: Fixture <fixture@example.com>\nArchitecture: amd64\nVersion: ${version}\nDescription: fixture\n`,
    )
    .join("\n");
}

function sync(box: Box) {
  const fix = mkdtempSync(join(tmpdir(), "isomux-deps-skip-"));
  fixtures.push(fix);
  const bin = join(fix, "bin");
  const admin = join(fix, "dpkg");
  for (const d of [
    bin,
    join(admin, "info"),
    join(admin, "updates"),
    join(fix, "keyrings"),
    join(fix, "sources"),
    join(fix, "etc"),
  ])
    mkdirSync(d, { recursive: true });
  const keyring = join(fix, "keyrings", "githubcli-archive-keyring.gpg");
  const source = join(fix, "sources", "github-cli.list");
  const events = join(fix, "events");
  writeFileSync(events, "");

  const installed: Record<string, string | null> = {
    ...Object.fromEntries(PACKAGES.map((p) => [p, "installed"])),
    gh: "installed",
    caddy: "installed",
    ...box.packages,
  };
  writeFileSync(
    join(admin, "status"),
    statusFile(
      Object.entries(installed).flatMap(([pkg, st]) =>
        st === null
          ? []
          : [
              [
                pkg,
                st,
                pkg === "caddy" ? (box.caddyVersion ?? CADDY_PIN) : "1.0",
              ] as [string, string, string],
            ],
      ),
    ),
  );
  writeFileSync(join(admin, "available"), "");

  const served = box.keyringServed ?? "key-v1";
  const ownSource = `deb [arch=amd64 signed-by=${keyring}] https://cli.github.com/packages stable main\n`;
  const keyOnBox = box.keyringOnBox === undefined ? "key-v1" : box.keyringOnBox;
  const srcOnBox = box.sourceOnBox === undefined ? ownSource : box.sourceOnBox;
  if (keyOnBox !== null) writeFileSync(keyring, keyOnBox);
  if (srcOnBox !== null) writeFileSync(source, srcOnBox);
  writeFileSync(join(fix, "served-key"), served);

  stub(bin, "apt-get", `printf 'apt-get %s\\n' "$*" >> "$FIX/events"`);
  stub(bin, "systemctl", `printf 'systemctl %s\\n' "$*" >> "$FIX/events"`);
  stub(
    bin,
    "dpkg-query",
    `exec /usr/bin/dpkg-query --admindir="$FIX/dpkg" "$@"`,
  );
  stub(
    bin,
    "dpkg",
    `[[ \${1:-} != --print-architecture ]] || { echo amd64; exit 0; }
exec /usr/bin/dpkg --admindir="$FIX/dpkg" "$@"`,
  );
  stub(
    bin,
    "curl",
    `out=""
while (($#)); do [[ $1 == -o ]] && out=$2; shift; done
printf 'curl\\n' >> "$FIX/events"
cat "$FIX/served-key" > "\${out:-/dev/stdout}"`,
  );

  const definitions = DEFINITIONS.replaceAll(KEYRING, keyring)
    .replaceAll(GH_SOURCE, source)
    .replaceAll(
      "/usr/share/keyrings/.githubcli-keyring.XXXXXXXXXX",
      join(fix, "keyrings", ".githubcli-keyring.XXXXXXXXXX"),
    )
    .replaceAll(
      "/etc/apt/sources.list.d/.github-cli.XXXXXXXXXX",
      join(fix, "sources", ".github-cli.XXXXXXXXXX"),
    );
  const script = `${definitions}
trap - ERR
CONFFILE_ROOT="$FIX/etc"
DRY_RUN=""
ISOMUX_DEPS_ONLY=${box.depsOnly ? "1" : '""'}
wait_for_package_manager() { :; }
# An office that is not claimed: the full package run masks Caddy.
caddy_serving_claimed_office() { return 1; }
# Its real body removes files under /etc and /usr/share.
remove_caddy_apt_source() { printf 'remove_caddy_apt_source\\n' >> "$FIX/events"; }
github_download() { printf 'download %s\\n' "$1" >> "$FIX/events"; return 1; }
install_packages
printf 'install_packages done\\n' >> "$FIX/events"
${box.after ?? ""}
`;
  // A file, not -c: the installer is larger than one argument may be.
  writeFileSync(join(fix, "run.sh"), script);
  const res = spawnSync("bash", [join(fix, "run.sh")], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: fix,
      TMPDIR: fix,
      FIX: fix,
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  const lines = readFileSync(events, "utf8").split("\n").filter(Boolean);
  const isApt = (l: string) => l.startsWith("apt-get ");
  // A full refresh of every source, not the GitHub CLI's one-source update.
  const fullUpdate = (l: string) =>
    isApt(l) && / update( |$)/.test(l) && !l.includes("sourcelist=");
  const ghUpdate = (l: string) =>
    isApt(l) && / update( |$)/.test(l) && l.includes("sourcelist=");
  // The install from the cache: an install also runs a --download-only half
  // first (install-apt-limits.test.ts), which this file does not count.
  const install = (l: string) =>
    isApt(l) && / install( |$)/.test(l) && !l.includes(" --download-only");
  const leftovers = [
    ...readdirSync(join(fix, "keyrings")),
    ...readdirSync(join(fix, "sources")),
  ].filter((f) => f.startsWith("."));
  return {
    code: res.status,
    out: `${res.stdout}${res.stderr}`,
    lines,
    fullUpdates: lines.filter(fullUpdate),
    ghUpdates: lines.filter(ghUpdate),
    installs: lines.filter(install),
    caddyUnit: lines.filter((l) => /^systemctl .*caddy/.test(l)),
    downloads: lines.filter((l) => l.startsWith("download ")),
    leftovers,
    keyring: existsSync(keyring) ? readFileSync(keyring, "utf8") : null,
    source: existsSync(source) ? readFileSync(source, "utf8") : null,
    ownSource,
  };
}

// The apt-get calls before and after install_packages returned.
function split(lines: string[]) {
  const at = lines.indexOf("install_packages done");
  expect(at).toBeGreaterThan(-1);
  return { during: lines.slice(0, at), later: lines.slice(at + 1) };
}

describe("install.sh dependency sync: package step", () => {
  it("reads the package list the install uses", () => {
    // The fixture database is built from it; an empty parse would make every
    // case below pass on nothing.
    expect(PACKAGES).toContain("polkitd");
    expect(PACKAGES).toContain("openssh-client");
    expect(PACKAGES.length).toBeGreaterThan(5);
    expect(CADDY_PIN).toMatch(/^\d+\.\d+/);
  });

  it("runs no apt and leaves Caddy alone when the box has everything", () => {
    const r = sync({ depsOnly: true });
    expect({ code: r.code, out: r.code === 0 ? "" : r.out }).toEqual({
      code: 0,
      out: "",
    });
    expect(r.lines).toContain("install_packages done");
    expect(r.lines.filter((l) => l.startsWith("apt-get "))).toEqual([]);
    expect(r.caddyUnit).toEqual([]);
    expect(r.downloads).toEqual([]);
    // The GitHub CLI source is checked, not rewritten, and leaves no temp file.
    expect(r.keyring).toBe("key-v1");
    expect(r.source).toBe(r.ownSource);
    expect(r.leftovers).toEqual([]);
  });

  for (const [what, packages] of [
    ["a listed package is missing", { tmux: null }],
    ["a listed package is half-configured", { jq: "half-configured" }],
  ] as const) {
    it(`refreshes the lists and installs the list when ${what}`, () => {
      const r = sync({ depsOnly: true, packages });
      expect({ code: r.code, out: r.code === 0 ? "" : r.out }).toEqual({
        code: 0,
        out: "",
      });
      expect(r.fullUpdates).toHaveLength(1);
      // The list install; gh has its own check.
      const list = r.installs.filter((l) => !/ gh$/.test(l));
      expect(list).toHaveLength(1);
      const args = list[0].split(" ");
      for (const p of PACKAGES) expect(args).toContain(p);
      // apt runs, so an office that is not claimed gets Caddy masked first.
      expect(r.caddyUnit.some((l) => l.includes("mask caddy"))).toBe(true);
    });
  }

  it("installs the pinned Caddy release when the box's Caddy is older", () => {
    const r = sync({ depsOnly: true, caddyVersion: "2.0.0" });
    expect(r.downloads.some((l) => l.includes(`v${CADDY_PIN}`))).toBe(true);
  });

  it("installs the pinned Caddy release when Caddy is not installed", () => {
    const r = sync({ depsOnly: true, packages: { caddy: null } });
    expect(r.downloads.some((l) => l.includes(`v${CADDY_PIN}`))).toBe(true);
  });

  for (const [what, box] of [
    ["GitHub's key changed", { keyringServed: "key-v2" }],
    ["the box has no GitHub CLI key", { keyringOnBox: null }],
    ["the GitHub CLI source line differs", { sourceOnBox: "deb old\n" }],
    ["gh is not installed", { packages: { gh: null } }],
  ] as const) {
    it(`updates the GitHub CLI source and installs gh when ${what}`, () => {
      const r = sync({ depsOnly: true, ...box });
      expect({ code: r.code, out: r.code === 0 ? "" : r.out }).toEqual({
        code: 0,
        out: "",
      });
      expect(r.ghUpdates).toHaveLength(1);
      expect(r.installs.some((l) => / gh( |$)/.test(l))).toBe(true);
      // The one-source update is the refresh gh needs: no full one.
      expect(r.fullUpdates).toEqual([]);
      expect(r.keyring).toBe(box.keyringServed ?? "key-v1");
      expect(r.source).toBe(r.ownSource);
      expect(r.leftovers).toEqual([]);
    });
  }

  it("refreshes the lists once, before the first later install, when the package run was skipped", () => {
    const r = sync({
      depsOnly: true,
      after: `apt_install "$FIX/google-chrome.deb"
apt_install bubblewrap
apt_install apparmor apparmor-profiles`,
    });
    expect({ code: r.code, out: r.code === 0 ? "" : r.out }).toEqual({
      code: 0,
      out: "",
    });
    const { during, later } = split(r.lines);
    expect(during.filter((l) => l.startsWith("apt-get "))).toEqual([]);
    const apt = later.filter((l) => l.startsWith("apt-get "));
    expect(apt.filter((l) => / update( |$)/.test(l))).toHaveLength(1);
    // The update comes first: the Chrome package's dependencies resolve from
    // the lists too.
    expect(/ update( |$)/.test(apt[0]) && !apt[0].includes("sourcelist=")).toBe(
      true,
    );
    expect(apt.slice(1).every((l) => / install( |$)/.test(l))).toBe(true);
    expect(apt.filter((l) => !l.includes(" --download-only"))).toHaveLength(4);
  });

  it("does not refresh the lists again after a package run that refreshed them", () => {
    const r = sync({
      depsOnly: true,
      packages: { tmux: null },
      after: "apt_install bubblewrap",
    });
    expect({ code: r.code, out: r.code === 0 ? "" : r.out }).toEqual({
      code: 0,
      out: "",
    });
    const { later } = split(r.lines);
    expect(r.fullUpdates).toHaveLength(1);
    expect(later.filter((l) => / update( |$)/.test(l))).toEqual([]);
    expect(r.installs.filter((l) => later.includes(l))).toHaveLength(1);
  });

  it("a full install still refreshes and installs everything on a box that has it all", () => {
    const r = sync({ depsOnly: false, after: "apt_install bubblewrap" });
    expect({ code: r.code, out: r.code === 0 ? "" : r.out }).toEqual({
      code: 0,
      out: "",
    });
    const { during, later } = split(r.lines);
    expect(
      during.filter(
        (l) => / update( |$)/.test(l) && !l.includes("sourcelist="),
      ),
    ).toHaveLength(1);
    expect(r.ghUpdates).toHaveLength(1);
    const installs = during.filter((l) => / install( |$)/.test(l));
    expect(
      installs.some((l) => PACKAGES.every((p) => l.split(" ").includes(p))),
    ).toBe(true);
    expect(installs.some((l) => / gh( |$)/.test(l))).toBe(true);
    // The full run's refresh serves the later steps too.
    expect(later.filter((l) => / update( |$)/.test(l))).toEqual([]);
    expect(r.installs.filter((l) => later.includes(l))).toHaveLength(1);
  });
});
