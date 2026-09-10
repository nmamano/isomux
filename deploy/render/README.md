# Isomux on Render: prototype

Status, 2026-09-09: local Docker tests and the full entrypoint smoke test pass.
Live Render deployment and generated-app tests passed on 2026-09-09.
See LIVE-VALIDATION.md for the tested commit, scope, and remaining checks.
The prototype includes generated apps. It does not establish PHI readiness.

## Deployment shape

One paid Docker web service and one persistent disk. Render terminates HTTPS.
The office listens on Render's PORT. The same listener routes each generated
app hostname to its local app port through Isomux's existing authentication,
HTTP proxy and WebSocket relay. Provider login happens in the office UI.

Use a custom office origin, such as `https://office.example.com`, and add both
`office.example.com` and `*.office.example.com` to the same Render service.
Configure their DNS as Render directs. The platform's default onrender.com URL
cannot provide arbitrary child app hostnames. The prototype keeps apps on
separate origins; it does not put generated JavaScript under the office origin.

The build requires BuildKit to use `deploy/render/Dockerfile.dockerignore` instead of the root allowlist.

The root render.yaml defines the service. Its Pro compute plan and 20 GB disk
are initial test settings, not measured capacity recommendations. Pricing and
the service plan need review before creating a paid instance.

Set ISOMUX_PUBLIC_URL to the office's HTTPS origin. Render generates the
ISOMUX_SETUP_KEY value. Open the office URL, enter that key and an owner name,
and the protected setup flow creates the first owner and their session. The
key is accepted only before an owner exists. No key or login URL is printed.
The ordinary tokenless local claim form is never exposed for this deployment.

## Persistent storage

- `/var/data/home/.isomux`: office state, provider profiles managed by Isomux,
  app credentials, supervisor definitions, and local service logs.
- `/var/data/home`: other provider CLI state and user tools.
- `/var/data/workspaces`: generated projects and checked-out repositories.

The root entrypoint creates the two owned directories on a freshly mounted
disk, then drops to the node user before starting the supervisor, office, or
apps. It reapplies this setup automatically on every start. Files outside the
disk are ephemeral; project directories must be under /var/data/workspaces.
Image updates replace application code; no systemd updater is used.

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
Render service logs. This is not a full PHI data-flow audit.

The TypeScript adapter's environment descriptor preserves compatibility with
the existing token and URL reconciliation APIs. It records the installed app
environment; it is not a systemd unit and does not claim systemd resource limits.
The systemd adapter remains the default on existing deployments.

## Material limitations

The prototype has sampled aggregate RSS and process-count guards for each app.
These are not hard per-app cgroup limits. It does not implement the systemd
adapter's per-app CPU quota. Render's container limit covers the whole office;
an app can exhaust shared resources before a sampling guard acts. Full resource
parity remains open and this prototype must not be advertised as providing it.

Disk-backed Render services have one instance and deploy downtime. App data
survives; active requests and agent turns are interrupted by container replacement.
Live tests cover disk initialization, DNS, HTTPS, generated-app authentication,
WebSockets, and state restoration after a platform restart. Provider login,
agent turns, and Chrome behavior still require live checks.

## Local evidence

The companion RENDER-PROOF.md records the failed unprivileged systemd probe.
The replacement's tests are:

```sh
bun test server/container-app-supervisor.test.ts \
  server/test-support/container-apps.integration.test.ts \
  deploy/render/bootstrap.test.ts
```

They start real app processes and the real office API with fake model backends.
They cover restart, persistence, stopped intent, token rotation, environment
filtering, logs, detached-child cleanup, port reuse, authenticated hostname
routing, WebSocket echo, office restart, and protected first-owner setup.

The setup page was also rendered in headless Chrome. A fresh-volume Docker
smoke test exercised the full entrypoint with real owner creation and app
registration. An actual Docker restart preserved the office login and the
generated app's durable boot counter. This used synthetic data and no provider
credentials. Render networking remains untested.

References:
- https://render.com/docs/docker
- https://render.com/docs/disks
- https://render.com/docs/custom-domains
- https://render.com/docs/blueprint-spec
