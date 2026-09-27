# Isomux on Kubernetes

Setup steps live in the docs:
[Set up Isomux on Kubernetes (EKS)](../../docs/hosting/kubernetes.md). This
directory is the reference Kustomize base that guide uses. The design is in
[internal-docs/kubernetes-design.md](../../internal-docs/kubernetes-design.md).

Use the base from an overlay at the same release tag as the image, and set the
image by digest. The base's digest is a placeholder, so a missing overlay value
fails at image pull.

## Seccomp profile

`seccomp/amd64/isomux-chromium-v1.json` and
`seccomp/arm64/isomux-chromium-v1.json` are OCI profiles for containerd, one
per node architecture. They are generated from the Docker-format profile the
Compose setup uses,
[deploy/container/seccomp/chromium.json](../container/seccomp/chromium.json):

```sh
for arch in amd64 arm64; do
  python3 deploy/kubernetes/seccomp/resolve.py $arch > deploy/kubernetes/seccomp/$arch/isomux-chromium-v1.json
done
```

containerd reads a Localhost profile as OCI `LinuxSeccomp`, which has no
`archMap` and no per-rule `includes`/`excludes`. The script resolves those
conditions for one architecture and kernel 4.8 or later, with `CAP_SYS_CHROOT`
as the only capability: Chromium's sandbox calls `chroot` inside its user
namespace, which Docker allows through its default capabilities. The installer
DaemonSet writes the profile for its node's architecture (ConfigMap keys are
`uname -m` names) to the same node path, so the Deployment names one profile.
A profile change gets a new versioned filename; do not change a published file
in place.

## Tests

```sh
bun test deploy/kubernetes/seccomp.test.ts
```

Cluster verification steps and results are in
[internal-docs/container-verification.md](../../internal-docs/container-verification.md).
