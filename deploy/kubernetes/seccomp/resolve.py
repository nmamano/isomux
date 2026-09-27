#!/usr/bin/env python3
"""Resolve the Docker-format Chromium seccomp profile into an OCI profile.

containerd reads a Kubernetes Localhost profile as OCI LinuxSeccomp, which has
no archMap and no per-rule includes/excludes. Resolve those conditions here,
the way Moby does, for one node architecture (amd64 or arm64), kernel 4.8 or
later, and only CAP_SYS_CHROOT among capability conditions.
Usage: resolve.py ARCH [DOCKER_PROFILE] > ARCH/isomux-chromium-v1.json
"""
import json
import pathlib
import sys

# Moby matches includes/excludes arches against Go's GOARCH name.
ARCHES = {"amd64": "SCMP_ARCH_X86_64", "arm64": "SCMP_ARCH_AARCH64"}
# The office container drops ALL capabilities, but Chromium's sandbox calls
# chroot inside its own user namespace. Docker allows chroot through its
# default CAP_SYS_CHROOT; resolve as if that one capability were present.
CAPABILITIES = ("CAP_SYS_CHROOT",)
KERNEL = (4, 8)  # Lowest kernel we resolve minKernel conditions for.
SOURCE = pathlib.Path(__file__).resolve().parents[2] / "container/seccomp/chromium.json"


def kernel_at_least(version):
    return tuple(int(part) for part in version.split(".")) <= KERNEL


def keep(rule, arch):
    includes = rule.get("includes") or {}
    excludes = rule.get("excludes") or {}
    unknown = (set(includes) | set(excludes)) - {"arches", "caps", "minKernel"}
    if unknown:
        raise ValueError(f"Unknown seccomp condition: {sorted(unknown)}")
    if arch in excludes.get("arches", []):
        return False
    if includes.get("arches") and arch not in includes["arches"]:
        return False
    if any(cap in CAPABILITIES for cap in excludes.get("caps", [])):
        return False
    if any(cap not in CAPABILITIES for cap in includes.get("caps", [])):
        return False
    if "minKernel" in includes and not kernel_at_least(includes["minKernel"]):
        return False
    return True


def resolve(profile, arch):
    allowed = {"defaultAction", "defaultErrnoRet", "archMap", "syscalls"}
    if set(profile) - allowed:
        raise ValueError(f"Unknown profile field: {sorted(set(profile) - allowed)}")
    seccomp_arch = ARCHES[arch]
    arches = [entry for entry in profile["archMap"] if entry["architecture"] == seccomp_arch]
    if len(arches) != 1:
        raise ValueError(f"Profile must map exactly one {arch} architecture")
    result = {
        "defaultAction": profile["defaultAction"],
        "defaultErrnoRet": profile["defaultErrnoRet"],
        "architectures": [seccomp_arch, *arches[0]["subArchitectures"]],
        "syscalls": [],
    }
    for rule in profile["syscalls"]:
        if not keep(rule, arch):
            continue
        extra = set(rule) - {"names", "action", "errnoRet", "args", "comment", "includes", "excludes"}
        if extra:
            raise ValueError(f"Unknown syscall field: {sorted(extra)}")
        resolved = {"names": rule["names"], "action": rule["action"]}
        if "errnoRet" in rule:
            resolved["errnoRet"] = rule["errnoRet"]
        if rule.get("args"):
            resolved["args"] = rule["args"]
        result["syscalls"].append(resolved)
    return result


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3) or sys.argv[1] not in ARCHES:
        sys.exit("Usage: resolve.py amd64|arm64 [DOCKER_PROFILE]")
    source = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else SOURCE
    json.dump(resolve(json.loads(source.read_text()), sys.argv[1]), sys.stdout, indent=2)
    sys.stdout.write("\n")
