#!/usr/bin/env bash
# Removes every isomux-load-test resource, then checks that none is left.
# Exits 1 when the check finds a leftover.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
F="Name=tag:Name,Values=$TAG"
live() {
  aws ec2 describe-instances --filters "$F" Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down \
    --query 'Reservations[].Instances[].InstanceId' --output text
}
IDS=$(live)
if [ -n "$IDS" ]; then
  # shellcheck disable=SC2086
  aws ec2 terminate-instances --instance-ids $IDS >/dev/null
  # shellcheck disable=SC2086
  aws ec2 wait instance-terminated --instance-ids $IDS
fi
for v in $(aws ec2 describe-volumes --filters "$F" --query 'Volumes[].VolumeId' --output text); do
  aws ec2 delete-volume --volume-id "$v"
done
# The office group references the generator group: delete it first.
for name in $TAG-office $TAG-gen; do
  sg=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$name --query 'SecurityGroups[0].GroupId' --output text)
  [ "$sg" != "None" ] && aws ec2 delete-security-group --group-id "$sg" >/dev/null
done
aws ec2 delete-key-pair --key-name $TAG >/dev/null 2>&1

echo "--- cleanup check"
left=0
check() { # label, then the ids the query found
  local label=$1; shift
  echo "$label: ${*:-none}"
  [ $# -eq 0 ] || left=1
}
# shellcheck disable=SC2046
check instances $(live)
# shellcheck disable=SC2046
check volumes $(aws ec2 describe-volumes --filters "$F" --query 'Volumes[].VolumeId' --output text)
# shellcheck disable=SC2046
check "security groups" $(aws ec2 describe-security-groups --filters Name=group-name,Values=$TAG-office,$TAG-gen --query 'SecurityGroups[].GroupId' --output text)
# shellcheck disable=SC2046
check "key pairs" $(aws ec2 describe-key-pairs --filters Name=key-name,Values=$TAG --query 'KeyPairs[].KeyName' --output text 2>/dev/null)
# The tagging API keeps listing terminated instances and deleted volumes for a
# while; the checks above cover those types, so only other types count here.
# shellcheck disable=SC2046
check "other tagged resources" $(aws resourcegroupstaggingapi get-resources --tag-filters Key=Name,Values=$TAG \
  --query 'ResourceTagMappingList[].ResourceARN' --output text | tr '\t' '\n' |
  grep -vE ':(instance|volume|security-group|key-pair)/' || true)
if [ $left -ne 0 ]; then
  echo "LEFTOVERS: run aws-down.sh again or remove them by hand" >&2
  exit 1
fi
echo "clean"
