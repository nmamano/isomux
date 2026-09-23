#!/usr/bin/env python3
"""Export only allowed, committed regular files. Never read worktree contents."""
import io
import json
import re
import pathlib
import subprocess
import sys
import tarfile

ROOTS = ("server/", "shared/", "ui/", "browser-extension/", "skills/", "deploy/container/")
FILES = {
    "LICENSE", "package.json", "bun.lock", "api/chat.ts", "site/screenshot.png",
    "scripts/build.sh", "scripts/build-browser-extension.ts", "scripts/extension-zip.ts",
    "deploy/render/Dockerfile", "deploy/render/Dockerfile.dockerignore",
}


def allowed(path):
    parts = pathlib.PurePosixPath(path).parts
    return (
        (path in FILES or path.startswith(ROOTS))
        and not any(part in ("private", "node_modules", "dist", "__pycache__") or part.startswith(".env") for part in parts)
        and not path.endswith((".test.ts", ".test.tsx", "_test.py", ".log"))
        and not path.startswith("server/test-support/")
    )


def export(revision, destination):
    commit = subprocess.check_output(["git", "rev-parse", "--verify", revision + "^{commit}"], text=True).strip()
    entries = subprocess.check_output(["git", "ls-tree", "-rz", "--full-tree", commit]).split(b"\0")
    tags = subprocess.check_output(["git", "tag", "--points-at", commit], text=True).splitlines()
    releases = [tag for tag in tags if re.fullmatch(r"v[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}(\.[0-9]+)?", tag)]
    release = max(releases, key=lambda tag: tuple(map(int, tag[1:].split(".")))) if releases else None
    identity = {"commit": commit, "release": release, "version": release or commit}
    with tarfile.open(destination, "x") as archive:
        data = json.dumps(identity).encode()
        info = tarfile.TarInfo("version-info.json")
        info.size = len(data)
        info.mode = 0o644
        archive.addfile(info, io.BytesIO(data))
        for entry in entries:
            if not entry:
                continue
            metadata, raw_path = entry.split(b"\t", 1)
            mode, kind, oid = metadata.decode().split()
            path = raw_path.decode()
            if not allowed(path):
                continue
            if kind != "blob" or mode not in ("100644", "100755"):
                raise ValueError("Production context requires regular files: " + path)
            data = subprocess.check_output(["git", "cat-file", "blob", oid])
            info = tarfile.TarInfo(path)
            info.size = len(data)
            info.mode = int(mode[-3:], 8)
            archive.addfile(info, io.BytesIO(data))
    print(commit)


if __name__ == "__main__":
    export(sys.argv[1], sys.argv[2])
