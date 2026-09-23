#!/usr/bin/env python3
"""Build two unpublished releases for the reviewed root updater-chain check.

Only substitution: scripts/update.sh's fixed image repository becomes the local
fixture registry. Source resolution uses the existing root-owned REPO_URL config.
No helper, unit, authorization, image revision or replacement code is replaced.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT.parent / "container-updater-fixture-artifacts"
REGISTRY = "isomux-update-fixture-registry"
IMAGE = "localhost:15000/isomux-fixture"


def run(*args, cwd=ROOT, **kwargs):
    return subprocess.check_output(args, cwd=cwd, text=True, **kwargs).strip()


if OUT.exists():
    sys.exit("Fixture artifacts already exist; inspect and remove them before preparing again")
if run("git", "status", "--porcelain"):
    sys.exit("Commit the lane before preparing the fixture")
if run("docker", "ps", "-aq", "--filter", "name=^/" + REGISTRY + "$"):
    sys.exit("Fixture registry name is occupied")
# Bind check before creating a registry; Docker also refuses an occupied port.
import socket
with socket.socket() as probe:
    probe.bind(("127.0.0.1", 15000))
OUT.mkdir(mode=0o700)
head = run("git", "rev-parse", "HEAD")
origin = OUT / "origin.git"
run("git", "init", "--bare", str(origin))
run("git", "fetch", "--no-tags", str(ROOT), head, cwd=origin)
old = "CONTAINER_IMAGE=ghcr.io/nmamano/isomux\n"
new = "CONTAINER_IMAGE=" + IMAGE + "\n"
updater = run("git", "show", head + ":scripts/update.sh") + "\n"
assert updater.count(old) == 1
changed = updater.replace(old, new)
blob = run("git", "hash-object", "-w", "--stdin", cwd=origin, input=changed)
env = {**os.environ, "GIT_INDEX_FILE": str(OUT / "index"),
       "GIT_AUTHOR_NAME": "Updater fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
       "GIT_COMMITTER_NAME": "Updater fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid"}
run("git", "read-tree", head, cwd=origin, env=env)
run("git", "update-index", "--cacheinfo", "100755," + blob + ",scripts/update.sh", cwd=origin, env=env)
tree = run("git", "write-tree", cwd=origin, env=env)
commits = []
parent = head
for tag in ("v2099.1.1", "v2099.1.2"):
    commit = run("git", "commit-tree", tree, "-p", parent, "-m", "Isolated updater fixture " + tag, cwd=origin, env=env)
    run("git", "update-ref", "refs/tags/" + tag, commit, cwd=origin)
    commits.append(commit)
    parent = commit
manifest = {"laneCommit": head, "fromCommit": commits[0], "toCommit": commits[1],
            "fromTag": "v2099.1.1", "toTag": "v2099.1.2", "image": IMAGE,
            "substitution": {"path": "scripts/update.sh", "before": old, "after": new}}
(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
# The registry is ordinary unprivileged fixture work, never a root-access bridge.
run("docker", "run", "-d", "--name", REGISTRY, "--label", "isomux.updater-fixture=" + head,
    "--memory=256m", "-p", "127.0.0.1:15000:5000", "registry:2")
try:
    for tag, commit in zip(("v2099.1.1", "v2099.1.2"), commits):
        archive = OUT / (tag + ".tar")
        run("python3", str(ROOT / "deploy/container/context.py"), commit, str(archive), cwd=origin)
        with tarfile.open(archive) as source:
            identity = json.load(source.extractfile("version-info.json"))
            assert identity["commit"] == commit and identity["release"] == tag
        with archive.open("rb") as stream:
            subprocess.run(["docker", "build", "--memory=2g", "--platform=linux/amd64",
                            "--build-arg", "ISOMUX_REVISION=" + commit,
                            "-f", "deploy/container/Dockerfile", "-t", IMAGE + ":" + tag, "-"],
                           cwd=ROOT, stdin=stream, check=True)
        subprocess.run(["docker", "push", IMAGE + ":" + tag], check=True)
    print("Fixture prepared at " + str(OUT) + "; lane " + head)
except BaseException:
    subprocess.run(["docker", "rm", "-f", REGISTRY], check=False, stdout=subprocess.DEVNULL)
    raise
