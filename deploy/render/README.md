# Isomux on Render

Deployment steps live in the docs:
[Deploy on Render](../../docs/self-hosted.md#deploy-on-render). This directory
holds what that deployment runs.

- `Dockerfile` and `Dockerfile.dockerignore`: the image. BuildKit reads the
  Dockerfile-specific ignore file instead of the root `.dockerignore`, whose
  allowlist serves the provisioner image and would drop `server/` and `ui/`.
- `entrypoint.sh`, `office.ts`, `bootstrap.ts`: container start, the
  setup-key claim form that runs before the office, and the office launch with
  `ISOMUX_APP_SUPERVISOR=container`.
- `supervisor.py`: the in-container replacement for systemd that runs the
  generated apps (see below).
- `render.yaml` at the repository root declares the service.

## Persistent storage

`/var/data/home/.isomux` holds office state, provider profiles, app credentials,
supervisor definitions and local service logs; `/var/data/home` the other
provider CLI state; `/var/data/workspaces` generated projects. The entrypoint
creates the owned directories on a fresh disk and drops to the `node` user.
Everything outside the disk is ephemeral. Image updates replace application
code; no systemd updater is used.

## Process supervision

The container entrypoint runs the office and app monitors as sibling child
processes. The office adapter calls a private 0600 Unix socket. Restarting the
office does not restart apps. The supervisor saves each app's desired running
or stopped state and restores it after a container replacement.

Each app monitor is a Linux subreaper. It tracks descendants, including children
that double-fork and change process groups. It sends TERM, then KILL if needed,
and reaps all descendants before writing a cleanup receipt. The controller
does not report a successful deletion without that receipt. Unexpected monitor
death terminates the container supervisor so Docker can destroy the namespace;
it does not free the app's port while cleanup remains unproved.

Automatic restart uses a two-second delay and a five-starts-per-minute limit.
App tokens live in private files and enter only their own app environment.
The controller does not copy Render credentials into generated app environments.
App and office stdout/stderr go to bounded files on the persistent disk, not
Render service logs.

The TypeScript adapter's environment descriptor preserves compatibility with
the existing token and URL reconciliation APIs. It records the installed app
environment; it is not a systemd unit and does not claim systemd resource limits.
The systemd adapter remains the default on every other deployment.

## Limitations

The supervisor has sampled aggregate RSS and process-count guards for each app.
These are not hard per-app cgroup limits, and there is no per-app CPU quota.
Render's container limit covers the whole office; an app can exhaust shared
resources before a sampling guard acts.

Disk-backed Render services have one instance and deploy downtime. App data
survives; active requests and agent turns are interrupted by container
replacement.

## Tests

```sh
bun test server/container-app-supervisor.test.ts \
  server/test-support/container-apps.integration.test.ts \
  deploy/render/bootstrap.test.ts deploy/render/route-selection.test.ts
```

They start real app processes and the real office API with fake model backends.
The image build is proven with `DOCKER_BUILDKIT=1 docker build -f deploy/render/Dockerfile .`
from the repository root.
