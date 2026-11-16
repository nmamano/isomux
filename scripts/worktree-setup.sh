#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: scripts/worktree-setup.sh <name> [--web]  (--web is accepted and no longer needed)" >&2
  exit 2
}

[[ $# -ge 1 && $# -le 2 ]] || usage
name=$1
with_web=false
if [[ $# -eq 2 ]]; then
  [[ $2 == "--web" ]] || usage
  with_web=true
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

mkdir -p "$worktrees_root"
if [[ -e $worktree_path ]]; then
  existing_root=$(git -C "$worktree_path" rev-parse --show-toplevel 2>/dev/null) || {
    echo "Path exists and is not a Git worktree: $worktree_path. To remove it, run scripts/worktree-remove.sh $name." >&2
    exit 1
  }
  existing_branch=$(git -C "$worktree_path" symbolic-ref --quiet --short HEAD) || {
    echo "Existing worktree is not on a branch: $worktree_path" >&2
    exit 1
  }
  [[ $existing_root == "$worktree_path" && $existing_branch == "$name" ]] || {
    echo "Existing worktree does not match branch '$name': $worktree_path" >&2
    exit 1
  }
elif git show-ref --verify --quiet "refs/heads/$name"; then
  # A branch left from an earlier merge (a task merged in slices). Its work is
  # in main when its tip is in main's history, or when merging it would leave
  # main's tree unchanged (Isomux Main squashed it on another branch). Any
  # other branch holds work main does not have: refuse and keep it.
  old_tip=$(git rev-parse --short "refs/heads/$name")
  in_main=false
  if git merge-base --is-ancestor "refs/heads/$name" HEAD; then
    in_main=true
  else
    merge_status=0
    merged_tree=$(git merge-tree --write-tree HEAD "refs/heads/$name" 2>/dev/null) || merge_status=$?
    if [[ $merge_status -eq 0 && ${merged_tree%%$'\n'*} == "$(git rev-parse 'HEAD^{tree}')" ]]; then
      in_main=true
    fi
  fi
  if [[ $in_main == false ]]; then
    echo "Branch '$name' has work that is not in main: tip $old_tip \"$(git log -1 --format=%s "refs/heads/$name")\". Merge it, or use another worktree name." >&2
    exit 1
  fi
  echo "Branch '$name' is already in main; starting it again from main (old tip $old_tip)." >&2
  git worktree add "$worktree_path" -B "$name" HEAD
else
  git worktree add "$worktree_path" -b "$name"
fi

# Serialize dependency installs that share the package-manager cache.
install_lock=/tmp/isomux-worktree-install.lock
(
  cd "$worktree_path"
  flock "$install_lock" bun install --frozen-lockfile
)


(
  cd "$worktree_path"
  bun run build:ui
  # Root tsc reaches control-plane/web through control-plane/web-i18n.test.tsx,
  # so every lane needs the web dependencies, not only web lanes.
  flock "$install_lock" bun install --frozen-lockfile --cwd control-plane/web
)

printf '%s\n' "$worktree_path"
