#!/usr/bin/env bash
# Removes a task worktree that scripts/worktree-setup.sh made. A live worktree
# goes through `git worktree remove`; a leftover that git no longer tracks (a
# cut remove) is deleted when it has no .git entry. The branch stays.

set -euo pipefail

usage() {
  echo "Usage: scripts/worktree-remove.sh <name> [--force]" >&2
  exit 2
}

[[ $# -ge 1 && $# -le 2 ]] || usage
name=$1
force=()
if [[ $# -eq 2 ]]; then
  [[ $2 == "--force" ]] || usage
  force=(--force)
fi

repo_root=$(git rev-parse --show-toplevel)
git_dir=$(git rev-parse --absolute-git-dir)
[[ $PWD == "$repo_root" && $git_dir == "$repo_root/.git" ]] || {
  echo "Run this script from the main checkout root." >&2
  exit 1
}
git check-ref-format --branch "$name" >/dev/null
[[ $name != */* ]] || {
  echo "Worktree names cannot contain '/'." >&2
  exit 1
}

worktrees_root="$(dirname "$repo_root")/isomux-worktrees"
worktree_path="$worktrees_root/$name"

[[ ! -L $worktrees_root ]] || {
  echo "Refusing: $worktrees_root is a symbolic link." >&2
  exit 1
}

# A cut remove can leave the admin entry of a worktree whose .git file is
# gone; git lists it but cannot remove it. Prune skips locked worktrees.
git worktree prune

if [[ ! -e $worktree_path && ! -L $worktree_path ]]; then
  exit 0
fi
if [[ -L $worktree_path || ! -d $worktree_path ]]; then
  echo "Refusing: $worktree_path is a link or not a folder." >&2
  exit 1
fi

# Read the list first: grep -q in a pipe can end git with SIGPIPE, which
# pipefail turns into "not listed".
listed=$(git worktree list --porcelain)
if grep -qxF "worktree $worktree_path" <<<"$listed"; then
  exec git worktree remove "${force[@]}" "$worktree_path"
fi

if [[ -e $worktree_path/.git || -L $worktree_path/.git ]]; then
  echo "Refusing: $worktree_path has a .git entry but git does not list it as a worktree. Ask a member to check it." >&2
  exit 1
fi

rm -rf -- "$worktree_path"
git worktree prune
