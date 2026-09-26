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
resource limits, and missing-directory refusal. Repeat host mount ordering and
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
  Chromium and Codex sandbox verification remains pending the EKS run on
  AL2023 (Amazon Linux 2023 nodes, no AppArmor).
- ALB, ACM, EBS gp3, IMDS, and Amazon Linux 2023 nodes. These need the EKS run.

The first OpenCode welcome model, `opencode/muse-spark-1.2-contributor-free`,
was refused by the provider on that date; OpenCode model discovery had timed
out at first boot. The same image in plain Docker on this host gets the same
refusal for that model and a reply from `opencode/nemotron-3-ultra-free`, so
this is not specific to Kubernetes.
