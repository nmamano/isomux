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

const SCRIPT = new URL("./verify-hardening.sh", import.meta.url).pathname;
const roots: string[] = [];

function fixture(options: {
  ufw?: string;
  sshd?: string;
  hardenExit?: number;
}) {
  const root = mkdtempSync(join(tmpdir(), "isomux-verify-hardening-"));
  roots.push(root);
  const bin = join(root, "bin");
  Bun.spawnSync(["mkdir", "-p", bin]);
  const calls = join(root, "calls");
  if (options.ufw !== undefined) {
    writeFileSync(
      join(bin, "ufw"),
      `#!/usr/bin/env bash
printf 'ufw %s\n' "$*" >> "$CALLS"
[[ $* == 'status verbose' ]] || exit 91
cat "$UFW_OUTPUT"
`,
    );
    chmodSync(join(bin, "ufw"), 0o755);
    writeFileSync(join(root, "ufw-output"), options.ufw);
  }
  if (options.sshd !== undefined) {
    writeFileSync(
      join(bin, "sshd"),
      `#!/usr/bin/env bash
printf 'sshd %s\n' "$*" >> "$CALLS"
[[ $* == '-T' ]] || exit 92
cat "$SSHD_OUTPUT"
`,
    );
    chmodSync(join(bin, "sshd"), 0o755);
    writeFileSync(join(root, "sshd-output"), options.sshd);
  }
  const harden = join(root, "harden");
  writeFileSync(
    harden,
    `#!/usr/bin/env bash
printf 'harden %s\n' "$*" >> "$CALLS"
[[ $* == '--check' ]] || exit 93
exit ${options.hardenExit ?? 0}
`,
  );
  chmodSync(harden, 0o755);
  const result = Bun.spawnSync(["bash", SCRIPT, "--check"], {
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      CALLS: calls,
      UFW_OUTPUT: join(root, "ufw-output"),
      SSHD_OUTPUT: join(root, "sshd-output"),
      HARDEN_TOOL: harden,
    },
  });
  return {
    code: result.exitCode,
    out: `${result.stdout.toString()}${result.stderr.toString()}`,
    calls: existsSync(calls) ? readFileSync(calls, "utf8") : "",
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const GOOD_UFW = `Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), disabled (routed)

To                         Action      From
--                         ------      ----
80/tcp                     ALLOW IN    Anywhere
443/tcp                    ALLOW IN    Anywhere
2222/tcp                   ALLOW IN    Anywhere
`;

describe("isomux-verify-hardening", () => {
  it("is quiet and not applicable when ufw is absent", () => {
    const result = fixture({ sshd: "port 2222\n" });
    expect(result.code).toBe(10);
    expect(result.out).toBe("");
    expect(result.calls).toBe("");
  });

  it("checks the live sshd port and delegates the SSH boundary", () => {
    const result = fixture({ ufw: GOOD_UFW, sshd: "port 2222\n" });
    expect(result.code).toBe(0);
    expect(result.calls).toContain("ufw status verbose");
    expect(result.calls).toContain("sshd -T");
    expect(result.calls).toContain("harden --check");
  });

  it("reports an inactive firewall without changing it", () => {
    const result = fixture({
      ufw: GOOD_UFW.replace("Status: active", "Status: inactive"),
      sshd: "port 2222\n",
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain("ufw is not active");
    expect(result.calls.split("\n").filter(Boolean)).toEqual([
      "ufw status verbose",
      "sshd -T",
      "harden --check",
    ]);
  });

  it("reports wrong defaults and missing required ports", () => {
    const result = fixture({
      ufw: GOOD_UFW.replace("deny (incoming)", "allow (incoming)").replace(
        "443/tcp                    ALLOW IN    Anywhere\n",
        "",
      ),
      sshd: "port 2022\n",
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain("defaults are not deny incoming");
    expect(result.out).toContain("TCP port 443 is not allowed");
    expect(result.out).toContain("TCP port 2022 is not allowed");
  });

  it("reports a failed SSH boundary after the firewall passes", () => {
    const result = fixture({
      ufw: GOOD_UFW,
      sshd: "port 2222\n",
      hardenExit: 1,
    });
    expect(result.code).toBe(1);
    expect(result.calls).toContain("harden --check");
  });
});
