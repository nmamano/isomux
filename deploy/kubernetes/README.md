# Isomux on Kubernetes

Setup steps live in the docs:
[Set up Isomux on Kubernetes (EKS)](../../docs/hosting/kubernetes.md). This
directory is the reference Kustomize base that guide uses. The design is in
[internal-docs/kubernetes-design.md](../../internal-docs/kubernetes-design.md).

Use the base from an overlay at the same release tag as the image, and set the
image by digest. The base's digest is a placeholder, so a missing overlay value
fails at image pull.

## Seccomp profile

`seccomp/isomux-chromium-v1.json` is an OCI profile for containerd. It is
generated from the Docker-format profile the Compose setup uses,
[deploy/container/seccomp/chromium.json](../container/seccomp/chromium.json):

```sh
python3 deploy/kubernetes/seccomp/resolve.py > deploy/kubernetes/seccomp/isomux-chromium-v1.json
```

containerd reads a Localhost profile as OCI `LinuxSeccomp`, which has no
`archMap` and no per-rule `includes`/`excludes`. The script resolves those
conditions for amd64, no capabilities and kernel 4.8 or later. A profile change
gets a new versioned filename; do not change a published file in place.

## Tests

```sh
bun test deploy/kubernetes/seccomp.test.ts
```

Cluster verification steps and results are in
[internal-docs/container-verification.md](../../internal-docs/container-verification.md).
