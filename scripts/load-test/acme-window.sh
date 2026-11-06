#!/usr/bin/env bash
# Opens or closes 80 and 443 to the internet on the office VM, only while the
# installer gets its Let's Encrypt certificate. Logs the UTC times.
# usage: acme-window.sh open|close
set -euo pipefail
. "$(dirname "$0")/lib.sh"
. $WORK/aws.env
P='IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0}]'
Q='IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]'
case ${1:-} in
  open) aws ec2 authorize-security-group-ingress --group-id "$SG_OFF" --ip-permissions "$P" "$Q" >/dev/null ;;
  close) aws ec2 revoke-security-group-ingress --group-id "$SG_OFF" --ip-permissions "$P" "$Q" >/dev/null ;;
  *) echo "usage: acme-window.sh open|close" >&2; exit 2 ;;
esac
echo "$1 $(date -u +%FT%TZ)" | tee -a $WORK/acme-window.log
