#!/usr/bin/env bash
# Local k3d cluster for checking deploy/kubernetes. This is a local gate, not
# EKS proof: Traefik replaces the ALB and the hostpath CSI driver replaces EBS.
#
#   run.sh up                  create the cluster and apply the overlay
#   run.sh client CMD...       run CMD in a client container that resolves the
#                              office hosts and trusts the test CA (/work/ca.pem);
#                              this directory is at /verify
#   run.sh claim               claim the owner through the ingress; the session
#                              cookie goes to /work/cookies.txt
#   run.sh down                delete the cluster
#
# Needs docker, git, openssl, k3d and kubectl. Ports on this machine are not
# used: clients run on the cluster's Docker network.
set -euo pipefail

K3S_IMAGE=rancher/k3s:v1.33.13-k3s2@sha256:ada5ff2e138120efe877f76d514dedda65b304122112b982eab532732c028c89
HOSTPATH_REF=v1.18.0
SNAPSHOTTER_REF=v8.6.0
CLUSTER=isomux-verify
DOMAIN=office.k8s.test
# The released image under test; owner/kustomization.yaml pins the same digest.
IMAGE=ghcr.io/nmamano/isomux@sha256:56feb68ff1eea2ece0a6f0f7e8eaf522ad958021d0672fe6fe74abb69a22889c

here=$(cd "$(dirname "$0")" && pwd)
work=${ISOMUX_VERIFY_DIR:-/tmp/isomux-k8s-verify}

node_ip() {
  docker inspect -f "{{(index .NetworkSettings.Networks \"k3d-$CLUSTER\").IPAddress}}" "k3d-$CLUSTER-server-0"
}

certificates() {
  mkdir -p "$work"
  [[ -f $work/ca.pem ]] && return
  openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=isomux verify CA" \
    -keyout "$work/ca.key" -out "$work/ca.pem" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=$DOMAIN" \
    -keyout "$work/tls.key" -out "$work/tls.csr" 2>/dev/null
  printf 'subjectAltName=DNS:%s,DNS:*.%s\n' "$DOMAIN" "$DOMAIN" > "$work/san.ext"
  openssl x509 -req -in "$work/tls.csr" -CA "$work/ca.pem" -CAkey "$work/ca.key" \
    -CAcreateserial -days 7 -extfile "$work/san.ext" -out "$work/tls.pem" 2>/dev/null
  # Chromium trusts the leaf by its public-key hash.
  openssl x509 -in "$work/tls.pem" -pubkey -noout | openssl pkey -pubin -outform der |
    openssl dgst -sha256 -binary | base64 > "$work/spki.txt"
}

case ${1:-} in
up)
  certificates
  k3d cluster create "$CLUSTER" --image "$K3S_IMAGE" --agents 0 \
    --servers-memory 10g --k3s-node-label "isomux.com/office-node=true@server:0" --wait
  kubectl apply -k "https://github.com/kubernetes-csi/external-snapshotter/client/config/crd?ref=$SNAPSHOTTER_REF"
  kubectl apply -k "https://github.com/kubernetes-csi/external-snapshotter/deploy/kubernetes/snapshot-controller?ref=$SNAPSHOTTER_REF"
  rm -rf "$work/hostpath"
  git clone --quiet --depth 1 --branch "$HOSTPATH_REF" \
    https://github.com/kubernetes-csi/csi-driver-host-path "$work/hostpath"
  "$work/hostpath/deploy/kubernetes-latest/deploy.sh"
  # The client containers use the image from this machine's Docker.
  docker pull --quiet "$IMAGE" >/dev/null
  kubectl create namespace isomux --dry-run=client -o yaml | kubectl apply -f -
  kubectl -n isomux create secret tls isomux-tls --cert "$work/tls.pem" --key "$work/tls.key" \
    --dry-run=client -o yaml | kubectl apply -f -
  [[ -f $work/setup-key ]] || openssl rand -hex 32 > "$work/setup-key"
  kubectl -n isomux create secret generic isomux-setup \
    --from-literal=ISOMUX_SETUP_KEY="$(cat "$work/setup-key")" --dry-run=client -o yaml | kubectl apply -f -
  kubectl apply -k "$here"
  kubectl -n isomux rollout status deployment/isomux --timeout=10m
  ;;
client)
  shift
  ip=$(node_ip)
  docker run --rm --network "k3d-$CLUSTER" --add-host "$DOMAIN:$ip" \
    -e NODE_IP="$ip" -e SPKI="$(cat "$work/spki.txt")" -v "$work:/work" -v "$here:/verify:ro" \
    --entrypoint "" -w /opt/isomux "$IMAGE" "$@"
  ;;
claim)
  "$0" client bash -c 'curl -sS --cacert /work/ca.pem -c /work/cookies.txt \
    -H "Origin: https://office.k8s.test" --data-urlencode name=Verifier \
    --data-urlencode "key=$(cat /work/setup-key)" -o /dev/null -w "setup %{http_code}\n" \
    https://office.k8s.test/setup'
  ;;
down)
  k3d cluster delete "$CLUSTER"
  ;;
*)
  echo "usage: $0 up|client CMD...|claim|down" >&2
  exit 2
  ;;
esac
