# Container verification evidence

Setup: [AWS guide](../deploy/container/README.md). Runtime details: [container reference](../deploy/container/reference.md).

## Verification record

On 2026-09-21, source revision `dc1a8cea` passed EC2/Caddy checks on Linux amd64:
app HTTPS and WebSockets, container replacement, host reboot, retained state,
and isolated EBS snapshot restore.

On the same date, image revision `b4b7a5f1` passed sandbox, PTY, and production
preview checks on EC2 Ubuntu 24.04 with Docker 29.1.3. Chromium ran as UID 1000
with zero effective capabilities and reported namespace and Seccomp-BPF
isolation. Docker kept its default AppArmor profile, with no added capabilities
or privileged mode. Replacing the test office with that image and the reviewed
Compose/profile files preserved app state and stopped intent; public app HTTPS
and WebSockets passed. The reboot and snapshot-restore results above apply to
`dc1a8cea`.

Actual provider completion was blocked by Bedrock billing. ALB, Fargate, and
missing-volume startup refusal on real AWS were not verified.

Run the local image check with `python3 deploy/container/smoke.py IMAGE`. It
creates isolated containers and a temporary volume, disables networking, and
checks setup, native executables, PTY, browser rendering, app HTTP/WebSockets,
office restart, and container replacement. It deletes its containers and volume
when complete. It uses synthetic state and makes no provider login or model turn.

With Docker Compose installed, `python3 deploy/container/compose-check.py IMAGE`
checks the reference command with isolated storage, stop/start persistence,
resource limits, and missing-directory refusal (skipped on Docker Desktop, which
creates a missing bind source). `bash deploy/container/check.sh
COMMIT` builds a throwaway image, runs both checks and removes the image, pass
or fail; `bun run ci` runs it on HEAD. An image built with `build.sh` stays until you remove it. Repeat host mount ordering and
reboot checks on the target deployment.

Before production use, verify the real AWS deployment: owner claim and invites; required
provider logins and turns; terminal and browser preview; app HTTPS, access, and
WebSockets; office restart; container replacement; host reboot; missing-volume
startup refusal; and snapshot restore. Record the date, image digest, runtime,
storage, ingress, resource limits, and results. Local image tests do not certify
AWS or a customer's workflow.

The new container installer acceptance remained pending when the hosting guide was restructured on 2026-09-21. The source-image results above do not establish installer acceptance.

## Kubernetes (local k3d)

Setup: [Kubernetes guide](../docs/hosting/kubernetes.md), base in
`deploy/kubernetes`, local overlay and script in `deploy/kubernetes-verify`
(`run.sh up`, `run.sh client`, `run.sh down`). Design:
[kubernetes-design.md](kubernetes-design.md).

On 2026-09-26, on this office box (Ubuntu 24.04, kernel 6.8, Docker 29.1.3):
k3d v5.8.3, kubectl v1.33.13, node image
`rancher/k3s:v1.33.13-k3s2@sha256:ada5ff2e138120efe877f76d514dedda65b304122112b982eab532732c028c89`,
csi-driver-host-path v1.18.0, external-snapshotter v8.6.0, Traefik bundled in
k3s. Office image `ghcr.io/nmamano/isomux@sha256:56feb68ff1eea2ece0a6f0f7e8eaf522ad958021d0672fe6fe74abb69a22889c`
(v2026.9.23, commit `c223b277`). Clients ran in containers on the k3d network
with a test CA; no host port was published.

Passed:
- The office pod ran as UID 1000 with zero effective capabilities,
  `NoNewPrivs`, and the Localhost seccomp filter, in a namespace that enforces
  Pod Security `restricted`. Probes passed before and after the owner claim.
- The office pod started before the installer had written the profile, got
  `CreateContainerError` (profile not found), and started once the file was
  there. A new labeled node got the file (same SHA-256 as the committed
  profile); a changed file on that node made the installer pod not Ready.
- Owner claim through the ingress host with the Secret's key: setup 200, office
  200 with the session cookie, 401 without it.
- A Free OpenCode agent replied through the office (model
  `opencode/nemotron-3-ultra-free`).
- An app registered through the API served
  `https://hello.office.k8s.test` after app sign-in in Chromium, including a
  websocket echo. An unknown label returned 404.
- Normal pod deletion: the replacement stayed Pending with the scheduler
  reason "pod using PersistentVolumeClaim with the same name and
  ReadWriteOncePod access mode" until the old pod finished. A second pod on the
  claim stayed Pending with the same reason.
- `SIGSTOP` on the office child: readiness failed, kubelet recorded a
  liveness failure and restarted the container, and the office became Ready.
- After each pod replacement and the image update, the owner session, agent
  history, and the app's running state were kept.
- Update: applying an overlay with a second image, built by
  `deploy/container/build.sh` from commit `e88489e3`, replaced the pod with
  Recreate (old pod completed before the new one ran); `/api/version` then
  reported that commit.

Owner overlay: `deploy/kubernetes-verify/owner` is the overlay the guide
prints, with a local path base, the test host and the v2026.9.23 digest
(`owner.test.ts` keeps it equal to the guide). The k3d layer changes only the
ingress class, TLS, the ALB-only path and storage. On a fresh cluster at
`42e2bb0b`, the deployed ingress kept the guide's hosts and certificate
annotation, and these passed again: pod identity and seccomp mode, owner
claim (`run.sh claim`), Free agent reply, app and websocket through Chromium
(`run.sh client bun /verify/browser.mjs`), unknown label 404, normal pod
deletion with the RWOP wait, and data kept after it. The remote Git base form
of the guide was only rendered (against a local `file://` repository); it gets
checked once a release contains `deploy/kubernetes`.

Not proven here:
- Chromium and Codex sandboxes. With the Localhost profile, `unshare -U`
  succeeded (seccomp allowed it) but writing the user-namespace ID map failed,
  so Chromium exited ("Failed to move to new namespace ... Operation not
  permitted") and Codex's bwrap failed ("loopback: Failed RTM_NEWADDR").
  Cause: on this host `/proc/sys/kernel/apparmor_restrict_unprivileged_userns`
  is `1` (read by Isomux PM on 2026-09-26), which blocks user namespaces for processes without
  an AppArmor profile that allows them, and k3d pods run without an AppArmor
  profile. Under `RuntimeDefault` the
  `unshare` call itself failed ("unshare failed: Operation not permitted"), and
  bwrap reported that it cannot create namespaces. Plain Docker on the same
  host with the Compose profile creates user namespaces (the container runs
  under `docker-default`).
  The EKS run below covers both sandboxes on Amazon Linux 2023.
- ALB, ACM, EBS gp3, IMDS, and Amazon Linux 2023 nodes: see the EKS run below.

The first OpenCode welcome model, `opencode/muse-spark-1.2-contributor-free`,
was refused by the provider on that date; OpenCode model discovery had timed
out at first boot. The same image in plain Docker on this host gets the same
refusal for that model and a reply from `opencode/nemotron-3-ultra-free`, so
this is not specific to Kubernetes. Fixed 2026-09-26: the fallback is now
`opencode/nemotron-3-ultra-free`, and after a seed falls back, discovery
retries in the background and moves the seeded agents to a discovered free
model (`repickFallbackSeeds` in `server/isomux-office.ts`).

## Kubernetes (EKS)

On 2026-09-26, one disposable EKS cluster in us-west-2, created 18:40Z and
deleted 19:55Z. Tools: eksctl 0.230.0, AWS CLI 2.37.4, Helm 4.3.0, kubectl
1.33.13. EKS 1.33 (platform eks.48); one managed node, `m7i-flex.large`
(2 vCPU, 8 GiB), `AL2023_x86_64_STANDARD` release `1.33.13-20260923` (AMI
`ami-09c972394b519fee1`), kernel
`6.12.103-129.197.amzn2023.x86_64`, containerd 2.2.7, no AppArmor
(`/proc/self/attr/current` reports SELinux `unconfined_service_t`),
`user.max_user_namespaces` 30890. Node metadata: IMDSv2 required, hop limit 1
(eksctl `disableIMDSv1` and `disablePodIMDS`). Add-ons: vpc-cni
v1.22.4-eksbuild.3 with `enableNetworkPolicy`, coredns v1.12.4-eksbuild.38,
kube-proxy v1.33.10-eksbuild.29, aws-ebs-csi-driver v1.66.0-eksbuild.1. The
CoreDNS add-on status was DEGRADED when sampled at 19:20Z, shortly after the
node joined; both CoreDNS pods were Running at the next check, and the add-on
status was not sampled again. AWS
Load Balancer Controller chart 3.5.0. The account allowed only Free Tier
instance types, so `m6i.large` failed to launch and the node group used
`m7i-flex.large` instead.

Deployment: the guide's overlay, with a local path base to `deploy/kubernetes`
(the remote `?ref=<tag>` form waits for a release), the v2026.9.23 digest, host
`office.eks-verify.test`, and an ACM certificate imported from a test CA. One
test-only patch limited the ALB to this box's address (`inbound-cidrs`).
Clients on this box used `--resolve` and Chromium host-resolver rules to the
ALB. Evidence: `/tmp/eks-verify` (checks.log, teardown.log, env.txt).

Passed:
- Chromium sandbox with the Localhost profile, after one fix (below):
  `chrome://sandbox` reported Layer 1 Namespace, PID and network namespaces,
  and Seccomp-BPF. The production preview path (`capturePreview`) returned a
  PNG from the office pod.
- The office pod ran as UID 1000, CapEff 0, NoNewPrivs 1, seccomp filter, in
  the `restricted` namespace; `unshare -Urn` succeeded.
- ALB: HTTP 301 to HTTPS; setup page 200 over the imported certificate;
  `/__isomux/tls-ask` 404 at the ALB; the target stayed healthy before and
  after the claim (success codes 200,401).
- Owner claim through the ALB: setup 200, office 200 with the cookie, 401
  without.
- Agent reply: the Free Welcome Agent (`opencode/big-pickle`, chosen at boot)
  answered "pong"; the model call took about 4 minutes.
- App on a wildcard host: `https://hello.office.eks-verify.test` after app
  sign-in in Chromium, websocket echo, office websocket frames; anonymous 302
  to app sign-in; unknown label 404.
- EBS: gp3, 30 GiB, encrypted, `ReadWriteOncePod`, `Retain`.
- A second pod on the claim stayed Pending with the ReadWriteOncePod reason.
  On normal pod deletion the replacement stayed Pending until the old pod
  completed (the scheduler reported insufficient CPU and memory on the
  2-vCPU node, because the terminating pod still held its requests).
- A rollout (seccomp patch) was Recreate: the old pod completed before the new
  pod was created.
- After pod replacement: owner session, agent history, app running state and
  the app in Chromium all kept.
- `SIGSTOP` on the office child: readiness failed, a liveness failure
  restarted the container, and the office became Ready.
- Instance metadata: from the office pod, the IMDSv2 token request and a plain
  request both timed out (NetworkPolicy enforced). From a pod in another
  namespace (no policy), the token response did not arrive (hop limit 1) and a
  plain request returned 401 (IMDSv2 required).
- `RuntimeDefault` for comparison: `unshare` failed with "Operation not
  permitted", and Chromium exited ("Failed to move to new namespace").

Fix made during the run: with the first resolved profile, Chromium failed at
`Check failed: sys_chroot("/proc/self/fdinfo/") == 0`. The sandbox calls
`chroot` inside its user namespace. The Docker basis allows `chroot` only with
`CAP_SYS_CHROOT`, which Docker grants by default and the pod drops. The
resolver now keeps rules gated on `CAP_SYS_CHROOT` only, which adds `chroot`.
`isomux-chromium-v1.json` changed in place because no release contains it.
The guide's first `kubectl create namespace` now uses `--save-config`, so the
later `kubectl apply` prints no missing-annotation warning.

Not passed: Codex's own sandbox, used only when an agent selects a Codex
sandbox mode other than the default `danger-full-access`. Not observed: no
Codex agent turn ran in this run (no Codex login in the test office). Running
`codex sandbox` directly in the office pod failed before the command started,
with `bwrap: Failed to make / slave: Operation not permitted`. bwrap needs
`mount`, which the profile allowed only with `CAP_SYS_ADMIN`, as Docker's
default does. Changed 2026-10-08: see "Codex sandbox in containers" below.

Not checked on EKS: update by digest (no second published image; the local run
covers it), node-group replacement, and snapshot restore.

Teardown, 19:41Z-20:01Z: ingress deleted and the ALB and target group gone;
resources and PV deleted and the retained EBS volume deleted; controller
uninstalled; `eksctl delete cluster`; imported certificate deleted. The final
checks listed no EKS cluster, load balancer, target group, cluster volume or
instance, Elastic IP, NAT gateway, tagged security group, eksctl VPC, launch
template, remaining CloudFormation stack, OIDC provider, ACM certificate, EBS
snapshot, autoscaling group or tagged network interface. A pre-existing
instance `isomux-aws-test` (from 2026-09-21) and its two volumes were not
touched. Cost is unmeasured: Cost Explorer is not enabled for this account.
Estimate from us-west-2 list prices read 2026-09-26: EKS 1.33 was in extended
support (standard support ended 2026-07-29), so the control plane costs
$0.10 + $0.50 = $0.60 per hour; about 1.25 hours gives about $0.75. The node
(`m7i-flex.large`, $0.0958/h, about 0.6 h), the ALB, public IPv4 addresses and
EBS add roughly $0.10, so about $0.85 in total.

## Codex sandbox in containers

On 2026-10-08, on this office box (Ubuntu 24.04, kernel 6.8, Docker 29.1.3,
`kernel.apparmor_restrict_unprivileged_userns=1`), Codex 0.160.0. Every run:
`docker run --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges`
with a seccomp profile and an AppArmor label, which matches the Kubernetes
pod's identity and capabilities. No Codex login: a test script ran the real
Codex adapter against a local mock model that asks for one shell command, and
printed the events the chat renders.

Before the change (v2026.10.8 image, `isomux-chromium-v1.json`):
- `codex sandbox -- sh -c ...` failed with `bwrap: Failed to make / slave:
  Operation not permitted`, the EKS result.
- Every Codex session, in every sandbox mode, showed "Codex could not find
  bubblewrap on PATH. Install bubblewrap with your OS package manager ..."
  twice (stderr and `configWarning`), because the image had no `bwrap`.
- With `workspace-write` (approval `never` or `on-request`), the command did
  not run and the chat showed no tool card; only the model saw the bwrap
  error. No approval prompt appeared.

Two layers block bwrap. Seccomp: with `mount` and `umount2` allowed, bwrap
next failed at `pivot_root`; with all three allowed, it passed seccomp.
AppArmor: Docker's `docker-default` profile denies `mount` ("Failed to make /
slave: Permission denied") whatever the seccomp profile allows. Kubernetes
nodes that apply an AppArmor profile to containers are expected to behave the
same (not run).

The change: `bubblewrap` (Debian 0.8.0) in the image; the Kubernetes profile
`isomux-chromium-v1.json` (name kept) adds `mount`, `umount2` and
`pivot_root`; in a
container, the office probes `codex sandbox` once at startup and, when bwrap
reports a denial, starts Codex threads with `danger-full-access` and tells
members whose agents use another mode. The Compose profile is unchanged.

Results with the image built from the change:
- New profile, AppArmor label `buildah` (an Ubuntu profile in unconfined mode
  that only adds `userns`; it stands in for a node without AppArmor, such as
  EKS AL2023): probe `available`; `codex sandbox` with `workspace-write` wrote
  in its working directory and was refused outside it. Through the adapter, a
  `workspace-write` turn ran its command; a `read-only` turn got "Read-only
  file system" for the same write. No bubblewrap line.
- New profile, `apparmor=unconfined`: probe `available`, same sandbox result.
  Earlier, Codex's bundled bwrap failed there with "loopback: Failed
  RTM_NEWADDR", which the userns restriction causes for unconfined processes.
  That `/usr/bin/bwrap` passes is probably this host's
  `bwrap-userns-restrict` AppArmor profile attaching by path (unchecked).
- Old profile, `buildah` label: probe `denied` (Operation not permitted).
- New profile and Compose profile, `docker-default`: probe `denied`. Through the
  adapter, `workspace-write` and `read-only` turns showed "This container
  cannot run Codex's sandbox, so commands run with full access inside the
  container." and ran the command; a `danger-full-access` turn showed no
  notice.
- `python3 deploy/container/smoke.py` passed, with `bwrap --version` in the
  native checks.

Cost of the new rule: every process in the pod may call `mount`, `umount2` and
`pivot_root`. Without capabilities, the kernel refuses them except inside a
user namespace the process created (the old profile already allowed creating one); mounts
there do not propagate out, and mounts inherited from the pod stay locked.
What it adds is kernel attack surface: the mount and filesystem code for
filesystems that a user namespace may mount (tmpfs, proc, sysfs, overlayfs and
others) becomes reachable from the pod, and local privilege-escalation bugs
have been found there before (for example CVE-2023-0386 in overlayfs). The new
mount API (`fsopen`, `fsconfig`, `fsmount`, `fspick`, `move_mount`,
`open_tree`, `mount_setattr`) stays denied.

Not verified: a real EKS node with the new profile, a real Codex login, and
nodes with SELinux enforcing (for example Bottlerocket). The startup probe
covers any of these where bwrap is denied.
