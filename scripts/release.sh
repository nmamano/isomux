#!/usr/bin/env bash
# Tag and publish an isomux release (release-channel slice C1, see
# internal-docs/release-design.md).
#
# A release is an annotated CalVer tag - vYYYY.M.D, with a .N suffix from the
# second tag of a day - on a commit CI has already checked, plus a GitHub
# Release with auto-generated notes (which is what the installer's
# releases/latest default resolves).
#
# Usage:
#   scripts/release.sh            # next free tag for today's date
#   scripts/release.sh v2026.7.19 # explicit tag
#
# Gates, in order: clean checkout; HEAD published on origin's main; the
# Build workflow (.github/workflows/build.yml) completed green for HEAD - 
# specifically that workflow, so an unrelated green check can never stand in
# for CI; the bun pin unchanged since the previous release (customer
# updaters only WARN on a bun mismatch and roll back on the installed bun,
# so a pin change needs a fleet plan - override with
# RELEASE_ALLOW_BUN_CHANGE=1); tag free both locally and on origin.
#
# RELEASE_SKIP_CI=1 skips the CI gate AND the GitHub Release step so the
# script can run against a local bare origin (sandbox testing). Never set it
# for a real release. RELEASE_GH_REPO=owner/repo overrides the origin-URL
# GitHub detection (SSH-alias remotes, testing with a stubbed gh).

set -Eeuo pipefail

log() { printf '[isomux-release] %s\n' "$*"; }
die() {
  log "ERROR: $*"
  exit 1
}

TAG="${1:-}"
SKIP_CI="${RELEASE_SKIP_CI:-}"
CALVER_RE='^v[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}(\.[0-9]+)?$'

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git checkout"
cd "$ROOT"

[[ -z $(git status --porcelain) ]] || die "checkout is dirty; commit or stash first"

git fetch --tags origin

tag_exists() {
  git rev-parse -q --verify "refs/tags/$1" >/dev/null ||
    [[ -n $(git ls-remote --tags origin "refs/tags/$1") ]]
}

if [[ -n $TAG ]]; then
  [[ $TAG =~ $CALVER_RE ]] || die "not a CalVer tag (vYYYY.M.D[.N]): $TAG"
  tag_exists "$TAG" && die "tag $TAG already exists; releases are immutable - pick the next free tag"
else
  base="v$(date +%Y.%-m.%-d)"
  TAG=$base
  n=2
  while tag_exists "$TAG"; do
    TAG="$base.$n"
    n=$((n + 1))
  done
fi

HEAD_SHA=$(git rev-parse HEAD)

# The commit must be published on origin's main: CI runs on pushes, and an
# unpushed commit has no check-runs to gate on.
git merge-base --is-ancestor "$HEAD_SHA" origin/main ||
  die "HEAD is not on origin/main; push first"
[[ $HEAD_SHA == $(git rev-parse origin/main) ]] ||
  log "note: HEAD is not the tip of origin/main; tagging the older commit $HEAD_SHA"

# CI gate. Owner/repo comes from the origin URL; non-GitHub origins can't be
# CI-checked and are refused unless the sandbox flag is set.
ORIGIN_URL=$(git remote get-url origin)
OWNER_REPO=""
if [[ $ORIGIN_URL =~ ^https://github\.com/([^/]+/[^/]+)$ ]] ||
  [[ $ORIGIN_URL =~ ^git@github\.com:([^/]+/[^/]+)$ ]]; then
  OWNER_REPO=${BASH_REMATCH[1]%.git}
fi

OWNER_REPO=${RELEASE_GH_REPO:-$OWNER_REPO}

if [[ -n $SKIP_CI ]]; then
  log "RELEASE_SKIP_CI set: skipping the CI gate and the GitHub Release (sandbox mode)"
else
  [[ -n $OWNER_REPO ]] || die "origin is not a github.com repo; cannot verify CI (set RELEASE_GH_REPO=owner/repo, or RELEASE_SKIP_CI=1 only for sandbox testing)"
  command -v gh >/dev/null || die "gh is required to verify CI"
  command -v jq >/dev/null || die "jq is required to verify CI"
  # Gate on OUR Build workflow by path, not on "some green check": with
  # check-runs alone, any unrelated green check would pass a commit whose
  # Build workflow never ran.
  runs=$(gh api "repos/$OWNER_REPO/actions/runs?head_sha=$HEAD_SHA&per_page=100" \
    --jq '[.workflow_runs[] | select(.path == ".github/workflows/build.yml")]')
  total=$(jq 'length' <<<"$runs")
  ((total > 0)) || die "no Build workflow run (.github/workflows/build.yml) found for $HEAD_SHA; has CI started?"
  latest=$(jq -r 'sort_by(.run_number) | last | .status + "/" + (.conclusion // "pending")' <<<"$runs")
  [[ $latest == "completed/success" ]] || die "the Build workflow for $HEAD_SHA is not green: $latest"
  log "CI green for $HEAD_SHA (Build workflow completed/success)"
fi

# Bun-pin invariant: customer updaters only warn when a release pins a
# different bun than the box runs, and a failed start rolls back on the
# INSTALLED bun - so until versioned side-by-side runtimes exist, a release
# must not change the pin silently.
bun_pin_at() {
  # || true: a ref without package.json is "no pin", not a fatal error
  # (pipefail would otherwise propagate git's failure).
  { git show "$1:package.json" 2>/dev/null || true; } |
    sed -n 's/.*"packageManager": *"bun@\([^"]*\)".*/\1/p' | head -1
}
# The previous release comes from ORIGIN's tag namespace, and is read via
# its remote-reported commit sha - a CalVer tag planted locally (higher, or
# shadowing the real name) must not become the comparison baseline. Peeled
# ^{} lines give the commit for annotated tags; a bare line covers a
# lightweight tag.
REMOTE_TAGS=$(git ls-remote --tags origin)
PREV_TAG=$(sed -n 's#^[0-9a-f]*\trefs/tags/\(v[0-9][^^]*\)$#\1#p' <<<"$REMOTE_TAGS" |
  grep -E "$CALVER_RE" | sort -V | tail -1) || PREV_TAG=""
if [[ -n $PREV_TAG ]]; then
  PREV_SHA=$(awk -v t="refs/tags/$PREV_TAG^{}" '$2 == t { print $1 }' <<<"$REMOTE_TAGS")
  [[ -n $PREV_SHA ]] || PREV_SHA=$(awk -v t="refs/tags/$PREV_TAG" '$2 == t { print $1 }' <<<"$REMOTE_TAGS")
  prev_pin=$(bun_pin_at "$PREV_SHA")
  new_pin=$(bun_pin_at HEAD)
  if [[ $prev_pin != "$new_pin" && -z ${RELEASE_ALLOW_BUN_CHANGE:-} ]]; then
    die "the bun pin changed since $PREV_TAG (bun@${prev_pin:-none} -> bun@${new_pin:-none}); updaters warn-only on mismatch, so ship this only with a fleet plan (RELEASE_ALLOW_BUN_CHANGE=1 to proceed)"
  fi
fi

git tag -a "$TAG" -m "isomux $TAG"
git push origin "refs/tags/$TAG"
log "tagged and pushed $TAG ($HEAD_SHA)"

if [[ -z $SKIP_CI ]]; then
  gh release create "$TAG" --verify-tag --generate-notes --title "$TAG" ||
    die "tag pushed, but creating the GitHub Release failed; re-run: gh release create $TAG --verify-tag --generate-notes --title $TAG"
  log "GitHub Release created: $TAG"
fi
