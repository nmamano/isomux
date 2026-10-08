import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
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
const committedPath = (arch: string) =>
  new URL(`./seccomp/${arch}/isomux-chromium-v1.json`, import.meta.url)
    .pathname;
const basis = JSON.parse(
  readFileSync(
    new URL("../container/seccomp/docker-default.json", import.meta.url),
    "utf8",
  ),
) as { syscalls: Rule[] };
const namespaceCalls = ["clone", "setns", "unshare"];
// Codex's bubblewrap sandbox mounts inside its own user namespace.
const bwrapCalls = ["mount", "umount2", "pivot_root"];

function runResolver(args: string[]) {
  return spawnSync("python3", [resolver, ...args], { encoding: "utf8" });
}

const allowed = (rules: Rule[]) =>
  new Set(
    rules
      .filter((rule) => rule.action === "SCMP_ACT_ALLOW")
      .flatMap((rule) => rule.names),
  );

const targets = [
  {
    arch: "amd64",
    architectures: ["SCMP_ARCH_X86_64", "SCMP_ARCH_X86", "SCMP_ARCH_X32"],
    own: ["arch_prctl", "modify_ldt"],
    foreign: ["arm_fadvise64_64", "set_tls", "cacheflush"],
  },
  {
    arch: "arm64",
    architectures: ["SCMP_ARCH_AARCH64", "SCMP_ARCH_ARM"],
    own: ["arm_fadvise64_64", "set_tls", "cacheflush"],
    foreign: ["arch_prctl", "modify_ldt"],
  },
];

test("the node profiles are exactly the two architectures", () => {
  expect(
    readdirSync(new URL("./seccomp/", import.meta.url), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(),
  ).toEqual(targets.map((target) => target.arch));
});

describe.each(targets)("$arch profile", (target) => {
  const committed = readFileSync(committedPath(target.arch), "utf8");
  const profile = JSON.parse(committed) as {
    syscalls: Rule[];
    [key: string]: unknown;
  };

  test("the committed Kubernetes profile is the resolver's output", () => {
    const result = runResolver([target.arch]);
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
    expect(profile.architectures).toEqual(target.architectures);
    expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
    for (const rule of profile.syscalls)
      for (const key of Object.keys(rule))
        expect(["names", "action", "errnoRet", "args"]).toContain(key);
  });

  test("the Kubernetes profile allows the basis's set for its architecture with only CAP_SYS_CHROOT plus the namespace and bubblewrap calls", () => {
    // Rules that hold for this architecture, only CAP_SYS_CHROOT, and kernel
    // 4.8 or later.
    const holds = (rule: Rule) =>
      !rule.excludes?.arches?.includes(target.arch) &&
      (!rule.includes?.arches || rule.includes.arches.includes(target.arch)) &&
      (rule.includes?.caps ?? []).every((cap) => cap === "CAP_SYS_CHROOT") &&
      (!rule.includes?.minKernel || rule.includes.minKernel === "4.8");
    const expected = allowed(basis.syscalls.filter(holds));
    for (const name of namespaceCalls) expected.add(name);
    // The bubblewrap calls are the only names beyond the earlier profile's set.
    for (const name of bwrapCalls) expect(expected.has(name)).toBe(false);
    for (const name of bwrapCalls) expected.add(name);
    expect([...allowed(profile.syscalls)].sort()).toEqual([...expected].sort());

    // Names that only capability-gated rules allow stay denied.
    // Chromium's sandbox calls chroot inside its user namespace.
    expect(allowed(profile.syscalls).has("chroot")).toBe(true);
    for (const name of ["bpf", "perf_event_open", "reboot", "kcmp"])
      expect(allowed(profile.syscalls).has(name)).toBe(false);
    // The new mount API stays denied: bubblewrap needs only mount(2).
    for (const name of [
      "fsopen",
      "fsconfig",
      "fsmount",
      "fspick",
      "move_mount",
      "open_tree",
      "mount_setattr",
      "umount",
    ])
      expect(allowed(profile.syscalls).has(name)).toBe(false);
    // Rules for this architecture stay; rules for other architectures are gone.
    for (const name of target.own)
      expect(allowed(profile.syscalls).has(name)).toBe(true);
    for (const name of ["s390_runtime_instr", ...target.foreign])
      expect(allowed(profile.syscalls).has(name)).toBe(false);
    expect(profile.syscalls).toContainEqual({
      names: ["clone3"],
      action: "SCMP_ACT_ERRNO",
      errnoRet: 38,
    });
  });
});

test("the resolver refuses an architecture it does not know", () => {
  for (const args of [[], ["riscv64"]]) {
    const result = runResolver(args);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  }
});

test("the resolver refuses a condition it does not know", () => {
  const dir = mkdtempSync(join(tmpdir(), "isomux-seccomp-"));
  const path = join(dir, "profile.json");
  writeFileSync(
    path,
    JSON.stringify({
      defaultAction: "SCMP_ACT_ERRNO",
      defaultErrnoRet: 1,
      archMap: [{ architecture: "SCMP_ARCH_X86_64", subArchitectures: [] }],
      syscalls: [
        {
          names: ["read"],
          action: "SCMP_ACT_ALLOW",
          includes: { os: "linux" },
        },
      ],
    }),
  );
  const result = runResolver(["amd64", path]);
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe("");
});

type PodSpec = {
  nodeSelector: Record<string, string>;
  affinity: unknown;
  containers: {
    command: string[];
    readinessProbe: { exec: { command: string[] } };
  }[];
};
const podSpec = (file: string) =>
  (
    Bun.YAML.parse(readFileSync(new URL(file, import.meta.url), "utf8")) as {
      spec: { template: { spec: PodSpec } };
    }
  ).spec.template.spec;

test("the office and the installer schedule on amd64 and arm64 nodes only", () => {
  for (const file of ["./deployment.yaml", "./seccomp-installer.yaml"]) {
    const spec = podSpec(file);
    expect(spec.nodeSelector).toEqual({
      "kubernetes.io/os": "linux",
      "isomux.com/office-node": "true",
    });
    expect(spec.affinity).toEqual({
      nodeAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: {
          nodeSelectorTerms: [
            {
              matchExpressions: [
                {
                  key: "kubernetes.io/arch",
                  operator: "In",
                  values: ["amd64", "arm64"],
                },
              ],
            },
          ],
        },
      },
    });
  }
});

describe("seccomp installer", () => {
  const installer = podSpec("./seccomp-installer.yaml").containers[0];
  // The ConfigMap keys and files, as the kustomization generates them.
  const files = (
    Bun.YAML.parse(
      readFileSync(new URL("./kustomization.yaml", import.meta.url), "utf8"),
    ) as { configMapGenerator: { name: string; files?: string[] }[] }
  ).configMapGenerator
    .find((generator) => generator.name === "isomux-seccomp")!
    .files!.map((entry) => entry.split("="));

  // Runs the installer's and the probe's own scripts with the two mounts
  // under a temporary directory, and `uname -m` reporting `machine`.
  function node(machine: string) {
    const dir = mkdtempSync(join(tmpdir(), "isomux-seccomp-node-"));
    mkdirSync(join(dir, "profile"));
    mkdirSync(join(dir, "host"));
    mkdirSync(join(dir, "bin"));
    for (const [key, file] of files)
      writeFileSync(
        join(dir, "profile", key),
        readFileSync(new URL(file, import.meta.url)),
      );
    writeFileSync(
      join(dir, "bin", "uname"),
      `#!/bin/sh\n[ "$1" = -m ] && echo ${machine}\n`,
    );
    writeFileSync(join(dir, "bin", "sleep"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, "bin", "uname"), 0o755);
    chmodSync(join(dir, "bin", "sleep"), 0o755);
    const run = (command: string[]) =>
      spawnSync(
        command[0],
        command
          .slice(1)
          .map((arg) =>
            arg
              .replaceAll("/profile/", `${dir}/profile/`)
              .replaceAll("/host/", `${dir}/host/`),
          ),
        {
          encoding: "utf8",
          env: { PATH: `${dir}/bin:${process.env.PATH}` },
        },
      );
    const hostFile = join(dir, "host", "isomux-chromium-v1.json");
    return {
      install: () => run(installer.command),
      ready: () => run(installer.readinessProbe.exec.command).status === 0,
      hostFile,
      host: () => readdirSync(join(dir, "host")),
    };
  }

  test("the ConfigMap keys are the uname names of the two profiles", () => {
    expect(files).toEqual([
      ["x86_64.json", "seccomp/amd64/isomux-chromium-v1.json"],
      ["aarch64.json", "seccomp/arm64/isomux-chromium-v1.json"],
    ]);
  });

  test.each([
    ["x86_64", "amd64"],
    ["aarch64", "arm64"],
  ])("a %s node gets the %s profile and is ready", (machine, arch) => {
    const fixture = node(machine);
    expect(fixture.install().status).toBe(0);
    expect(fixture.host()).toEqual(["isomux-chromium-v1.json"]);
    expect(readFileSync(fixture.hostFile, "utf8")).toBe(
      readFileSync(committedPath(arch), "utf8"),
    );
    expect(fixture.ready()).toBe(true);
  });

  test("a node holding the other architecture's profile is not ready", () => {
    const fixture = node("aarch64");
    writeFileSync(fixture.hostFile, readFileSync(committedPath("amd64")));
    expect(fixture.ready()).toBe(false);
  });

  test("a node of another architecture gets no file and is not ready", () => {
    const fixture = node("riscv64");
    expect(fixture.install().status).not.toBe(0);
    expect(fixture.host()).toEqual([]);
    expect(existsSync(fixture.hostFile)).toBe(false);
    expect(fixture.ready()).toBe(false);
  });
});
