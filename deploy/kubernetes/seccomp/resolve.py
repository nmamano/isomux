#!/usr/bin/env python3
"""Resolve the Docker-format Chromium seccomp profile into an OCI profile.

containerd reads a Kubernetes Localhost profile as OCI LinuxSeccomp, which has
no archMap and no per-rule includes/excludes. Resolve those conditions here,
the way Moby does, for one fixed target: amd64, no capabilities, kernel 4.8 or
later. Usage: resolve.py [DOCKER_PROFILE] > isomux-chromium-v1.json
"""
import json
import pathlib
import sys

ARCH = "amd64"
SECCOMP_ARCH = "SCMP_ARCH_X86_64"
CAPABILITIES = ()  # The office container drops ALL capabilities.
KERNEL = (4, 8)  # Lowest kernel we resolve minKernel conditions for.
SOURCE = pathlib.Path(__file__).resolve().parents[2] / "container/seccomp/chromium.json"


def kernel_at_least(version):
    return tuple(int(part) for part in version.split(".")) <= KERNEL


def keep(rule):
    includes = rule.get("includes") or {}
    excludes = rule.get("excludes") or {}
    unknown = (set(includes) | set(excludes)) - {"arches", "caps", "minKernel"}
    if unknown:
        raise ValueError(f"Unknown seccomp condition: {sorted(unknown)}")
    if ARCH in excludes.get("arches", []):
        return False
    if includes.get("arches") and ARCH not in includes["arches"]:
        return False
    if any(cap in CAPABILITIES for cap in excludes.get("caps", [])):
        return False
    if any(cap not in CAPABILITIES for cap in includes.get("caps", [])):
        return False
    if "minKernel" in includes and not kernel_at_least(includes["minKernel"]):
        return False
    return True


def resolve(profile):
    allowed = {"defaultAction", "defaultErrnoRet", "archMap", "syscalls"}
    if set(profile) - allowed:
        raise ValueError(f"Unknown profile field: {sorted(set(profile) - allowed)}")
    arches = [entry for entry in profile["archMap"] if entry["architecture"] == SECCOMP_ARCH]
    if len(arches) != 1:
        raise ValueError("Profile must map exactly one amd64 architecture")
    result = {
        "defaultAction": profile["defaultAction"],
        "defaultErrnoRet": profile["defaultErrnoRet"],
        "architectures": [SECCOMP_ARCH, *arches[0]["subArchitectures"]],
        "syscalls": [],
    }
    for rule in profile["syscalls"]:
        if not keep(rule):
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
    source = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else SOURCE
    json.dump(resolve(json.loads(source.read_text())), sys.stdout, indent=2)
    sys.stdout.write("\n")
