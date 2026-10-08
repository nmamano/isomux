import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AGENT_ROOT } from "../../split/roots.ts";
import {
  classifyCodexSandboxProbe,
  codexSandboxProbe,
  effectiveCodexSandbox,
  resetCodexSandboxProbeForTests,
  runCodexSandboxProbe,
} from "./sandbox-probe.ts";

const savedSupervisor = process.env.ISOMUX_APP_SUPERVISOR;
afterEach(() => {
  resetCodexSandboxProbeForTests();
  if (savedSupervisor === undefined) delete process.env.ISOMUX_APP_SUPERVISOR;
  else process.env.ISOMUX_APP_SUPERVISOR = savedSupervisor;
});

// The messages bwrap printed when the platform refused it (2026-10-08).
const SECCOMP_DENIAL =
  "bwrap: Failed to make / slave: Operation not permitted\n";
const APPARMOR_DENIAL = "bwrap: Failed to make / slave: Permission denied\n";
const PIVOT_ROOT_DENIAL = "bwrap: pivot_root: Operation not permitted\n";
const USERNS_DENIAL =
  "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n";

describe("classifyCodexSandboxProbe", () => {
  it("a zero exit means the sandbox works", () => {
    expect(classifyCodexSandboxProbe(0, "")).toBe("available");
  });

  it("only a bwrap denial counts as denied", () => {
    for (const stderr of [
      SECCOMP_DENIAL,
      APPARMOR_DENIAL,
      PIVOT_ROOT_DENIAL,
      USERNS_DENIAL,
    ])
      expect(classifyCodexSandboxProbe(1, stderr)).toBe("denied");
    expect(
      classifyCodexSandboxProbe(
        1,
        "bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.\n",
      ),
    ).toBe("denied");
  });

  it("any other failure is unknown", () => {
    // bwrap could not start Codex's helper: a setup fault, not a denial, even
    // with a permission errno (bwrap's form, seen 2026-10-08).
    for (const stderr of [
      "bwrap: execvp codex-linux-sandbox: No such file or directory\n",
      "bwrap: execvp codex-linux-sandbox: Permission denied\n",
      "bwrap: execvp /var/data/no-exec: Operation not permitted\n",
      "Error: Permission denied (os error 13)\n",
      "Failed to make / slave: Operation not permitted\n",
    ])
      expect(classifyCodexSandboxProbe(1, stderr)).toBe("unknown");
    expect(classifyCodexSandboxProbe(101, "thread 'main' panicked\n")).toBe(
      "unknown",
    );
    expect(classifyCodexSandboxProbe(2, "error: unexpected argument\n")).toBe(
      "unknown",
    );
    expect(classifyCodexSandboxProbe(null, SECCOMP_DENIAL)).toBe("unknown");
  });
});

describe("codexSandboxProbe", () => {
  it("does not probe outside a container", async () => {
    delete process.env.ISOMUX_APP_SUPERVISOR;
    let runs = 0;
    const result = await codexSandboxProbe(async () => {
      runs++;
      return { result: "denied", detail: "" };
    });
    expect(result).toBe("available");
    expect(runs).toBe(0);
  });

  it("probes once per process in a container", async () => {
    process.env.ISOMUX_APP_SUPERVISOR = "container";
    let runs = 0;
    const run = async () => {
      runs++;
      return { result: "denied" as const, detail: "" };
    };
    expect(await codexSandboxProbe(run)).toBe("denied");
    expect(await codexSandboxProbe(run)).toBe("denied");
    expect(runs).toBe(1);
  });

  it("a probe that throws resolves to unknown", async () => {
    process.env.ISOMUX_APP_SUPERVISOR = "container";
    const result = await codexSandboxProbe(() =>
      Promise.reject(new Error("launcher missing")),
    );
    expect(result).toBe("unknown");
  });
});

describe("effectiveCodexSandbox", () => {
  function seed(result: "available" | "denied" | "unknown") {
    process.env.ISOMUX_APP_SUPERVISOR = "container";
    return codexSandboxProbe(async () => ({ result, detail: "" }));
  }

  it("a proved denial runs sandboxed modes with full access", async () => {
    await seed("denied");
    for (const mode of ["read-only", "workspace-write"])
      expect(await effectiveCodexSandbox(mode)).toEqual({
        sandbox: "danger-full-access",
        fellBack: true,
      });
    expect(await effectiveCodexSandbox("danger-full-access")).toEqual({
      sandbox: "danger-full-access",
      fellBack: false,
    });
  });

  it("an unknown or working probe keeps the requested mode", async () => {
    for (const result of ["available", "unknown"] as const) {
      resetCodexSandboxProbeForTests();
      await seed(result);
      expect(await effectiveCodexSandbox("read-only")).toEqual({
        sandbox: "read-only",
        fellBack: false,
      });
    }
  });
});

describe("runCodexSandboxProbe", () => {
  function script(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "isomux-sandbox-probe-"));
    const path = join(dir, "probe.sh");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }
  const scratch = () => mkdtempSync(join(tmpdir(), "isomux-sandbox-probe-"));

  it("runs each probe in a new CODEX_HOME holding only an empty config", async () => {
    // A config left in the probe area by an earlier version or boot.
    const probeRoot = join(AGENT_ROOT, "codex-sandbox-probe");
    mkdirSync(probeRoot, { recursive: true });
    writeFileSync(join(probeRoot, "config.toml"), "sandbox_mode = [\n");
    const homes: string[] = [];
    for (let i = 0; i < 2; i++) {
      const out = join(scratch(), "seen");
      const probe = script(
        `{ echo "$CODEX_HOME"; ls -A "$CODEX_HOME"; wc -c < "$CODEX_HOME/config.toml"; } > ${out}; printf '${SECCOMP_DENIAL.trim()}\\n' >&2; exit 1`,
      );
      const { result } = await runCodexSandboxProbe({ argv: [probe] });
      expect(result).toBe("denied");
      const [home, listing, size] = readFileSync(out, "utf8")
        .trim()
        .split("\n");
      expect(home.startsWith(`${probeRoot}/`)).toBe(true);
      expect(listing).toBe("config.toml");
      expect(size.trim()).toBe("0");
      // Removed after the probe; what was there before is left alone.
      expect(existsSync(home)).toBe(false);
      homes.push(home);
    }
    expect(homes[0]).not.toBe(homes[1]);
    expect(readFileSync(join(probeRoot, "config.toml"), "utf8")).toBe(
      "sandbox_mode = [\n",
    );
  });

  it("kills the whole process group of a probe that runs too long", async () => {
    const pidFile = join(scratch(), "pid");
    // The child keeps no pipe of the probe's open, so killing only the leader
    // would end the probe and leave the child running.
    const probe = script(
      `sleep 30 </dev/null >/dev/null 2>&1 & echo $! > ${pidFile}; wait`,
    );
    const { result } = await runCodexSandboxProbe({
      argv: [probe],
      timeoutMs: 300,
    });
    expect(result).toBe("unknown");
    const pid = Number(readFileSync(pidFile, "utf8"));
    // Dead means gone or a zombie that its new parent has not reaped yet.
    const state = () => {
      try {
        return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0];
      } catch {
        return "gone";
      }
    };
    try {
      const deadline = Date.now() + 2000;
      while (!["gone", "Z", "X"].includes(state()) && Date.now() < deadline)
        await Bun.sleep(20);
      expect(["gone", "Z", "X"]).toContain(state());
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  });

  it("a probe that cannot start reports unknown", async () => {
    const { result } = await runCodexSandboxProbe({
      argv: ["/nonexistent/codex"],
    });
    expect(result).toBe("unknown");
  });
});
