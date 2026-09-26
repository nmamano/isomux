# Kubernetes (EKS) deployment - design

Task 86c8351a. Draft 2026-09-26. Target: Akido runs the published GHCR image on
EKS from their infrastructure-as-code, first try, before the week of 2026-09-28.

## 1. Packaging: plain manifests with Kustomize

Recommendation: plain YAML in `deploy/kubernetes/` with a `kustomization.yaml`.
No Helm chart now.

- `kubectl apply -k`, Argo CD, Flux and Terraform all consume plain manifests.
  A Helm user can wrap them. The reverse needs Helm.
- The operator changes few values: office host, ACM certificate ARN, image
  digest, disk size. Kustomize `images:` sets the digest
  (`kustomize edit set image`). The rest is one placeholder,
  `office.example.com`, the same as the AWS guide.
- A chart needs a published chart artifact, versioning and template tests.
  Add one later if customers ask.

Files: `namespace.yaml`, `serviceaccount.yaml`, `storageclass.yaml`, `pvc.yaml`,
`configmap` (generated), `deployment.yaml`, `service.yaml`, `ingress.yaml`,
`networkpolicy.yaml`, `seccomp-installer.yaml` (DaemonSet + ConfigMap, own
namespace), `kustomization.yaml`.

## 2. One writer on /var/data

Prerequisites: Kubernetes 1.29 or later (`ReadWriteOncePod` is GA), and a
CSI driver whose sidecars support RWOP (csi-provisioner 3.0+, csi-attacher
3.3+, csi-resizer 1.3+). The EKS run records the EBS CSI add-on version.

- `Deployment`, `replicas: 1`, `strategy: Recreate`. This is a rollout
  property only: in a rollout, the old pod stops before the new pod starts.
  If a person deletes the pod, the ReplicaSet creates the replacement at once.
  RWOP is what stops the second mount.
- `PersistentVolumeClaim` with `accessModes: [ReadWriteOncePod]`. While a pod
  object that uses the claim exists (also while it is `Terminating`), the
  scheduler does not start a second pod on it. RWO alone permits two pods on
  one node.
- RWOP is not physical fencing. It holds only while the old pod object exists.
  The docs say: do not force-delete the pod (`--force --grace-period=0`) and
  do not force-detach the volume of a lost node until that node is stopped
  (for example, the EC2 instance is terminated).
- StorageClass `isomux-gp3`: `ebs.csi.aws.com`, `type: gp3`,
  `encrypted: "true"`, `reclaimPolicy: Retain`,
  `volumeBindingMode: WaitForFirstConsumer`, `allowVolumeExpansion: true`.
  The PVC is a separate object, so deleting the Deployment keeps the data.
- Two more guards already exist: EBS attaches to one node only, and the
  supervisor holds `flock` on `container-runtime/lock`.
- Why not a StatefulSet: a StatefulSet stops a rollout at a pod that never
  becomes Ready, and the operator must then delete the pod by hand. That is a
  bad failure for "update by digest".
- The volume is bound to one availability zone. Snapshots: AWS Backup or DLM on
  the EBS volume, or a `VolumeSnapshot` if the cluster has the snapshot
  controller. The docs say to snapshot before each update.
- Pod security: `runAsUser/runAsGroup/fsGroup: 1000`, `runAsNonRoot`,
  `fsGroupChangePolicy: OnRootMismatch` (no recursive chown of a large disk on
  each start), `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`.
  The entrypoint already has a non-root branch; with `fsGroup` the volume root
  is group-writable, so it creates `home` and `workspaces` itself. This passes
  the Pod Security Standard `restricted`.
- Placement: `nodeSelector` `kubernetes.io/arch: amd64` (the image is amd64
  only) and `isomux.com/office-node: "true"`, a label the operator puts on the
  office node group. Resources match Compose: requests `cpu: 1`,
  `memory: 4Gi`; limits `cpu: 2`, `memory: 4Gi`.
  `terminationGracePeriodSeconds: 30`.
- Fargate is out: Fargate has no EBS volumes and no Localhost seccomp profiles.

## 3. Chromium seccomp profile

The sandbox creates namespaces with `unshare`, `setns` and `clone` with
namespace flags. Docker's and containerd's default profiles allow those only
with `CAP_SYS_ADMIN`. `clone` without namespace flags stays allowed.

- Format. `deploy/container/seccomp/chromium.json` is Docker input: it has
  `archMap` and per-rule `includes`/`excludes` conditions on architecture,
  capabilities and kernel version. containerd reads a Localhost profile
  directly as OCI `LinuxSeccomp`, which has none of those fields. The
  conditions would disappear, and capability-gated allow rules (for example
  `bpf`, `perf_event_open`, `mount`, and the `CAP_SYS_PTRACE` group `kcmp`,
  `pidfd_getfd`, `process_madvise`) would become unconditional.
  So we ship a resolved OCI profile, not the Docker file.
- Derivation. A script (`deploy/kubernetes/seccomp/resolve.py`) resolves the
  pinned Docker basis the way Moby does, for amd64, with no capabilities, and
  kernel 4.8 or later (EKS nodes run 6.x): keep a rule when every include
  holds and no exclude holds, and drop the conditions. It sets
  `architectures: [SCMP_ARCH_X86_64, SCMP_ARCH_X86, SCMP_ARCH_X32]` from
  `archMap`, and adds the one Chromium rule (`clone`, `setns`, `unshare`
  allow). Output: `deploy/kubernetes/seccomp/isomux-chromium-v1.json`,
  committed. Version in the filename: a change is a new file, never an edit
  in place on nodes.
- Test (bun, no cluster): the committed file equals the script output; it
  has only OCI fields; no `includes`, `excludes`, `archMap` or `comment`;
  rules gated only on capabilities the pod lacks add no allowed names
  (outside the three Chromium calls); no rule from another architecture; `clone3` keeps its
  ENOSYS rule; the allowed names equal the basis's unconditional rules plus
  its amd64 rules plus its `minKernel: 4.8` rule (`ptrace`,
  `process_vm_readv`, `process_vm_writev`, which Docker also allows on these
  kernels) plus the three calls.
- Localhost path: kubelet reads `/var/lib/kubelet/seccomp/<localhostProfile>`.
  The container sets `seccompProfile: {type: Localhost, localhostProfile:
  isomux/isomux-chromium-v1.json}`.
- Getting the file onto nodes. Default: a DaemonSet in namespace
  `isomux-node-setup` (Pod Security `privileged`, because of `hostPath`).
  Its container is not `privileged: true`: it runs as UID 0 (the directory is
  root-owned) with `capabilities.drop: [ALL]` and
  `allowPrivilegeEscalation: false`. Its only `hostPath` is
  `/var/lib/kubelet/seccomp/isomux` (`DirectoryOrCreate`). It writes a temp
  file in that directory and renames it, then sleeps; a readiness probe
  checks the file's SHA-256. It has the same `nodeSelector` as the office,
  so it writes only to office nodes. A new node gets the file when its
  DaemonSet pod starts; until then the office pod reports
  `CreateContainerError` on that node and kubelet retries. Alternative for
  clusters that forbid `hostPath`: the same file from node user data (launch
  template or Karpenter `EC2NodeClass`). Security Profiles Operator also
  works, but it needs cert-manager; we do not require it.
- With `RuntimeDefault` (expected, to be measured in the cluster run): with
  `allowPrivilegeEscalation: false` the setuid `chrome-sandbox` helper cannot
  work either, so Chromium exits with "No usable sandbox". Preview cards and
  app screenshots fail. The office, agents, terminal and apps keep working.
  Codex's tool sandbox (bwrap) also uses user namespaces; its behaviour under
  `RuntimeDefault` is unchecked, and the run measures it. The docs do not offer
  `Unconfined` or `--no-sandbox`.
- Node OS: Amazon Linux 2023 has no AppArmor and allows user namespaces
  (unchecked on EKS; the EKS run would confirm). Bottlerocket and Ubuntu EKS
  nodes are unchecked; the docs name AL2023.

## 4. Ingress, TLS, websockets

Recommendation: AWS Load Balancer Controller (ALB) with one ACM certificate for
`office.example.com` and `*.office.example.com`. ingress-nginx is retired
upstream (March 2026), so we do not recommend it; the docs say any ingress that
meets the list below works.

- One Ingress, two host rules (`office.example.com`, `*.office.example.com`),
  both to Service `isomux` port 80 → pod port 10000. The office routes app
  hosts itself by `Host` and answers 404 for names that are not live apps.
- Annotations: `scheme: internet-facing` (or `internal` with
  `inbound-cidrs` for a VPN-only office), `target-type: ip`,
  `listen-ports` 80+443, `ssl-redirect: 443`, `certificate-arn`,
  `load-balancer-attributes: idle_timeout.timeout_seconds=300`,
  `healthcheck-path: /`, `success-codes: 200,401` (without this the ALB marks
  the pod unhealthy after setup).
- A fixed-response 404 for path `/__isomux/tls-ask`, as the managed Caddyfile
  does. The path is for a certificate issuer; ACM does not need it.
- Websockets: ALB supports them. The office client pings every 25 s; the
  office's own idle timeout is 120 s. 300 s on the ALB covers both, and gives
  app websockets and long uploads room. The office accepts 512 MB bodies; ALB
  has no body limit (another ingress needs one of at least 512 MB).
- DNS: Route 53 alias records for `office` and `*.office` to the ALB (or
  external-dns).
- Instance metadata. Agents run arbitrary commands; the node IAM role must
  not leak. The required guard is a node setting: IMDSv2 `required` with
  hop limit 1, in the launch template or Karpenter `EC2NodeClass`, so that
  every replacement node has it. A NetworkPolicy is a second guard only:
  egress allow all except `169.254.169.254/32`. EKS enforces NetworkPolicy
  only when the VPC CNI has network policy turned on, and any other policy
  that selects the pod and allows that address defeats the exclusion
  (policies add up). A commented `except` line blocks the VPC's private
  ranges; that is Akido's choice. The guide covers IPv4 clusters only; an
  IPv6 cluster also has metadata at `fd00:ec2::254`, and the guide says it is
  out of scope.
- ServiceAccount with no RBAC and `automountServiceAccountToken: false`, and
  `enableServiceLinks: false`, for the same reason.

## 5. Setup key, public URL, owner claim, probes

- `ISOMUX_PUBLIC_URL`: `configMapGenerator` literal (a change rolls the pod).
- `ISOMUX_SETUP_KEY`: Secret `isomux-setup`, created by the operator
  (`openssl rand -hex 32`), referenced with `optional: true`. After the claim
  the operator can delete the Secret; the next pod start drops it from the
  environment. Without an owner and without a key, `office.ts` refuses to
  start; that is the right failure.
- Owner claim: the setup page on the public URL, as on AWS and Render. The
  setup form checks `Origin` against `ISOMUX_PUBLIC_URL`, so the claim must go
  through the real host, not `port-forward`. The operator reads the key with
  `kubectl get secret`.
- Probes: a Kubernetes `httpGet` probe treats 401 as failure, so the probes run
  the image's own check, `exec: bun deploy/container/probe.ts` (GET /, 200 or
  401, 4 s fetch deadline). All three have `timeoutSeconds: 5` (the default
  is 1 s, shorter than the fetch deadline). `startupProbe` period 5 s,
  60 failures; `readinessProbe` period 10 s, 3 failures; `livenessProbe`
  period 30 s, 3 failures (same as the image `HEALTHCHECK`).

## 6. Updates

The operator updates by image digest: `kustomize edit set image
ghcr.io/nmamano/isomux@sha256:…`, apply, and the Recreate rollout replaces the
pod (about one minute of downtime; apps restart from saved intent). Rollback is
the previous digest, only with a snapshot, because a newer release can migrate
state. The docs get the digest from the release tag
(`docker buildx imagetools inspect` or the GHCR page).

What the office shows today (read from code, not yet run in a pod): the image
has `version-info.json` with its release, but no `update.conf`, so the checker
runs in commit mode. The pill says "main +N" nearly always, and the pane shows
"Pull the latest changes / Run bun install / Restart". Both are wrong on
Kubernetes. Render has the same fault (task a80d8bbb, out of scope here).

Proposal - **needs a PM decision (wire shape, overlaps a80d8bbb)**:
- A container with no `update.conf` (`ISOMUX_APP_SUPERVISOR=container`) uses
  release-mode detection: running release vs latest release, no main drift.
- The release status gets one field, for example `apply: "host" | "image"`.
  With `image`, the pane has no "Update now" button and says to deploy the new
  release image in the platform, with a link to the platform guide.
- Platform detection only picks the link: `KUBERNETES_SERVICE_HOST` (kubelet
  sets it in every pod) → `/docs/hosting-kubernetes#update-the-office`;
  `RENDER=true` → the Render guide; else the container reference.
- The setup page (`bootstrap.ts`) gets a Kubernetes help line that names the
  Secret, from the same detection.
- Sequencing: this is server code, so Akido only gets it in a release. The
  manifests and docs do not need a release (they pin v2026.9.23 by digest).
  I propose Phase 2a = manifests + docs + cluster run; 2b = the update-mode
  change, shared with a80d8bbb, as the PM sequences it. Until 2b ships, the
  docs send Kubernetes owners to the published release images (the GHCR
  page and GitHub releases) to find a new release, and say that the in-app
  update steps do not apply to Kubernetes. They do not treat the "main +N"
  pill as a release signal.

## 7. Docs page

`docs/hosting/kubernetes.md`, published at `/docs/hosting-kubernetes`, added to
`HOSTING_GUIDES` after AWS (label "Kubernetes (EKS)", detail "A cluster in your
AWS account"), and as a leaf in the decision diagram next to Render/AWS/VPS.
A notice at the top, as on Render, until the EKS run passes. Steps: prerequisites
(EBS CSI driver, AWS Load Balancer Controller, AL2023 amd64 nodes, IMDS hop
limit 1, ACM cert, Route 53), seccomp profile, Secret, edit and apply, DNS,
claim, provider, update, backups, logs. Copy goes to Nil for approval.
The container reference links to it.

## 8. Verification

k3d is a local gate, not EKS proof.

Needed from Nil (nothing else installed on the box):
- `k3d` v5.8.x binary, and
- `kubectl` v1.33.x binary.
To pin at implementation, exact values recorded before the run: the k3s node image `rancher/k3s:v1.33.x-k3s1` by digest
(k3d's default image moves), and `kubernetes-csi/csi-driver-host-path` at
one release tag, applied into the cluster from its `deploy/` script, because
RWOP needs a CSI driver and k3s's local-path is not one. That fixture needs
the VolumeSnapshot CRDs and the snapshot-controller
(`kubernetes-csi/external-snapshotter`, pinned tag) in the cluster. The run
records every version and digest.

Local overlay in `deploy/kubernetes-verify/` (test only, not a user path; Kustomize refuses an overlay inside its base directory): Traefik (bundled in k3s) instead
of ALB; hostpath-CSI StorageClass; a test CA and a wildcard certificate for
`office.k8s.test` and `*.office.k8s.test` as the ingress TLS Secret. Ports 80
and 443 on this box are taken, so no host port is published. The test
clients run in containers on the k3d Docker network: `curl --cacert <test CA>
--resolve`, and Chromium (Playwright, from the isomux image) with
`--host-resolver-rules="MAP office.k8s.test <lb ip>, MAP *.office.k8s.test <lb
ip>"` and the test CA trusted through `--ignore-certificate-errors-spki-list`
for the leaf key, so the origin stays secure. `ISOMUX_PUBLIC_URL` is
`https://office.k8s.test`. The seccomp file goes to the nodes through the
shipped DaemonSet.

Checks, image `ghcr.io/nmamano/isomux@<v2026.9.23 digest>`:
1. Pod starts as UID 1000 under namespace `restricted`; probes pass before
   and after the claim. Freeze the office child with `SIGSTOP` (a killed
   child is restarted by the supervisor in 2 s, which would hide the probe):
   readiness fails, kubelet records a liveness failure and restarts the
   container, and the office recovers.
2. Owner claim through the ingress host with the Secret's key.
3. Agent reply: an OpenCode agent on a Free model (no credentials needed).
4. App on a wildcard host: register an app, open
   `https://<app>.office.k8s.test` through the ingress, including a
   websocket.
5. Seccomp: the resolved-profile test passes; in the pod, `chrome://sandbox`
   reports namespace + Seccomp-BPF, and a preview card renders. Then the same
   pod with `RuntimeDefault`, to record what breaks (Chromium and Codex
   sandbox).
6. Seccomp installer: DaemonSet Ready only with the right SHA-256; add a new
   k3d node with the office label, and the office pod scheduled there starts
   after the installer writes the file.
7. Single writer: `kubectl delete pod` (normal deletion); while the old pod is
   `Terminating`, the replacement stays Pending; then owner, agent history,
   app and its running intent survive. A second pod on the claim stays
   Pending (RWOP).
8. Update by digest to a second image built through
   `deploy/container/build.sh` from a committed revision (so it has release
   metadata): Recreate, data kept, the office reports the new version.

Not covered locally, and stated so in the report: ALB, ACM, EBS gp3,
IMDS, AL2023 kernel and containerd. **Question for PM/Nil:** a disposable EKS
run before Akido's trial (EKS control plane, one m6i.large AL2023 node, one
ALB, one small EBS volume, a few hours; needs an AWS account, credentials and
authorization for the cost). It adds the checks above on EKS plus a pod-side
IMDS check: from the office pod, the IMDSv2 token request and a plain
metadata request both fail. I recommend it: the brief asks for a first try
that works, and the ALB annotations and seccomp path are where it would fail.
