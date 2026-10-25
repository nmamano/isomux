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
#   scripts/release.sh                       # ordinary release, next free tag
#   scripts/release.sh v2026.7.19            # ordinary release, explicit tag
#   scripts/release.sh --security            # marked security release
#   scripts/release.sh --security v2026.7.19 # marked security release, explicit tag
#   scripts/release.sh --notes-file note.md  # hand-written note above the generated notes
#
# The flags go before the tag, in any order. --notes-file takes the file
# verbatim; with --security the marker line follows the note. The note itself
# may not hold a marker line: only --security makes a security release.
#
# Gates, in order: clean checkout; HEAD published on origin's main; the
# Build workflow (.github/workflows/build.yml) completed green for HEAD - 
# specifically that workflow, so an unrelated green check can never stand in
# for CI; the Install smoke workflow (.github/workflows/install-smoke.yml)
# completed green for HEAD, started here when it has no run yet; tag free both
# locally and on origin. A Bun pin change needs no gate: updaters install the
# release's pinned Bun beside the old one and roll back to it.
#
# RELEASE_SKIP_CI=1 skips both workflow gates AND the GitHub Release step so the
# script can run against a local bare origin (sandbox testing). Never set it
# for a real release. RELEASE_GH_REPO=owner/repo overrides the origin-URL
# GitHub detection (SSH-alias remotes, testing with a stubbed gh).

set -Eeuo pipefail

log() { printf '[isomux-release] %s\n' "$*"; }
die() {
  log "ERROR: $*"
  exit 1
}

LOG_FILE="${TMPDIR:-/tmp}/isomux-release-$(date +%Y%m%dT%H%M%S).log"
if [[ -n ${_ISOMUX_RELEASE_LOGGED:-} ]]; then
  # The inner run keeps the outer run's log path: files named after it (the
  # release body) then share the stamp of the printed "full output" line.
  LOG_FILE=$_ISOMUX_RELEASE_LOGGED
else
  log "full output: $LOG_FILE"
  if _ISOMUX_RELEASE_LOGGED=$LOG_FILE bash "$0" "$@" 2>&1 | tee "$LOG_FILE"; then
    exit 0
  else
    status=${PIPESTATUS[0]}
    exit "$status"
  fi
fi

USAGE="usage: scripts/release.sh [--security] [--notes-file <path>] [vYYYY.M.D[.N]]"
SECURITY_RELEASE=""
NOTES_FILE=""
while [[ ${1:-} == -* ]]; do
  case $1 in
    --security) SECURITY_RELEASE=1 ;;
    --notes-file)
      [[ $# -ge 2 && -z $NOTES_FILE ]] || die "$USAGE"
      NOTES_FILE=$2
      [[ -n $NOTES_FILE ]] || die "$USAGE"
      shift
      ;;
    *) die "$USAGE" ;;
  esac
  shift
done
(( $# <= 1 )) || die "$USAGE"
TAG="${1:-}"
SKIP_CI="${RELEASE_SKIP_CI:-}"
CALVER_RE='^v[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}(\.[0-9]+)?$'
SECURITY_MARKER='isomux-severity: security'

if [[ -n $SECURITY_RELEASE && -n $SKIP_CI ]]; then
  die "--security cannot be used with RELEASE_SKIP_CI: sandbox mode creates no GitHub Release, so it cannot publish the required security marker"
fi

# The release body, composed before any tag so that a bad note or a failed
# write stops the release with nothing published. The path is relative to the
# caller's directory, so this runs before the cd to the checkout root.
BODY_FILE=""
if [[ -n $NOTES_FILE ]]; then
  [[ -z $SKIP_CI ]] ||
    die "--notes-file cannot be used with RELEASE_SKIP_CI: sandbox mode creates no GitHub Release, so it cannot publish the note"
  [[ -f $NOTES_FILE && -r $NOTES_FILE ]] || die "release note is not a readable file: $NOTES_FILE"
  [[ -n $(tr -d '[:space:]' <"$NOTES_FILE") ]] || die "release note is empty: $NOTES_FILE"
  # The checker (server/update-checker.ts) takes any line that trims to the
  # marker. Refuse a line that holds the marker and no other ASCII graphic
  # character, a superset of that rule, so a note can never make an ordinary
  # release a security release. The marker has no ERE metacharacters.
  if LC_ALL=C grep -qxE "[^!-~]*${SECURITY_MARKER}[^!-~]*" "$NOTES_FILE"; then
    die "release note holds the security marker line; remove it (--security adds the marker): $NOTES_FILE"
  fi
  BODY_FILE="${LOG_FILE%.log}-notes.md"
  {
    printf '%s\n' "$(cat "$NOTES_FILE")"
    [[ -z $SECURITY_RELEASE ]] || printf '\n%s\n' "$SECURITY_MARKER"
  } >"$BODY_FILE" || die "cannot write the release body: $BODY_FILE"
  log "release body: $BODY_FILE"
fi

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
  # Gate on OUR workflows by path, not on "some green check": with
  # check-runs alone, any unrelated green check would pass a commit whose
  # Build workflow never ran.
  runs=$(gh api "repos/$OWNER_REPO/actions/runs?head_sha=$HEAD_SHA&per_page=100" --jq '.workflow_runs')
  # latest_run PATH [TITLE_SUFFIX]: the newest run of that workflow for
  # HEAD, optionally only runs whose title ends in TITLE_SUFFIX.
  latest_run() {
    jq -r --arg path "$1" --arg suffix "${2:-}" '[.[] | select(.path == $path and ((.display_title // "") | endswith($suffix)))] |
      sort_by(.run_number) | last | if . == null then "none" else .status + "/" + (.conclusion // "pending") end' <<<"$runs"
  }
  latest=$(latest_run .github/workflows/build.yml)
  [[ $latest != none ]] || die "no Build workflow run (.github/workflows/build.yml) found for $HEAD_SHA; has CI started?"
  [[ $latest == "completed/success" ]] || die "the Build workflow for $HEAD_SHA is not green: $latest"
  log "CI green for $HEAD_SHA (Build workflow completed/success)"
  # The clean-install smoke run installs this commit along each hosting path.
  # It is not part of regular CI, so the first release attempt on a commit
  # starts it. A dispatch runs the tip of main, so only the tip can be started
  # from here. Only release-set runs count (the workflow's run-name says the
  # set): the weekly set, scheduled or started by hand, adds a check on an
  # outside service, and a red there must not hold a release.
  latest=$(latest_run .github/workflows/install-smoke.yml "(release set)")
  if [[ $latest == none ]]; then
    [[ $HEAD_SHA == $(git rev-parse origin/main) ]] ||
      die "no Install smoke run (.github/workflows/install-smoke.yml) for $HEAD_SHA, and only the tip of main can be dispatched"
    gh workflow run install-smoke.yml --repo "$OWNER_REPO" --ref main ||
      die "no Install smoke run for $HEAD_SHA, and starting one failed"
    die "no Install smoke run for $HEAD_SHA; started one. Re-run this script when it is green: https://github.com/$OWNER_REPO/actions/workflows/install-smoke.yml"
  fi
  [[ $latest == "completed/success" ]] || die "the Install smoke workflow for $HEAD_SHA is not green: $latest"
  log "install smoke green for $HEAD_SHA (Install smoke workflow completed/success)"
fi

git tag -a "$TAG" -m "isomux $TAG"
# The tag push skips the pre-push hook on purpose: the commit it points at
# was pushed through that hook already and its GitHub CI was verified above,
# so a second full run here proved nothing and cost 20 minutes per release.
git push --no-verify origin "refs/tags/$TAG"
log "tagged and pushed $TAG ($HEAD_SHA)"

if [[ -z $SKIP_CI ]]; then
  release_args=(release create "$TAG" --verify-tag --generate-notes --title "$TAG")
  recovery="gh release create $TAG --verify-tag --generate-notes --title $TAG"
  if [[ -n $BODY_FILE ]]; then
    release_args+=(--notes-file "$BODY_FILE")
    recovery+=" --notes-file $(printf '%q' "$BODY_FILE")"
  elif [[ -n $SECURITY_RELEASE ]]; then
    release_args+=(--notes "$SECURITY_MARKER")
    recovery+=" --notes '$SECURITY_MARKER'"
  fi
  gh "${release_args[@]}" ||
    die "tag pushed, but creating the GitHub Release failed; re-run: $recovery"
  log "GitHub Release created: $TAG"
fi
