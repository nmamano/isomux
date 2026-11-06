#!/usr/bin/env bash
# Creates the load-test VMs: the office (default m7i.2xlarge) and the
# generator (c7i.large), in one subnet, all named and tagged isomux-load-test.
# usage: aws-up.sh <usd cap> [<office instance type>]   (writes $WORK/aws.env)
#
# The cap: each VM gets user data that powers it off after the minutes the cap
# buys, and a power-off terminates it. The rate is both instance prices from
# the Pricing API plus two public IPv4 addresses and two 50 GB gp3 volumes.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
USD=${1:?usage: aws-up.sh <usd cap> [<office instance type>]}
OFFICE_TYPE=${2:-m7i.2xlarge}
GEN_TYPE=c7i.large
# us-east-1 list prices read from the Pricing API on 2026-11-06 (effective
# 2026-11-01): public IPv4 0.005 USD/h each, gp3 0.08 USD per GB-month.
IPV4_USD_H=0.005
GP3_USD_GB_MONTH=0.08
DISK_GB=50
# Boot before the power-off is armed, and the time a terminate takes.
MARGIN_MIN=5

running=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$TAG" \
  Name=instance-state-name,Values=pending,running,stopping \
  --query 'Reservations[].Instances[].InstanceId' --output text)
if [ -n "$running" ]; then
  echo "refusing: $TAG instances still exist ($running). Run aws-down.sh first." >&2
  exit 1
fi

price() {
  aws pricing get-products --region us-east-1 --service-code AmazonEC2 --filters \
    Type=TERM_MATCH,Field=instanceType,Value="$1" Type=TERM_MATCH,Field=regionCode,Value=$AWS_REGION \
    Type=TERM_MATCH,Field=operatingSystem,Value=Linux Type=TERM_MATCH,Field=tenancy,Value=Shared \
    Type=TERM_MATCH,Field=preInstalledSw,Value=NA Type=TERM_MATCH,Field=capacitystatus,Value=Used \
    --query 'PriceList[0]' --output text | python3 -I -c "
import sys, json
d = json.loads(sys.stdin.read())
od = list(d['terms']['OnDemand'].values())[0]
print(list(od['priceDimensions'].values())[0]['pricePerUnit']['USD'])"
}
P_OFF=$(price "$OFFICE_TYPE")
P_GEN=$(price $GEN_TYPE)
read -r RATE MINUTES < <(python3 -I -c "
rate = $P_OFF + $P_GEN + 2 * $IPV4_USD_H + 2 * $DISK_GB * $GP3_USD_GB_MONTH / 730
print(round(rate, 4), int($USD / rate * 60) - $MARGIN_MIN)")
echo "rate $RATE USD/h ($OFFICE_TYPE $P_OFF, $GEN_TYPE $P_GEN, IPv4 and gp3); cap $USD USD: power-off after $MINUTES min"
if [ "$MINUTES" -lt 5 ]; then
  echo "refusing: the cap buys under 5 minutes" >&2
  exit 1
fi

mkdir -p $WORK
MYIP=$(curl -s https://checkip.amazonaws.com)
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
AMI=$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text)
# One subnet, so both VMs share an AZ.
SUBNET=$(aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC" Name=default-for-az,Values=true Name=availability-zone,Values=${AWS_REGION}a --query 'Subnets[0].SubnetId' --output text)

[ -f $WORK/key ] || ssh-keygen -q -t ed25519 -N '' -f $WORK/key -C $TAG
aws ec2 describe-key-pairs --key-names $TAG >/dev/null 2>&1 || aws ec2 import-key-pair --key-name $TAG --public-key-material fileb://$WORK/key.pub \
  --tag-specifications "ResourceType=key-pair,Tags=[{$TAGS}]" >/dev/null

sg() { aws ec2 describe-security-groups --filters Name=group-name,Values="$1" --query 'SecurityGroups[0].GroupId' --output text; }
SG_GEN=$(sg $TAG-gen)
SG_OFF=$(sg $TAG-office)
if [ "$SG_GEN" = None ]; then
  SG_GEN=$(aws ec2 create-security-group --group-name $TAG-gen --description "$TAG generator" --vpc-id "$VPC" \
    --tag-specifications "ResourceType=security-group,Tags=[{$TAGS}]" --query GroupId --output text)
  SG_OFF=$(aws ec2 create-security-group --group-name $TAG-office --description "$TAG office" --vpc-id "$VPC" \
    --tag-specifications "ResourceType=security-group,Tags=[{$TAGS}]" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --group-id "$SG_GEN" --protocol tcp --port 22 --cidr "$MYIP/32" >/dev/null
  aws ec2 authorize-security-group-ingress --group-id "$SG_OFF" --protocol tcp --port 22 --cidr "$MYIP/32" >/dev/null
  aws ec2 authorize-security-group-ingress --group-id "$SG_OFF" --ip-permissions \
    "IpProtocol=tcp,FromPort=443,ToPort=443,UserIdGroupPairs=[{GroupId=$SG_GEN}]" \
    "IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=$MYIP/32}]" >/dev/null
fi

printf '#!/bin/bash\nshutdown -h +%s\n' "$MINUTES" > $WORK/user-data.sh
launch() { # role type security-group
  aws ec2 run-instances --image-id "$AMI" --instance-type "$2" --key-name $TAG --subnet-id "$SUBNET" \
    --security-group-ids "$3" --associate-public-ip-address \
    --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=$DISK_GB,VolumeType=gp3,DeleteOnTermination=true}" \
    --tag-specifications "ResourceType=instance,Tags=[{$TAGS},{Key=Role,Value=$1}]" "ResourceType=volume,Tags=[{$TAGS}]" \
    --instance-initiated-shutdown-behavior terminate --user-data file://$WORK/user-data.sh \
    --query 'Instances[0].InstanceId' --output text
}
I_OFF=$(launch office "$OFFICE_TYPE" "$SG_OFF")
I_GEN=$(launch gen $GEN_TYPE "$SG_GEN")
echo "launched $(date -u +%FT%TZ); both terminate by $(date -u -d "+$((MINUTES + MARGIN_MIN)) min" +%FT%TZ)"
aws ec2 wait instance-running --instance-ids "$I_OFF" "$I_GEN"
q() { aws ec2 describe-instances --instance-ids "$1" --query "Reservations[0].Instances[0].$2" --output text; }
cat > $WORK/aws.env <<ENV
SG_GEN=$SG_GEN
SG_OFF=$SG_OFF
I_OFF=$I_OFF
I_GEN=$I_GEN
OFF_PUB=$(q "$I_OFF" PublicIpAddress)
OFF_PRIV=$(q "$I_OFF" PrivateIpAddress)
GEN_PUB=$(q "$I_GEN" PublicIpAddress)
ENV
cat $WORK/aws.env
