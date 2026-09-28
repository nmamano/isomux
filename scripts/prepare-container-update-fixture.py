#!/usr/bin/env python3
"""Build two unpublished releases for the reviewed root updater-chain check.

Only substitution: scripts/update.sh's fixed image repository becomes the local
fixture registry. Source resolution uses the existing root-owned REPO_URL config.
No helper, unit, authorization, image revision or replacement code is replaced.

v2099.1.1 is one amd64 image, as releases were before multi-arch publication.
With --index ARM64_LAYOUT, v2099.1.2 is a multi-arch index published by
scripts/container/publish.py, so the chain updates from one to the other.
Fixture commits have fixed dates, so an arm64 machine can make the same
v2099.1.2 commit: run --arm64-layout OUT there to build that layout.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts/container"))
import publish  # noqa: E402

OUT = ROOT.parent / "container-updater-fixture-artifacts"
REGISTRY = "isomux-update-fixture-registry"
IMAGE = "localhost:15000/isomux-fixture"
TAGS = ("v2099.1.1", "v2099.1.2")


def run(*args, cwd=ROOT, **kwargs):
    return subprocess.check_output(args, cwd=cwd, text=True, **kwargs).strip()


parser = argparse.ArgumentParser()
mode = parser.add_mutually_exclusive_group()
mode.add_argument("--index", metavar="ARM64_LAYOUT", type=Path,
                  help="publish v2099.1.2 as an index with this arm64 layout")
mode.add_argument("--arm64-layout", metavar="OUT", type=Path,
                  help="on arm64: write the v2099.1.2 layout and stop")
args = parser.parse_args()
if OUT.exists():
    sys.exit("Fixture artifacts already exist; inspect and remove them before preparing again")
if run("git", "status", "--porcelain"):
    sys.exit("Commit the lane before preparing the fixture")
if not args.arm64_layout:
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
       "GIT_COMMITTER_NAME": "Updater fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
       "GIT_AUTHOR_DATE": "2099-01-01T00:00:00Z", "GIT_COMMITTER_DATE": "2099-01-01T00:00:00Z"}
run("git", "read-tree", head, cwd=origin, env=env)
run("git", "update-index", "--cacheinfo", "100755," + blob + ",scripts/update.sh", cwd=origin, env=env)
tree = run("git", "write-tree", cwd=origin, env=env)
commits = []
parent = head
for tag in TAGS:
    commit = run("git", "commit-tree", tree, "-p", parent, "-m", "Isolated updater fixture " + tag, cwd=origin, env=env)
    run("git", "update-ref", "refs/tags/" + tag, commit, cwd=origin)
    commits.append(commit)
    parent = commit
manifest = {"laneCommit": head, "fromCommit": commits[0], "toCommit": commits[1],
            "fromTag": "v2099.1.1", "toTag": "v2099.1.2", "image": IMAGE,
            "substitution": {"path": "scripts/update.sh", "before": old, "after": new}}
(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def build(tag, commit, platform):
    archive = OUT / (tag + ".tar")
    run("python3", str(ROOT / "deploy/container/context.py"), commit, str(archive), cwd=origin)
    with tarfile.open(archive) as source:
        identity = json.load(source.extractfile("version-info.json"))
        assert identity["commit"] == commit and identity["release"] == tag
    with archive.open("rb") as stream:
        subprocess.run(["docker", "build", "--memory=2g", "--platform=linux/" + platform,
                        "--build-arg", "ISOMUX_REVISION=" + commit,
                        "-f", "deploy/container/Dockerfile", "-t", IMAGE + ":" + tag, "-"],
                       cwd=ROOT, stdin=stream, check=True)


if args.arm64_layout:
    build(TAGS[1], commits[1], "arm64")
    publish.write_layout(TAGS[1], commits[1], IMAGE + ":" + TAGS[1], "arm64", args.arm64_layout)
    print("arm64 layout of " + TAGS[1] + " (" + commits[1] + ") at " + str(args.arm64_layout))
    sys.exit()
# The registry is ordinary unprivileged fixture work, never a root-access bridge.
run("docker", "run", "-d", "--name", REGISTRY, "--label", "isomux.updater-fixture=" + head,
    "--memory=256m", "-p", "127.0.0.1:15000:5000", "registry:2")
try:
    for tag, commit in zip(TAGS, commits):
        build(tag, commit, "amd64")
        if args.index and tag == TAGS[1]:
            with tempfile.TemporaryDirectory(dir=OUT) as scratch:
                amd64 = Path(scratch) / "amd64"
                publish.write_layout(tag, commit, IMAGE + ":" + tag, "amd64", amd64)
                index = publish.publish_layouts(publish.local_registry(IMAGE), tag, commit,
                                                {"amd64": amd64, "arm64": args.index})
            print(tag + " published as index " + index)
        else:
            subprocess.run(["docker", "push", IMAGE + ":" + tag], check=True)
    print("Fixture prepared at " + str(OUT) + "; lane " + head)
except BaseException:
    subprocess.run(["docker", "rm", "-f", REGISTRY], check=False, stdout=subprocess.DEVNULL)
    raise
