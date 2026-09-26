import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Rule = {
  names: string[];
  action: string;
  errnoRet?: number;
  args?: unknown[];
  includes?: { arches?: string[]; caps?: string[]; minKernel?: string };
  excludes?: { arches?: string[]; caps?: string[] };
};

const resolver = new URL("./seccomp/resolve.py", import.meta.url).pathname;
const committed = readFileSync(
  new URL("./seccomp/isomux-chromium-v1.json", import.meta.url),
  "utf8",
);
const profile = JSON.parse(committed) as {
  syscalls: Rule[];
  [key: string]: unknown;
};
const basis = JSON.parse(
  readFileSync(
    new URL("../container/seccomp/docker-default.json", import.meta.url),
    "utf8",
  ),
) as { syscalls: Rule[] };
const namespaceCalls = ["clone", "setns", "unshare"];

function runResolver(args: string[] = []) {
  return spawnSync("python3", [resolver, ...args], { encoding: "utf8" });
}

test("the committed Kubernetes profile is the resolver's output", () => {
  const result = runResolver();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(committed);
});

test("the Kubernetes profile has only OCI seccomp fields", () => {
  expect(Object.keys(profile).sort()).toEqual([
    "architectures",
    "defaultAction",
    "defaultErrnoRet",
    "syscalls",
  ]);
  expect(profile.architectures).toEqual([
    "SCMP_ARCH_X86_64",
    "SCMP_ARCH_X86",
    "SCMP_ARCH_X32",
  ]);
  expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
  for (const rule of profile.syscalls)
    for (const key of Object.keys(rule))
      expect(["names", "action", "errnoRet", "args"]).toContain(key);
});

test("the Kubernetes profile allows the basis's amd64 no-capability set plus the namespace calls", () => {
  // Rules that hold for amd64, no capabilities, and kernel 4.8 or later.
  const holds = (rule: Rule) =>
    !rule.excludes?.arches?.includes("amd64") &&
    (!rule.includes?.arches || rule.includes.arches.includes("amd64")) &&
    !rule.includes?.caps?.length &&
    (!rule.includes?.minKernel || rule.includes.minKernel === "4.8");
  const allowed = (rules: Rule[]) =>
    new Set(
      rules
        .filter((rule) => rule.action === "SCMP_ACT_ALLOW")
        .flatMap((rule) => rule.names),
    );
  const expected = allowed(basis.syscalls.filter(holds));
  for (const name of namespaceCalls) expected.add(name);
  expect([...allowed(profile.syscalls)].sort()).toEqual([...expected].sort());

  // Names that only capability-gated rules allow stay denied.
  for (const name of ["bpf", "perf_event_open", "mount", "reboot", "kcmp"])
    expect(allowed(profile.syscalls).has(name)).toBe(false);
  // Rules for other architectures are gone.
  for (const name of ["s390_runtime_instr", "arm_fadvise64_64"])
    expect(allowed(profile.syscalls).has(name)).toBe(false);
  expect(profile.syscalls).toContainEqual({
    names: ["clone3"],
    action: "SCMP_ACT_ERRNO",
    errnoRet: 38,
  });
});

test("the resolver refuses a condition it does not know", () => {
  const dir = mkdtempSync(join(tmpdir(), "isomux-seccomp-"));
  const path = join(dir, "profile.json");
  writeFileSync(
    path,
    JSON.stringify({
      defaultAction: "SCMP_ACT_ERRNO",
      defaultErrnoRet: 1,
      archMap: [
        { architecture: "SCMP_ARCH_X86_64", subArchitectures: [] },
      ],
      syscalls: [
        {
          names: ["read"],
          action: "SCMP_ACT_ALLOW",
          includes: { os: "linux" },
        },
      ],
    }),
  );
  const result = runResolver([path]);
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe("");
});
