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
