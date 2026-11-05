#!/usr/bin/env bash
# isomux-bwrap-apparmor - let agents run in their own process namespace on
# Ubuntu with bubblewrap's AppArmor profile.
#
# Ubuntu's bwrap-userns-restrict profile stacks every program bwrap's children
# exec onto that program's own profile (unpriv_bwrap's "pix /** ->"). For a
# program whose own profile allows everything (flags=(unconfined), for example
# Chrome), the stack denies network sockets, so the office leaves process
# isolation off (server/process-isolation.ts). This tool writes an exact
# "allow ix <path>," rule for each such program into the unpriv_bwrap local
# override, so inside an unprivileged bwrap those programs keep the pair label
# and do not stack their own profile. Programs with an enforcing profile keep
# pix. Nothing changes outside bwrap. It also installs a canary program the
# office runs inside the namespace to see that the rule is live.
#
# deploy/install.sh installs this at /usr/local/sbin/isomux-bwrap-apparmor and
# runs it on every install and update. To run it on an office set up without
# the installer, from a checkout:
#
#   sudo bash deploy/bwrap-apparmor.sh --dry-run   # show the rules it would write
#   sudo bash deploy/bwrap-apparmor.sh
#
# NOTE FOR MAINTAINERS: this file is embedded verbatim in deploy/install.sh,
# which is downloaded and run on its own and so cannot read repo files. The
# two copies are pinned equal by deploy/install-sh.test.ts - edit here, then
# run `bun run scripts/embed-deploy-scripts.ts` to update the copy there.
#
# Usage (as root):
#   isomux-bwrap-apparmor             apply
#   isomux-bwrap-apparmor --dry-run   print what it would write, change nothing
#   isomux-bwrap-apparmor --help
#
# Exit 0: applied, or nothing to do on this box. Exit 1: refused or failed;
# the unpriv_bwrap override is left as it was.

set -Eeuo pipefail

TAG=isomux-bwrap-apparmor
DRY_RUN=""
# Seams for deploy/bwrap-apparmor.test.ts.
APPARMOR_DIR=${APPARMOR_DIR:-/etc/apparmor.d}
CANARY=${CANARY:-/usr/local/lib/isomux/apparmor-canary}
APPARMOR_PROFILES=${APPARMOR_PROFILES:-/sys/kernel/security/apparmor/profiles}

BWRAP_PROFILE=$APPARMOR_DIR/bwrap-userns-restrict
BWRAP_PROFILE_DISABLED=$APPARMOR_DIR/disable/bwrap-userns-restrict
OVERRIDE=$APPARMOR_DIR/local/unpriv_bwrap
CANARY_PROFILE_NAME=isomux-apparmor-canary
CANARY_PROFILE=$APPARMOR_DIR/$CANARY_PROFILE_NAME
BEGIN_MARK="# BEGIN isomux-bwrap-apparmor"
END_MARK="# END isomux-bwrap-apparmor"
# The value Ubuntu gives @{multiarch} in tunables/multiarch.
MULTIARCH_GLOB='*-linux-gnu*'
# A path AppArmor reads without quotes.
PLAIN_PATH='^[[:alnum:]/._+-]+$'

log() { printf '[%s] %s\n' "$TAG" "$*"; }

usage() {
  cat <<USAGE
Usage: $TAG [--dry-run]

Writes an exact "allow ix" rule for each AppArmor profile that allows
everything into $OVERRIDE, installs the canary
$CANARY, and reloads bwrap-userns-restrict.
USAGE
}

# The attach path of each profile in the top-level files of APPARMOR_DIR whose
# flags hold "unconfined", as written (quotes removed), one per line. grep
# picks the candidate lines first: bash's regex over every line of every
# profile is slow.
unconfined_attach_paths() {
  local file line token flags files=()
  local profile_re='^[[:space:]]*profile[[:space:]]+("[^"]*"|[^[:space:]"]+)[[:space:]]+("[^"]*"|[/@][^[:space:]"]*)[[:space:]]+flags=\(([^)]*)\)'
  local bare_re='^[[:space:]]*("[^"]*"|/[^[:space:]"]*)[[:space:]]+flags=\(([^)]*)\)'
  for file in "$APPARMOR_DIR"/*; do
    if [[ -f $file ]]; then files+=("$file"); fi
  done
  ((${#files[@]} > 0)) || return 0
  while IFS= read -r line; do
    if [[ $line =~ $profile_re ]]; then
      token=${BASH_REMATCH[2]} flags=${BASH_REMATCH[3]}
    elif [[ $line =~ $bare_re ]]; then
      token=${BASH_REMATCH[1]} flags=${BASH_REMATCH[2]}
    else
      continue
    fi
    [[ ,${flags//[[:space:]]/}, == *,unconfined,* ]] || continue
    token=${token#\"}
    printf '%s\n' "${token%\"}"
  done < <(grep -h -s -E 'flags=\([^)]*unconfined' "${files[@]}" || true)
}

# AppArmor's {a,b} alternation, nested and with empty alternatives. Appends
# each result to EXPANDED: no subshell per path, which costs a fork each.
expand_braces() {
  local s=$1 i c depth=0 start=-1 end=-1
  for ((i = 0; i < ${#s}; i++)); do
    c=${s:i:1}
    if [[ $c == "{" ]]; then
      if ((depth == 0)); then start=$i; fi
      depth=$((depth + 1))
    elif [[ $c == "}" ]] && ((depth > 0)); then
      depth=$((depth - 1))
      if ((depth == 0)); then
        end=$i
        break
      fi
    fi
  done
  if ((end < 0)); then
    EXPANDED+=("$s")
    return 0
  fi
  local prefix=${s:0:start} body=${s:start+1:end-start-1} suffix=${s:end+1}
  local part="" alts=()
  depth=0
  for ((i = 0; i < ${#body}; i++)); do
    c=${body:i:1}
    case $c in
      "{") depth=$((depth + 1)) part+=$c ;;
      "}") depth=$((depth - 1)) part+=$c ;;
      ",")
        if ((depth == 0)); then
          alts+=("$part")
          part=""
        else
          part+=$c
        fi
        ;;
      *) part+=$c ;;
    esac
  done
  alts+=("$part")
  for part in "${alts[@]}"; do
    expand_braces "$prefix$part$suffix"
  done
}

# One attach path as the exact paths it names, appended to EXACT. A result
# without a wildcard is exact and listed whether or not it exists, so a
# program installed later is covered; a result with one names the files that
# exist now. A rule is never a glob: anything still a pattern is dropped later.
exact_paths() {
  local attach=$1 alt path
  attach=${attach//@\{multiarch\}/$MULTIARCH_GLOB}
  if [[ $attach == *@\{* ]]; then
    log "skipped $1: a variable this tool does not resolve" >&2
    return 0
  fi
  EXPANDED=()
  expand_braces "$attach"
  for alt in "${EXPANDED[@]}"; do
    if [[ $alt == *\*\** ]]; then
      log "skipped $alt: ** is not expanded" >&2
    elif [[ $alt == *[\*\?\[]* ]]; then
      while IFS= read -r path; do
        if [[ -f $path ]]; then EXACT+=("$path"); fi
      done < <(compgen -G "$alt" || true)
    else
      EXACT+=("$alt")
    fi
  done
}

# True for a path a rule can name exactly: absolute, with no AppArmor pattern
# character and no control character.
literal_path() {
  local path=$1
  [[ $path == /* ]] || return 1
  [[ $path != *[\*\?\[\]\{\}\^\"\\]* ]] || return 1
  [[ $path != *[[:cntrl:]]* ]]
}

# A path as AppArmor reads it: quoted unless it is plain.
quoted() {
  if [[ $1 =~ $PLAIN_PATH ]]; then
    printf '%s' "$1"
  else
    printf '"%s"' "$1"
  fi
}

# The marked block for local/unpriv_bwrap: the canary and every exact path.
rules_block() {
  local attach path attaches=()
  EXACT=()
  mapfile -t attaches < <(unconfined_attach_paths)
  for attach in "${attaches[@]}"; do
    exact_paths "$attach"
  done
  {
    printf '%s\n' "$CANARY"
    for path in "${EXACT[@]}"; do
      if literal_path "$path"; then
        printf '%s\n' "$path"
      else
        log "skipped $path: not an exact path" >&2
      fi
    done
  } | LC_ALL=C sort -u | {
    printf '%s\n' "$BEGIN_MARK"
    printf '%s\n' "# Written by $TAG on every run. Inside an unprivileged bwrap, these"
    printf '%s\n' "# programs keep bwrap's label instead of stacking their own profile, which"
    printf '%s\n' "# allows everything but leaves them without network access in the stack."
    while IFS= read -r path; do
      if [[ $path =~ $PLAIN_PATH ]]; then
        printf 'allow ix %s,\n' "$path"
      else
        printf 'allow ix "%s",\n' "$path"
      fi
    done
    printf '%s\n' "$END_MARK"
  }
}

# The override with the block in place of the old one, or added at the end;
# every other line kept.
merged_override() {
  local block=$1 line in_block="" placed="" lines=()
  if [[ -e $OVERRIDE ]]; then
    mapfile -t lines <"$OVERRIDE"
  fi
  for line in "${lines[@]}"; do
    if [[ -z $in_block && $line == "$BEGIN_MARK" ]]; then
      in_block=1
      if [[ -z $placed ]]; then
        printf '%s\n' "$block"
        placed=1
      fi
    elif [[ -n $in_block ]]; then
      if [[ $line == "$END_MARK" ]]; then in_block=""; fi
    else
      printf '%s\n' "$line"
    fi
  done
  if [[ -z $placed ]]; then printf '%s\n' "$block"; fi
}

# Replace a file with the given bytes, mode 644, through a temporary file in
# the same directory.
write_atomic() {
  local path=$1 content=$2 tmp
  tmp="$path.$TAG.$$"
  install -m 644 /dev/null "$tmp" &&
    printf '%s' "$content" >"$tmp" &&
    mv -f "$tmp" "$path" || {
    rm -f "$tmp"
    return 1
  }
}

install_canary() {
  local dir
  dir=$(dirname "$CANARY")
  # Shell builtins only: the canary runs inside the namespace with whatever
  # PATH the caller has, and its profile allows everything.
  mkdir -p -m 755 "$dir" &&
    write_atomic "$CANARY" '#!/bin/sh
# Written by isomux-bwrap-apparmor. Prints its own AppArmor label; shell
# builtins only, so the caller'"'"'s PATH cannot make it run another program.
IFS= read -r label </proc/self/attr/apparmor/current
printf '"'"'%s\n'"'"' "$label"
' &&
    chmod 755 "$CANARY" &&
    write_atomic "$CANARY_PROFILE" "# Written by $TAG. The office runs the canary inside its
# process namespace: it keeps the namespace's label when the rules in
# local/unpriv_bwrap are live.

abi <abi/4.0>,
include <tunables/global>

profile $CANARY_PROFILE_NAME $(quoted "$CANARY") flags=(unconfined) {
}
"
}

main() {
  while (($# > 0)); do
    case $1 in
      --dry-run) DRY_RUN=1 ;;
      --help | -h)
        usage
        return 0
        ;;
      *)
        usage >&2
        return 1
        ;;
    esac
    shift
  done

  # Every refusal comes before the first write.
  if [[ ! -e $BWRAP_PROFILE ]]; then
    log "nothing to do: no $BWRAP_PROFILE on this box"
    return 0
  fi
  if [[ -e $BWRAP_PROFILE_DISABLED || -L $BWRAP_PROFILE_DISABLED ]]; then
    log "nothing to do: $BWRAP_PROFILE_DISABLED marks the bwrap profile as disabled"
    return 0
  fi
  if [[ ! -e $APPARMOR_PROFILES ]]; then
    log "nothing to do: AppArmor is not running ($APPARMOR_PROFILES does not exist)"
    return 0
  fi
  # Read, not tested with -r: securityfs shows the list as readable to all
  # and refuses it to anyone but root.
  local loaded
  if ! loaded=$(cat "$APPARMOR_PROFILES" 2>/dev/null); then
    log "cannot read $APPARMOR_PROFILES: run this as root"
    return 1
  fi
  if ! grep -q '^unpriv_bwrap ' <<<"$loaded"; then
    log "nothing to do: the unpriv_bwrap profile is not loaded"
    return 0
  fi
  if ! grep -q '^[[:space:]]*include if exists <local/unpriv_bwrap>' "$BWRAP_PROFILE"; then
    log "warning: $BWRAP_PROFILE has no include for local/unpriv_bwrap, so the rules cannot go in. Changed nothing."
    return 1
  fi

  local block
  block=$(rules_block)
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: would write this block to $OVERRIDE, install $CANARY and reload $BWRAP_PROFILE:"
    printf '%s\n' "$block"
    return 0
  fi

  local out
  if ! install_canary; then
    rm -f "$CANARY" "$CANARY_PROFILE"
    log "warning: could not install the canary $CANARY. Changed nothing else."
    return 1
  fi
  if ! out=$(apparmor_parser -r "$CANARY_PROFILE" 2>&1); then
    rm -f "$CANARY" "$CANARY_PROFILE"
    log "warning: could not load $CANARY_PROFILE, so removed the canary. Changed nothing else. apparmor_parser said: $out"
    return 1
  fi

  # The old bytes, to put back when the profile does not load with the block:
  # a block left behind would stop bwrap-userns-restrict loading at boot.
  local had_override="" old=""
  if [[ -e $OVERRIDE ]]; then
    had_override=1
    old=$(
      cat "$OVERRIDE"
      printf x
    )
    old=${old%x}
  fi
  if ! write_atomic "$OVERRIDE" "$(merged_override "$block")"$'\n'; then
    log "warning: could not write $OVERRIDE. Changed nothing else."
    return 1
  fi
  if ! out=$(apparmor_parser -r "$BWRAP_PROFILE" 2>&1); then
    if [[ -n $had_override ]]; then
      write_atomic "$OVERRIDE" "$old" || log "warning: could not put the old $OVERRIDE back"
    else
      rm -f "$OVERRIDE"
    fi
    apparmor_parser -r "$BWRAP_PROFILE" >/dev/null 2>&1 || log "warning: $BWRAP_PROFILE does not load with the old $OVERRIDE either"
    log "warning: $BWRAP_PROFILE did not load with the new rules, so put the old $OVERRIDE back. apparmor_parser said: $out"
    return 1
  fi
  log "programs whose AppArmor profile allows everything keep network access inside bwrap: wrote $(grep -c '^allow ix ' <<<"$block") rules to $OVERRIDE"
}

main "$@"
