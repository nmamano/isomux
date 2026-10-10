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
    echo "Path exists and is not a Git worktree: $worktree_path" >&2
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
