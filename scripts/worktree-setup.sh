#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: scripts/worktree-setup.sh <name> [--web]" >&2
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

(
  cd "$worktree_path"
  bun install --frozen-lockfile
)

main_pty="$repo_root/node_modules/node-pty/build/Release/pty.node"
worktree_pty="$worktree_path/node_modules/node-pty/build/Release/pty.node"
if [[ ! -e $worktree_pty ]]; then
  [[ -f $main_pty ]] || {
    echo "Missing native node-pty build in the main checkout: $main_pty" >&2
    exit 1
  }
  mkdir -p "$(dirname "$worktree_pty")"
  ln "$main_pty" "$worktree_pty" 2>/dev/null || cp "$main_pty" "$worktree_pty"
  echo "node-pty native build missing after install; supplied from the main checkout" >&2
fi

(
  cd "$worktree_path"
  bun run build:ui
  if $with_web; then
    bun install --frozen-lockfile --cwd control-plane/web
  fi
)

printf '%s\n' "$worktree_path"
