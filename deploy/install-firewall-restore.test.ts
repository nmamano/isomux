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

const INSTALL_SH = new URL("./install.sh", import.meta.url).pathname;
const roots: string[] = [];

function fixture(options: {
  status: string;
  record?: string;
  updateConf?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), "isomux-firewall-restore-"));
  roots.push(root);
  const ufw = join(root, "ufw");
  const calls = join(root, "calls");
  const record = join(root, "firewall-ports");
  const statusFile = join(root, "status");
  const updateConf = join(root, "update.conf");
  writeFileSync(statusFile, options.status);
  if (options.updateConf !== false) writeFileSync(updateConf, "managed\n");
  if (options.record !== undefined) writeFileSync(record, options.record);
  writeFileSync(
    ufw,
    `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALLS"
if [[ $* == 'status verbose' ]]; then cat "$STATUS_FILE"; fi
`,
  );
  chmodSync(ufw, 0o755);
  const script = `
eval "$(sed -n '/^restore_recorded_firewall_rules()/,/^}/p' "$INSTALL_SH")"
eval "$(sed -n '/^backfill_firewall_record()/,/^}/p' "$INSTALL_SH")"
FIREWALL_PORTS_FILE="$RECORD"
UPDATE_CONF="$UPDATE_CONF_PATH"
WEB_HTTP_RULE=80/tcp
WEB_HTTPS_RULE=443/tcp
DRY_RUN=""
log() { echo "LOG: $*"; }
outcome_add() { :; }
run() { "$@"; }
die() { echo "DIE: $*"; exit 1; }
write_file() { local path=$1 mode=$2; cat > "$path"; chmod "$mode" "$path"; }
backfill_firewall_record
restore_recorded_firewall_rules
`;
  const result = Bun.spawnSync(["bash", "-c", script], {
    env: {
      ...process.env,
      PATH: `${root}:/usr/bin:/bin`,
      INSTALL_SH,
      CALLS: calls,
      STATUS_FILE: statusFile,
      RECORD: record,
      UPDATE_CONF_PATH: updateConf,
    },
  });
  return {
    code: result.exitCode,
    out: `${result.stdout}${result.stderr}`,
    calls: existsSync(calls) ? readFileSync(calls, "utf8") : "",
    record: existsSync(record) ? readFileSync(record, "utf8") : null,
  };
}

const active = (rules: string) => `Status: active
Default: deny (incoming), allow (outgoing), disabled (routed)
${rules}`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("installer-managed firewall rule restoration", () => {
  it("restores only a missing recorded rule", () => {
    const result = fixture({
      status: active("80/tcp ALLOW IN Anywhere\n443/tcp ALLOW IN Anywhere\n"),
      record: "kind=install\n80/tcp\n443/tcp\n2222/tcp\n",
    });
    expect(result.code).toBe(0);
    expect(result.calls).toContain("allow 2222/tcp");
    expect(result.calls).not.toContain("allow 80/tcp");
    expect(result.calls).not.toContain("allow 443/tcp");
    expect(result.calls).not.toContain("enable");
    expect(result.out).toContain("restored installer-managed firewall rule");
  });

  it("leaves an inactive firewall unchanged and warns", () => {
    const result = fixture({
      status: "Status: inactive\n",
      record: "kind=install\n80/tcp\n443/tcp\n2222/tcp\n",
    });
    expect(result.code).toBe(0);
    expect(result.calls).not.toContain("allow ");
    expect(result.calls).not.toContain("enable");
    expect(result.out).toContain(
      "ISOMUX_UPDATE_WARNING=ufw is inactive; installer-managed firewall rules were not restored",
    );
  });

  it("backfills only existing web rules on a legacy box", () => {
    const result = fixture({
      status: active(
        "80/tcp ALLOW IN Anywhere\n443/tcp ALLOW IN Anywhere\n2222/tcp ALLOW IN Anywhere\n",
      ),
    });
    expect(result.code).toBe(0);
    expect(result.record).toBe("kind=backfill\n80/tcp\n443/tcp\n");
    expect(result.calls).not.toContain("allow ");
  });

  it("does not backfill a partial or inactive legacy policy", () => {
    const partial = fixture({ status: active("80/tcp ALLOW IN Anywhere\n") });
    expect(partial.record).toBeNull();
    const inactive = fixture({
      status:
        "Status: inactive\n80/tcp ALLOW IN Anywhere\n443/tcp ALLOW IN Anywhere\n",
    });
    expect(inactive.record).toBeNull();
  });

  it("does not backfill a box without updater management", () => {
    const result = fixture({
      status: active("80/tcp ALLOW IN Anywhere\n443/tcp ALLOW IN Anywhere\n"),
      updateConf: false,
    });
    expect(result.record).toBeNull();
  });

  it("refuses a malformed record instead of passing it to ufw", () => {
    const result = fixture({
      status: active(""),
      record: "kind=install\nanywhere\n",
    });
    expect(result.code).toBe(1);
    expect(result.calls).not.toContain("allow anywhere");
  });
});
