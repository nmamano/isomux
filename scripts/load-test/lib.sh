# Shared constants for the scripts that run on this machine. Sourced, not run.
TAG=isomux-load-test
WORK=/tmp/isomux-load-test
export AWS_REGION=us-east-1 AWS_PAGER=""
# Every resource carries Name=$TAG; aws-down.sh finds them by it.
TAGS="Key=Name,Value=$TAG"
SSH_OPTS="-i $WORK/key -o UserKnownHostsFile=$WORK/known_hosts -o StrictHostKeyChecking=accept-new"
