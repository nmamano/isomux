#!/usr/bin/env bash
# The host unit calls this before every container start, including after reboot.
set -euo pipefail
mount_path=${1:-/srv/isomux-data}
identity_file=${2:-/opt/isomux-container/mount.uuid}
[[ ! -L $mount_path && -d $mount_path && -w $mount_path ]] || exit 1
mountpoint -q "$mount_path" || exit 1
[[ -f $identity_file && ! -L $identity_file ]] || exit 1
IFS= read -r expected < "$identity_file"
[[ $expected =~ ^[A-Za-z0-9-]+$ ]] || exit 1
actual=$(findmnt --mountpoint "$mount_path" --noheadings --output UUID)
[[ -n $actual && $actual == "$expected" ]] || exit 1
options=$(findmnt --mountpoint "$mount_path" --noheadings --output OPTIONS)
[[ ,$options, == *,rw,* ]] || exit 1
