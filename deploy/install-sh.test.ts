// deploy/install.sh - checks for the parts of the installer that cannot run
// here (main() requires root) or that it writes as text. The steps that can run
// unprivileged are run by the install-*.test.ts files beside this one. This
// file covers the update-trigger escalation (the polkit rule's regex extracted
// and run as a real RegExp, against the updater's and version.ts's tag
// grammar), main()'s step order, the embedded helper copies, the Caddyfile and
// isomux.service as rendered, the OOM step's failure paths, the cookie-jar awk
// under both awks, and a scan of every heredoc for command substitution. Zero
// LLM.

import { describe, it, expect } from "bun:test";
import {
  existsSync,
  readFileSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { EMBEDDED, embed } from "../scripts/embed-deploy-scripts.ts";
import { AGENT_OOM_SCORE_ADJ } from "../server/oom-stamp.ts";
import { TLS_ASK_PATH } from "../server/tls-ask.ts";
import { CALVER_RELEASE_RE } from "../server/version.ts";
import { BROWSER_ABSOLUTE_PATHS } from "../server/preview-capture.ts";

const SRC = readFileSync(new URL("./install.sh", import.meta.url), "utf8");

const repoFile = (p: string) =>
  readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/** Shell/profile source with whole-line comments removed. */
function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
}

/** Position of a step's call inside main(), for ordering assertions. */
function stepIndex(name: string): number {
  const idx = SRC.indexOf(`\n  ${name}\n`, SRC.lastIndexOf("\nmain() {"));
  expect({ name, found: idx > -1 }).toEqual({ name, found: true });
  return idx;
}

// The polkit unit-name pattern as written in the heredoc. Bash expands `\$`
// to `$` when writing the file (unquoted heredoc), so unescape exactly that
// to get the regex polkitd will evaluate.
function extractPolkitUnitRegex(): RegExp {
  const m = /^\s*\/(\^isomux-update@[^/]+)\/\.test\(/m.exec(SRC);
  if (!m) throw new Error("polkit unit regex not found in install.sh");
  return new RegExp(m[1].replaceAll("\\$", "$"));
}

describe("install.sh escalation: polkit rule", () => {
  it("grants only manage-units, only verb start, only the service user", () => {
    expect(SRC).toContain(
      'action.id === "org.freedesktop.systemd1.manage-units"',
    );
    expect(SRC).toContain('subject.user === "$SERVICE_USER"');
    expect(SRC).toContain('action.lookup("verb") === "start"');
    expect(SRC).toContain("polkit.Result.YES");
    // No blanket grant anywhere in the rule.
    expect(SRC).not.toContain("polkit.Result.AUTH_SELF");
  });

  it("the unit regex accepts exactly CalVer template instances", () => {
    const re = extractPolkitUnitRegex();
    for (const unit of [
      "isomux-update@v2026.7.19.service",
      "isomux-update@v2026.7.19.2.service",
      "isomux-update@v2026.12.31.service",
    ]) {
      expect(re.test(unit)).toBe(true);
    }
    for (const unit of [
      "evil.service",
      "isomux.service",
      "isomux-update@main.service",
      "isomux-update@v1.0.service",
      "isomux-update@v2026.7.19.service evil.service", // space smuggling
      "isomux-update@v2026.7.19.service.evil", // suffix smuggling
      "isomux-update@v2026.7.19", // not the .service form systemd checks
      "Xisomux-update@v2026.7.19.service", // unanchored-prefix probe
    ]) {
      expect(re.test(unit)).toBe(false);
    }
  });

  it("the CalVer core matches the updater's and version.ts's tag shape", () => {
    // One channel, one grammar: the polkit pattern must accept exactly the
    // tags scripts/update.sh (CALVER_RE) and server/version.ts
    // (CALVER_RELEASE_RE) accept, or an update could be startable but
    // refused - or worse, refusable but startable.
    const polkit = extractPolkitUnitRegex();
    const assignment = /^CALVER_RE='[^']*'$/m.exec(
      repoFile("scripts/update.sh"),
    );
    if (!assignment) throw new Error("CALVER_RE not found in update.sh");
    const rows: [tag: string, accepted: boolean][] = [
      ["v2026.7.19", true],
      ["v2026.7.19.2", true],
      ["v2026.12.31", true],
      ["v2026.1.1.10", true],
      ["v1.0", false],
      ["main", false],
      ["2026.7.19", false],
      ["v2026.7", false],
      ["v20261.7.19", false],
      ["v2026.123.1", false],
      ["v2026.7.123", false],
      ["v2026.7.19.", false],
      ["v2026.7.19.x", false],
      ["v2026.7.19 v2026.7.20", false],
    ];
    // update.sh's own assignment line, matched the way update.sh matches.
    const bash = Bun.spawnSync([
      "bash",
      "-c",
      `${assignment[0]}\nfor t in "$@"; do [[ $t =~ $CALVER_RE ]] && echo 1 || echo 0; done`,
      "bash",
      ...rows.map(([tag]) => tag),
    ]);
    expect(bash.exitCode).toBe(0);
    const updater = bash.stdout.toString().trim().split("\n");
    expect(updater).toHaveLength(rows.length);
    rows.forEach(([tag, accepted], i) => {
      expect({
        tag,
        polkit: polkit.test(`isomux-update@${tag}.service`),
        version: CALVER_RELEASE_RE.test(tag),
        updater: updater[i] === "1",
      }).toEqual({
        tag,
        polkit: accepted,
        version: accepted,
        updater: accepted,
      });
    });
  });
});

describe("install.sh escalation: template unit + placement", () => {
  it("root-owned oneshot template running the installed updater on %i", () => {
    const open =
      "write_file /etc/systemd/system/isomux-update@.service 644 <<EOF\n";
    const start = SRC.indexOf(open);
    expect(start).toBeGreaterThan(-1);
    const lines = SRC.slice(
      start + open.length,
      SRC.indexOf("\nEOF\n", start),
    ).split("\n");
    expect(lines).toContain("Type=oneshot");
    expect(lines).toContain("ExecStart=$UPDATER_PATH %i");
    // On-demand only: no [Install] section, nothing enables it at boot.
    expect(lines).not.toContain("[Install]");
    expect(lines.join("\n")).not.toContain("WantedBy");
  });

  it("written inside the guarded updater step, daemon-reload after", () => {
    const guard = SRC.indexOf("skipping updater installation");
    const updater = SRC.indexOf('install -m 755 "$tmp" "$UPDATER_PATH"');
    const unit = SRC.indexOf(
      "write_file /etc/systemd/system/isomux-update@.service",
    );
    const rule = SRC.indexOf("50-isomux-update.rules");
    const reload = SRC.indexOf("systemctl daemon-reload", unit);
    for (const idx of [guard, updater, unit, rule, reload]) {
      expect(idx).toBeGreaterThan(-1);
    }
    // Guarded (no updater in the ref → none of the escalation pieces), and
    // daemon-reload only after both files are in place.
    expect(guard).toBeLessThan(unit);
    expect(updater).toBeLessThan(unit);
    expect(unit).toBeLessThan(rule);
    expect(rule).toBeLessThan(reload);
  });

  it("installs the packages later steps need (minimal images may lack them)", () => {
    for (const [pkg, why] of [
      ["polkitd", "the in-UI update trigger is a polkit rule"],
      ["openssh-client", "the root-reachability gate probes over ssh"],
    ]) {
      const listed = new RegExp(`apt_install[^\\n]*\\b${pkg}\\b`).test(SRC);
      expect({ pkg, why, listed }).toEqual({ pkg, why, listed: true });
    }
  });

  it("installs the browser where page previews look for it, never from snap", () => {
    // snap chromium installs cleanly and then cannot screenshot on a headless
    // server, so an installer that reaches for it would look successful and
    // still ship preview-url dead.
    expect(SRC).not.toMatch(/^\s*(run )?snap\b/m); // never invoked, only warned about
    const chrome = /^CHROME_PATH=(\S+)$/m.exec(SRC);
    if (!chrome) throw new Error("CHROME_PATH not found in install.sh");
    expect(BROWSER_ABSOLUTE_PATHS).toContain(chrome[1]);
  });

  it("makes codex's bubblewrap sandbox work, without weakening the box", () => {
    // Behavior lives in install-codex-sandbox.test.ts, which RUNS the step.
    // Pinned here: the placement, and the two shortcuts that must never appear
    // - a permissive profile, or turning the kernel restriction off box-wide -
    // since both make the symptom go away on a box that then runs arbitrary
    // agent commands with user namespaces wide open.
    // Comments stripped: the step's own comment names both shortcuts in order
    // to rule them out, and the vendored profile keeps upstream's commentary.
    const code = stripComments(SRC);
    expect(code).not.toContain("flags=(unconfined)");
    expect(code).not.toMatch(
      /sysctl[^\n]*apparmor_restrict_unprivileged_userns/,
    );
    expect(code).toContain("audit deny capability");
    // The smoke test runs as the service user: root is exempt from the
    // restriction, so as root it would pass on a box where codex cannot start.
    // It uses the service's PATH, so it tests the bwrap Codex will find.
    expect(SRC).toContain(
      'as_service_user env "PATH=$(service_path)" bwrap --unshare-net --dev-bind / / /bin/true',
    );
  });

  it("ships the helper scripts byte-for-byte, not a drifted copy", () => {
    // install.sh is downloaded and run on its own, so what it installs on
    // the box has to be inside it. A copy that drifts from the repo file is
    // worse than no copy: reviewers read the file, boxes run the copy.
    expect(embed(SRC, repoFile)).toBe(SRC);
    for (const { path, delimiter } of EMBEDDED) {
      expect(SRC).toContain(`<<'${delimiter}'`);
      expect(SRC).toContain(repoFile(path).trimEnd());
    }
  });
});

// main() needs root, so the order of its steps is read from its body. One
// table, one reason per pair.
describe("install.sh: main() step order", () => {
  it("runs each step after the one it depends on, and gates root twice", () => {
    const pairs: [before: string, after: string, why: string][] = [
      // The two root gates.
      [
        "create_service_user",
        "check_root_reachability",
        "gate 1 probes as the service account",
      ],
      [
        "check_root_reachability",
        "fetch_isomux",
        "a doomed box fails in seconds, before the build",
      ],
      [
        "wait_for_server",
        "assert_hardening",
        "gate 2 checks the finished, running box",
      ],
      [
        "assert_hardening",
        "claim_owner",
        "a failed box leaves no owner, invite or success callback",
      ],
      // Everything else.
      [
        "sync_install_kind",
        "install_service",
        "the office reads the install-kind marker when it starts",
      ],
      [
        "configure_oom_protection",
        "build_isomux",
        "the build is the memory-hungry part",
      ],
      [
        "create_service_user",
        "configure_user_manager",
        "linger is enabled for that account",
      ],
      [
        "configure_user_manager",
        "install_service",
        "the service starts with its user bus already up",
      ],
      [
        "create_service_user",
        "install_browser",
        "the capture probe runs as the service user",
      ],
      [
        "install_browser",
        "fetch_isomux",
        "a browser warning shows early in the output",
      ],
      [
        "create_service_user",
        "configure_codex_sandbox",
        "the bwrap smoke test runs as the service user",
      ],
      [
        "configure_codex_sandbox",
        "fetch_isomux",
        "a sandbox warning shows early, like the browser's",
      ],
      [
        "build_isomux",
        "link_bundled_claude",
        "the bundled CLI exists only after the build",
      ],
      [
        "link_bundled_claude",
        "install_service",
        "claude is linked before the office can spawn it",
      ],
      [
        "configure_caddy",
        "write_loopback_bind_if_proxied",
        "networkBind goes to loopback only once Caddy proxies",
      ],
    ];
    for (const [before, after, why] of pairs) {
      const ordered = stepIndex(before) < stepIndex(after);
      expect({ before, after, why, ordered }).toEqual({
        before,
        after,
        why,
        ordered: true,
      });
    }
  });

  // The server reads networkBind and trustedProxy only at boot, so the office
  // that serves internet traffic after a fresh install must start after
  // write_loopback_bind_if_proxied (task 1ae5b2ba).
  it("restarts the office after it writes the proxy settings", () => {
    const tail = SRC.slice(SRC.lastIndexOf("\nmain() {\n"));
    const body = tail.slice(0, tail.indexOf("\n}\n"));
    const calls = body.match(/^ {2}[a-z_]+$/gm)!.map((l) => l.trim());
    const steps = calls.slice(calls.indexOf("preflight"));
    const restartsOffice = (name: string) => {
      const start = SRC.indexOf(`\n${name}() {\n`);
      expect({ name, defined: start > -1 }).toEqual({ name, defined: true });
      const fn = SRC.slice(start, SRC.indexOf("\n}\n", start));
      return fn.includes("systemctl restart isomux");
    };
    expect(steps.filter(restartsOffice)).toContain("configure_public_access");
    expect(steps).toContain("write_loopback_bind_if_proxied");
    const after = steps.slice(
      steps.indexOf("write_loopback_bind_if_proxied") + 1,
    );
    expect(after.filter(restartsOffice)).toEqual(["apply_proxy_settings"]);
  });
});

describe("install.sh: the box cannot ship with agents able to reach root", () => {
  it("has no escape hatch for either gate", () => {
    // The installer's whole environment surface is its parameter block; an
    // opt-out would have to live there. It deliberately does not: the installs
    // that would set it are the ones that most need the check.
    const params = SRC.match(/^[A-Z_]+="\$\{[A-Z_]+:-[^}]*\}"$/gm) ?? [];
    expect(params.length).toBeGreaterThan(4);
    expect(params.join("\n")).not.toMatch(
      /SKIP|FORCE|ALLOW|IGNORE|OVERRIDE|UNSAFE/,
    );
  });
});

// The managed Caddyfile, rendered the way configure_caddy renders it. The
// heredoc expands exactly two variables, which the assertion below pins - so a
// literal substitution here IS the file the installer writes, and every claim
// about placement can be made per site block rather than per file.
function renderCaddyfile(
  domain: string,
  kind: "hosted" | "self-hosted" = "self-hosted",
  renderer:
    | "render_caddyfile"
    | "render_caddyfile_without_access_log"
    | "render_caddyfile_hosted_forward_auth" = "render_caddyfile",
): string {
  const at = SRC.indexOf(`\n${renderer}() {`);
  expect({ renderer, found: at > -1 }).toEqual({ renderer, found: true });
  const first = SRC.indexOf('cat >"$output" <<EOF\n', at);
  const from =
    kind === "hosted"
      ? first
      : SRC.indexOf('cat >"$output" <<EOF\n', first + 1);
  const open = 'cat >"$output" <<EOF\n';
  expect(from).toBeGreaterThan(-1);
  const body = SRC.slice(from + open.length, SRC.indexOf("\nEOF\n", from) + 1);
  expect(new Set(body.match(/\$[A-Za-z_]+/g))).toEqual(
    new Set(["$CADDY_MARKER", "$domain"]),
  );
  return body
    .replaceAll("$CADDY_MARKER", CADDY_MARKER)
    .replaceAll("$domain", domain)
    .replaceAll("\\${", "${");
}

const CADDY_MARKER = "# Managed by the isomux installer";

// One top-level block out of the rendered file. Nested directives are indented
// with tabs, so a site ends at the first `}` in column zero.
function block(rendered: string, header: string): string {
  // The global block has no header - it is the bare `{` after the marker line.
  const from = rendered.indexOf(header === "" ? "\n{\n" : `\n${header} {\n`);
  expect({ header, found: from > -1 }).toEqual({ header, found: true });
  return rendered.slice(from, rendered.indexOf("\n}\n", from) + 3);
}

describe("install.sh: the managed Caddyfile", () => {
  it("pins every shipped older rendering used as the migration ownership proof", () => {
    const sha = (text: string) =>
      createHash("sha256").update(text).digest("hex");
    const old = "render_caddyfile_without_access_log";
    expect(sha(renderCaddyfile("office.example", "hosted", old))).toBe(
      "09f4544624d0412cc03dfbfdd44b20bce34529761792a6823b29cb24c9ff85d4",
    );
    expect(sha(renderCaddyfile("office.example", "self-hosted", old))).toBe(
      "fa001a042800a0805c71dc3a70933b6b4915615f85b98b5d5ca0ecbac7332fa0",
    );
    // The hosted rendering with access logs and forward_auth, as main
    // 76825fd6's render_caddyfile wrote it. Hosted boxes run these bytes until
    // their first update after task 1fa3c1de.
    expect(
      sha(
        renderCaddyfile(
          "office.example",
          "hosted",
          "render_caddyfile_hosted_forward_auth",
        ),
      ),
    ).toBe("d2c984c0d4d515889c93e0b910421e54abb7f33606c4be4c5da3477cbfccd8c4");
  });

  it("keeps bounded 14-day logs and redacts both URL credential forms", () => {
    for (const kind of ["hosted", "self-hosted"] as const) {
      const rendered = renderCaddyfile("office.example", kind);
      for (const header of ["office.example", "*.office.example"]) {
        const site = block(rendered, header);
        expect(site).toContain("roll_size 10MiB");
        expect(site).toContain("roll_interval 24h");
        expect(site).toContain("roll_keep 14");
        expect(site).toContain("roll_keep_for 312h");
        expect(site).not.toContain("log_credentials");
        const filters = site.match(/request>uri regexp[^\n]+/g) ?? [];
        expect(filters).toHaveLength(1);
        // Apply the rendered filter itself. Caddy uses Go's regexp, whose
        // ${n} group references JS spells $n.
        const filter = /regexp "([^"]+)" "([^"]+)"$/.exec(filters[0]!);
        if (!filter) throw new Error(`unparsed filter: ${filters[0]}`);
        const pattern = new RegExp(filter[1], "g");
        const replacement = filter[2].replace(/\$\{(\d+)\}/g, "$$$1");
        expect("/i/live-invite?next=/".replace(pattern, replacement)).toBe(
          "/i/<redacted>?next=/",
        );
        expect(
          "/__isomux/auth?code=live-code&return=%2F".replace(
            pattern,
            replacement,
          ),
        ).toBe("/__isomux/auth?code=<redacted>&return=%2F");
      }
    }
  });

  it("serves hosted app hosts on the wildcard certificate with no certificate gate", () => {
    // The office's app-host arm refuses a label that is not live itself, and
    // the gate refuses every proxied caller, so a forward_auth to it could
    // only fail every app request (task 1fa3c1de).
    const hosted = renderCaddyfile("office.example", "hosted");
    const apps = block(hosted, "*.office.example");
    expect(apps).toContain(
      "tls /etc/isomux/tls/cert.pem /etc/isomux/tls/key.pem",
    );
    expect(apps).toContain("reverse_proxy 127.0.0.1:4000");
    expect(apps).not.toContain("forward_auth");
    expect(apps).not.toContain(TLS_ASK_PATH);
    expect(hosted).not.toContain("on_demand");
  });

  it("has exactly one marker, one global block and one block per site", () => {
    for (const kind of ["hosted", "self-hosted"] as const) {
      const rendered = renderCaddyfile("office.example", kind);
      expect(rendered.split(CADDY_MARKER).length - 1).toBe(1);
      expect(rendered.startsWith(`${CADDY_MARKER}\n`)).toBe(true);
      expect(rendered.match(/^\S*\s?{$/gm)).toEqual([
        "{",
        "office.example {",
        "*.office.example {",
      ]);
      // Caddy's admin API listens on 127.0.0.1:2019 by default and rewrites
      // the proxy config with no credential. Loopback is not a trust boundary
      // here: agents run on this box, and an SSRF bug in anything they build
      // reaches it. Caddy only accepts global options in the first block.
      expect(block(rendered, "")).toContain("admin off");
      // Caddy calls the ask URL over loopback, never through a site block, so
      // refusing that exact path at the edge costs nothing and stops a
      // stranger asking the office which apps exist.
      expect(block(rendered, "office.example")).toContain(
        `respond ${TLS_ASK_PATH} 404`,
      );
      // The wildcard must NOT carry it: an app host serves its sign-in
      // handshake under the same prefix.
      expect(block(rendered, "*.office.example")).not.toContain("respond");
      expect(block(rendered, "office.example")).toContain(
        "reverse_proxy 127.0.0.1:4000",
      );
      expect(block(rendered, "*.office.example")).toContain(
        "reverse_proxy 127.0.0.1:4000",
      );
    }
  });

  it("gates on-demand certificates on the office's own ask endpoint", () => {
    const rendered = renderCaddyfile("office.example");
    const global = block(rendered, "");
    expect(global).toContain("on_demand_tls {");
    // The URL the terminator calls must be the route the office actually
    // serves; this fails if either side is renamed alone.
    expect(global).toContain(`ask http://127.0.0.1:4000${TLS_ASK_PATH}`);
    // On the wildcard site only. The office keeps ordinary automatic HTTPS: it
    // has a name, an A record and a certificate obtained at startup.
    expect(block(rendered, "office.example")).not.toContain("on_demand");
    const wildcard = block(rendered, "*.office.example");
    expect(wildcard).toContain("tls {");
    expect(wildcard).toContain("on_demand");
  });
});

describe("install.sh: out-of-memory protection", () => {
  it("does not run old helper bytes when staging the target helper fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "isomux-oom-skew-"));
    const oldTool = join(dir, "old-helper");
    const ran = join(dir, "ran");
    writeFileSync(oldTool, `#!/bin/sh\ntouch ${ran}\nexit 3\n`);
    const fn = SRC.slice(
      SRC.indexOf("configure_oom_protection() {"),
      SRC.indexOf("\nenable_auto_updates() {"),
    );
    const script = `${fn}
OOM_TOOL=${oldTool}
DRY_RUN=""
step() { :; }
log() { echo "LOG: $*"; }
outcome_add() { echo "OUTCOME: $*"; }
write_file() { return 1; }
configure_oom_protection update
`;
    try {
      const result = Bun.spawnSync(["bash", "-Eeuo", "pipefail", "-c", script]);
      expect(result.exitCode).toBe(0);
      expect(existsSync(ran)).toBe(false);
      expect(result.stdout.toString()).toContain("could not be staged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the install or update going when the helper itself fails", () => {
    // Update mode reports the failure in the update's outcome; a full install
    // only warns. Neither stops: the office runs without the protection.
    const fn = SRC.slice(
      SRC.indexOf("configure_oom_protection() {"),
      SRC.indexOf("\nenable_auto_updates() {"),
    );
    for (const mode of ["update", "full"]) {
      const dir = mkdtempSync(join(tmpdir(), "isomux-oom-nonfatal-"));
      const ran = join(dir, "ran");
      // The staged bytes are replaced by a helper that records it ran, then fails.
      const script = `${fn}
OOM_TOOL=${join(dir, "helper")}
DRY_RUN=""
step() { :; }
log() { echo "LOG: $*"; }
outcome_add() { echo "OUTCOME: $*"; }
write_file() { cat >/dev/null; printf '#!/bin/sh\\ntouch ${ran}\\nexit 1\\n' >"$1"; chmod "$2" "$1"; }
configure_oom_protection ${mode === "update" ? "update" : ""}
echo REACHED-END
`;
      try {
        const result = Bun.spawnSync([
          "bash",
          "-Eeuo",
          "pipefail",
          "-c",
          script,
        ]);
        const out = result.stdout.toString();
        expect({ mode, exit: result.exitCode, ran: existsSync(ran) }).toEqual({
          mode,
          exit: 0,
          ran: true,
        });
        expect(out).toContain("REACHED-END");
        expect(out).toMatch(
          mode === "update" ? /^OUTCOME: \S/m : /^LOG: warning: /m,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

// The one piece of install.sh that reads the office's session cookie, and its
// copy in control-plane/remote/mint-invite.sh. It runs the REAL awk program out
// of each source against synthetic jars, under both awks a box can have,
// because the property that matters is a behavior (which name wins), not a
// substring.
const MINT_INVITE_SRC = readFileSync(
  new URL("../control-plane/remote/mint-invite.sh", import.meta.url),
  "utf8",
);
for (const [label, source] of [
  ["install.sh", SRC],
  ["mint-invite.sh", MINT_INVITE_SRC],
] as const) {
  describe(`${label} - session cookie jar parse`, () => {
    const awkProgram = (() => {
      const start = source.indexOf("raw=$(awk '");
      expect(start).toBeGreaterThan(-1);
      const from = start + "raw=$(awk '".length;
      const end = source.indexOf("'", from);
      expect(end).toBeGreaterThan(from);
      return source.slice(from, end);
    })();

    const awks = ["mawk", "gawk"].filter((awk) => Bun.which(awk) !== null);

    async function runAwk(jar: string): Promise<string> {
      const path = `${process.env.TMPDIR ?? "/tmp"}/isomux-cookiejar-${Bun.hash(jar)}.txt`;
      await Bun.write(path, jar);
      const outs = new Set<string>();
      for (const awk of awks.length > 0 ? awks : ["awk"]) {
        const proc = Bun.spawn([awk, awkProgram, path], { stdout: "pipe" });
        outs.add((await new Response(proc.stdout).text()).trim());
        await proc.exited;
      }
      if (outs.size !== 1) throw new Error(`awks disagree: ${[...outs]}`);
      return [...outs][0]!;
    }

    // Netscape jar rows: domain, flag, path, secure, expiry, NAME, VALUE.
    const row = (name: string, value: string) =>
      `#HttpOnly_127.0.0.1\tFALSE\t/\tTRUE\t9999999999\t${name}\t${value}`;
    const OWN_HOST = "__Host-isomux_session_0123456789ab";
    const OWN_PLAIN = "isomux_session_0123456789ab";
    const SHARED_HOST = "__Host-isomux_session";
    const SHARED = "isomux_session";
    // The server's order for an HTTPS office, highest first.
    const ORDER = [OWN_HOST, OWN_PLAIN, SHARED_HOST, SHARED];

    it("picks the server's order, in every row order", async () => {
      // A jar that outlives an update holds the shared names next to the
      // office's own. The prefix that wins here has to be the one the server
      // itself selects, or the script resolves the wrong session and mints an
      // invite for the wrong user.
      for (let top = 0; top < ORDER.length; top++) {
        const names = ORDER.slice(top);
        const rows = names.map((name) => row(name, `V-${name}`));
        const expected = `V-${names[0]}`;
        expect(await runAwk(`${rows.join("\n")}\n`)).toBe(expected);
        expect(await runAwk(`${rows.reverse().join("\n")}\n`)).toBe(expected);
      }
    });

    it("reads a jar with only one name, for each name", async () => {
      for (const name of ORDER) {
        expect(await runAwk(`${row(name, "ONLY")}\n`)).toBe("ONLY");
      }
    });

    it("ignores a look-alike name, so the caller can die", async () => {
      expect(await runAwk(`${row("other_cookie", "X")}\n`)).toBe("");
      expect(await runAwk(`${row("isomux_session_id", "X")}\n`)).toBe("");
    });
  });
}

// The unit heredoc is UNQUOTED, because it expands $SERVICE_USER, $SERVICE_HOME
// and $INSTALL_DIR. That also means everything else inside it is expanded - and
// on 2026-08-03 two comment lines arrived carrying backticks. Bash ran them:
// `systemctl restart isomux` executed before the unit existed, the installer's
// own failure log was captured as the substitution's output and spliced into
// the file, and systemd rejected the result with "Bad message" on every FRESH
// install. Re-installs kept working (the restart succeeded and printed
// nothing), which is why it survived six days unnoticed.
//
// Rendering the unit is the only way to catch this class: reading the source
// cannot tell an expanded backtick from a literal one.
describe("install.sh: the systemd unit renders cleanly", () => {
  // Pull the heredoc body straight out of the source and let bash expand it
  // exactly as the installer would, with the three variables the unit needs.
  //
  // Rendered with an EMPTY PATH and shell builtins only (read, printf), which
  // is what makes this deterministic: any command substitution left in the body
  // has nothing to exec, so it lands on stderr as "command not found". On a box
  // that happens to HAVE the command - this one runs isomux.service - a
  // backticked "systemctl restart isomux" would succeed and print nothing, and
  // the render would look perfectly clean. That environment dependence is
  // exactly how the real bug hid: it broke fresh installs and spared re-installs.
  function renderUnit(source: string): { unit: string; stderr: string } {
    const start = source.indexOf(
      "write_file /etc/systemd/system/isomux.service 644 <<EOF",
    );
    expect(start).toBeGreaterThan(-1);
    const bodyStart = source.indexOf("\n", start) + 1;
    const end = source.indexOf("\nEOF\n", bodyStart);
    expect(end).toBeGreaterThan(bodyStart);
    const body = source.slice(bodyStart, end);
    const script =
      `SERVICE_USER=isomux\nSERVICE_HOME=/home/isomux\nINSTALL_DIR=/opt/isomux\n` +
      `IFS= read -r -d '' rendered <<EOF\n${body}\nEOF\nprintf '%s' "$rendered"\n`;
    const proc = Bun.spawnSync(["bash", "-c", script], { env: { PATH: "" } });
    return {
      unit: new TextDecoder().decode(proc.stdout),
      stderr: new TextDecoder().decode(proc.stderr),
    };
  }

  const { unit, stderr: renderStderr } = renderUnit(SRC);

  // The deterministic detector: with no PATH, a body that still executes
  // something cannot stay quiet.
  it("executes nothing while being rendered", () => {
    expect(renderStderr).toBe("");
  });

  it("expands the three variables it is unquoted for", () => {
    expect(unit).toContain("User=isomux");
    expect(unit).toContain("Environment=HOME=/home/isomux");
    expect(unit).toContain("WorkingDirectory=/opt/isomux");
  });

  // Directives as systemd reads them: comment lines are not directives, and
  // the comments here name Restart=always too.
  function directive(key: string): string {
    const values = unit
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .flatMap((l) => {
        const m = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(l.trim());
        return m && m[1] === key ? [m[2]] : [];
      });
    expect({ key, count: values.length }).toEqual({ key, count: 1 });
    return values[0];
  }

  // Task e05a5cd4. Seven variants of a sacrificial unit shaped like the office
  // were measured (internal-docs/sizing-tiers-benchmark-results.md, "The blast
  // radius, measured"); exactly one contained an OOM kill to a single agent,
  // and it needed BOTH OOMPolicy=continue and the agents' positive stamp.
  // Either alone recycles the whole office, which is the incident this came
  // from.
  it("keeps the office running through an agent's OOM kill and a restart burst", () => {
    // systemd's default policy, `stop`, plus Restart=always recycles every
    // agent on the box when one is OOM-killed.
    expect(directive("OOMPolicy")).toBe("continue");
    expect(directive("Restart")).toBe("always");
    // The server raises its own descendants ABOVE itself, so the kernel takes
    // an agent and not the MainPID. `continue` cannot save a unit whose MainPID
    // dies, so without a positive stamp the line above buys nothing.
    expect(AGENT_OOM_SCORE_ADJ).toBeGreaterThan(0);
    // The kill-last tier for the server itself.
    expect(directive("OOMScoreAdjust")).toBe("-500");
    // Restart=always stops meaning always once systemd's default rate limit
    // is hit, and an OOM spike can spend five starts in seconds. Unbounded
    // retries need a backoff, or a unit that cannot start spins.
    expect(directive("StartLimitIntervalSec")).toBe("0");
    expect(Number(directive("RestartSec"))).toBeGreaterThan(0);
    // The unit runs a file the release ships. Fresh installs resolve to
    // v2026.8.22 or newer; dependency-only updates do not rewrite older units,
    // which keep the server/index.ts back-compat shim.
    const entry = directive("ExecStart").split(/\s+/).at(-1)!;
    const shipped = existsSync(new URL(`../${entry}`, import.meta.url));
    expect({ entry, shipped }).toEqual({ entry, shipped: true });
  });

  it("keeps every line a comment, a section header or a directive", () => {
    for (const line of unit.split("\n")) {
      const t = line.trim();
      if (t === "" || t.startsWith("#")) continue;
      expect(t).toMatch(/^(\[[A-Za-z]+\]|[A-Za-z][A-Za-z0-9]*=)/);
    }
  });

  // The source-level guard, so the hazard is caught before a render is needed.
  it("has no backticks or command substitution in the heredoc body", () => {
    const start = SRC.indexOf(
      "write_file /etc/systemd/system/isomux.service 644 <<EOF",
    );
    const bodyStart = SRC.indexOf("\n", start) + 1;
    const body = SRC.slice(bodyStart, SRC.indexOf("\nEOF\n", bodyStart));
    expect(body).not.toContain("`");
    expect(body).not.toContain("$(");
  });

  // systemd's own verdict where the tool exists. The EXIT STATUS is the
  // verdict; filtering stderr for two phrases would pass a unit systemd
  // rejected for a third reason.
  //
  // Two diagnostics are environment-only and are tolerated by name, because
  // they describe THIS machine rather than the unit: the isomux service account
  // does not exist on a dev box, and neither does the bun binary the unit
  // execs. Both are facts about where the test runs. Every other complaint
  // fails the test, and the tolerated ones are matched narrowly enough that a
  // real defect cannot hide behind them.
  it("passes systemd-analyze verify, where available", () => {
    const probe = Bun.spawnSync(["bash", "-c", "command -v systemd-analyze"]);
    if (probe.exitCode !== 0) return;
    const dir = mkdtempSync(join(tmpdir(), "isomux-unit-"));
    const file = join(dir, "isomux.service");
    writeFileSync(file, unit);
    const proc = Bun.spawnSync(["systemd-analyze", "verify", file]);
    const stderr = new TextDecoder().decode(proc.stderr);
    rmSync(dir, { recursive: true, force: true });

    const complaints = stderr
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter(
        (l) =>
          !/\b(User|Group)\b.*isomux.*(not found|does not exist)/i.test(l) &&
          !/Command .*bun is not executable: No such file or directory/i.test(
            l,
          ),
      );
    expect(complaints).toEqual([]);
    if (stderr === "") expect(proc.exitCode).toBe(0);
  });
});

// The backtick defect is a CLASS, not one line, and it can exist at two stages.
//
// Stage 1 is what install.sh's own shell expands. Stage 2 is what the helper
// scripts it GENERATES expand when they later run: quoting the outer delimiter
// makes those bodies literal to install.sh, which protects them then, and
// protects them not at all once the helper is installed and executed under its
// own shell.
//
// Backticks inside a heredoc that will be expanded are never intentional here -
// if substitution is wanted, $( ) says so visibly - and command substitution in
// COMMENT text is always a mistake.
describe("install.sh: no heredoc executes its own comments", () => {
  interface Block {
    startLine: number;
    delimiter: string;
    quoted: boolean;
    body: string[];
  }

  /** All heredocs in one shell body, every delimiter form. */
  function heredocs(lines: string[]): Block[] {
    const start = /<<(-?)\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/;
    const out: Block[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = start.exec(lines[i]);
      if (!m) continue;
      const dash = m[1] === "-";
      const delimiter = m[3];
      let j = i + 1;
      while (j < lines.length) {
        const t = dash ? lines[j].trim() : lines[j];
        if (t === delimiter) break;
        j++;
      }
      out.push({
        startLine: i + 1,
        delimiter,
        quoted: m[2] !== "",
        body: lines.slice(i + 1, j),
      });
      i = j;
    }
    return out;
  }

  function hazards(body: string[]): string[] {
    const found: string[] = [];
    for (const line of body) {
      if (line.includes("`")) found.push(`backtick: ${line.trim()}`);
      if (/^\s*#/.test(line) && line.includes("$(")) {
        found.push(`substitution in a comment: ${line.trim()}`);
      }
    }
    return found;
  }

  const srcLines = SRC.split("\n");
  const stage1 = heredocs(srcLines);

  it("stage 1: nothing install.sh expands carries a backtick or a substituted comment", () => {
    // The scan finds what it claims to, so a broken parser cannot pass by
    // finding nothing.
    expect(stage1.length).toBeGreaterThanOrEqual(10);
    expect(stage1.some((b) => b.quoted)).toBe(true);
    expect(stage1.some((b) => !b.quoted)).toBe(true);
    const bad = stage1
      .filter((b) => !b.quoted)
      .flatMap((b) =>
        hazards(b.body).map(
          (h) => `line ${b.startLine} (${b.delimiter}): ${h}`,
        ),
      );
    expect(bad).toEqual([]);
  });

  // The recursion the first version of this scan missed.
  it("stage 2: nothing a GENERATED helper expands carries one either", () => {
    // It actually descends: the helpers really do contain heredocs, some of
    // them expanded.
    const nested = stage1
      .filter((b) => b.quoted)
      .flatMap((b) => heredocs(b.body));
    expect(nested.length).toBeGreaterThan(0);
    expect(nested.some((b) => !b.quoted)).toBe(true);
    const bad: string[] = [];
    for (const outer of stage1.filter((b) => b.quoted)) {
      for (const inner of heredocs(outer.body)) {
        if (inner.quoted) continue; // literal when the helper runs too
        for (const h of hazards(inner.body)) {
          bad.push(
            `${outer.delimiter} line ${outer.startLine + inner.startLine} (${inner.delimiter}): ${h}`,
          );
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
