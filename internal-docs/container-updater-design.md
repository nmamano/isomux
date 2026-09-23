# Container updater

Scope: fresh installer-managed containers. Direct-host updates keep their current
behavior. There is no legacy-container adoption or new rollback machinery.

The installer installs `scripts/update.sh` from its root-owned release fetch,
plus a root-owned Python helper and systemd socket/service units. The office
mounts a dedicated socket directory and a small client update.conf read-only.
It receives neither the Docker socket nor the host updater configuration.

The existing owner POST `/api/office/update` passes only a CalVer tag to the
helper. The socket protocol is one bounded JSON line with exactly one `tag`
field. The helper rejects other fields, invalid tags, trailing data and oversized
requests. It calls a fixed `systemctl start --no-block isomux-update@TAG.service`
argv with a fixed environment. The root-owned template invokes only the installed
updater. Socket access grants this one update operation to the container OS
account; the existing HTTP owner gate controls the office UI.

`update.sh` keeps one argument/config parser, lock, status writer, trusted tag
resolution and lifecycle. Explicit Git and container operations cover validation,
preparation, stop, state handling, start, readiness and finalization. Git operations
retain the current build, repair and recovery behavior. Container operations pull
the configured release image, pin its digest, check its revision against the
trusted source tag, stage release assets from trusted source, stop the fixed
Compose service, publish the staged assets/settings, and start that service with
the existing data mount. Container state handling does not snapshot or restore.
Readiness must also confirm the running commit and release, not just HTTP 200.
The installed updater/helper refresh uses trusted source bytes.

The installer adds the socket mount to Compose, enables the socket before starting
the office, and supplies release-mode detection through the client config. The
existing Updates pane handles reconnect and running-version checks. Hosting/AWS
instructions change to the owner update flow. Manual container providers retain
their provider deployment flow.

Verification: direct-host updater regression tests; installer rendering/embedding;
real socket negative cases; route owner/member/agent denial; root systemd helper
and actual old-to-new office container replacement with client readiness/version
checks. Use an isolated fixture, local release origin and local image registry;
no live office, cloud service or published release changes. The privileged test
must use the production installer output and root services. A user service or
Docker-based privilege escalation does not satisfy this test. The exact isolated
root command remains to be settled before implementation: password-free sudo is
unavailable, and neither systemd-nspawn nor QEMU is installed (2026-09-23).

## Concrete mechanics

- Host paths: `/usr/local/sbin/isomux-update`,
  `/usr/local/lib/isomux/container-update-helper.py`,
  `/etc/isomux/update.conf`, `/var/lib/isomux-update/{lock,status.json,trust.git}`,
  and `/opt/isomux-container` for the existing Compose/settings records and staged
  release assets. Root owns these paths. The updater's temporary release files
  remain under its private status directory.
- The root config uses `DEPLOYMENT_KIND=container`, `SERVICE_KIND=system`,
  `SERVICE_NAME=isomux-container`, `REPO_URL=https://github.com/nmamano/isomux.git`,
  `STATUS_DIR=/var/lib/isomux-update`, `BASE_URL=http://127.0.0.1:10000`, and
  `UPDATER_PATH=/usr/local/sbin/isomux-update`. Container paths and image repository
  are constants. Git mode remains the default for existing configs.
- `/run/isomux-update` is root:root 0755; `request.sock` is root:root 0666.
  systemd creates it through `isomux-container-update.socket` with `Accept=yes`.
  Each connection starts `isomux-container-update@.service`, running the Python
  helper as root with socket stdin/stdout and a bounded service timeout.
  The container account is uid 1000. Compose binds the directory read-only at
  the same path. A read-only bind still permits socket connections; this is
  intentional. A local unprivileged account has the same fixed-operation access.
- Client config: `/opt/isomux-container/client-update.conf`, root:root 0644,
  mounted read-only at `/etc/isomux/update.conf`. It contains only
  `DEPLOYMENT_KIND=container`, `SERVICE_KIND=system`, and the official `REPO_URL`.
  Neither the socket nor its client supplies host paths or config keys.
- Request framing: the client writes one JSON line, then half-closes its write
  side. The helper reads at most 256 bytes through EOF, within its service
  timeout. It requires exactly one object field, `tag`, a string whose whole
  value matches `v[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}(\.[0-9]+)?`.
  Duplicate fields, trailing data, other keys and oversized input fail closed.
  The response is one JSON line: `{"ok":true}` for an accepted job or
  `{"ok":false}` for refusal. The journal records a fixed failure reason and
  never logs the request body.
- The helper executes `/usr/bin/systemctl start --no-block
  isomux-update@TAG.service` as an argv array, without a shell, using a fixed
  PATH and HOME. It reuses the direct-host updater template. Container mode
  installs the socket bridge instead of the direct-host polkit bridge. The
  helper parses the tag before forming a unit name; systemd parses the template
  instance; update.sh validates TARGET_TAG again before any operation.
- The HTTP route keeps its owner authorization and `{tag}` request. Container
  success returns HTTP 202 with `{ok:true,via:"system",tag}`. This means systemd
  accepted the detached job. GET `/api/office/update` retains update information;
  the client checks `/readyz` and authenticated `/api/version` after replacement.
  There is no new office HTTP route or new response enum.
- Compose remains the container operation: pull and inspect the fixed image
  repository, then the existing host unit stops/starts Compose. The updater
  writes the new digest to the existing office.env and refreshes release assets
  from the trusted tag. Existing data mounts are reused. A same-release installer
  rerun checks current records and reinstalls the helper/socket support; it does
  not adopt legacy installs. Target finalization updates the installer checksum
  and release records so reruns use the installed release.
- Container images currently contain no Git checkout (context.py exports regular
  source files). Add a build-generated version record to that export and a
  server/version.ts fallback so `/api/version` reports the actual image commit
  and release. Direct-host Git version resolution retains precedence.

## Bounded root acceptance

The proposed command is `sudo /bin/bash
/home/nil/nil/isomux-worktrees/container-updater-fresh-0923/scripts/verify-container-update-root.sh
setup CHECKOUT COMMIT`, followed by an unprivileged client drive and the same command with
`teardown`. The script must be implemented and reviewed before Nil runs it.
It refuses occupied paths, units, Compose names or loopback port 10000 and
records the tested commit. It creates a loopback ext4 fixture mounted at
`/srv/isomux-data`; the test uses the production installer step functions and
real root systemd units. Setup and teardown only affect the fixture paths.
Neither command modifies Caddy, firewall rules, the live office, or cloud state.

Explicit setup exclusions: full host-install preflight (the fixture supplies
its own bounded checks), GitHub installer-byte/revision checks and initial
image selection use unpublished lane artifacts; package installation, Caddy,
firewall and unattended-update configuration are excluded to protect the live
box. Unit tests cover those installer checks. The target must contain the new
version record and update assets; a currently published image cannot prove the
new lane's result. A local bare origin and local image fixture are therefore
needed for this pre-publication acceptance run. Keep production image origin
fixed; any test-only source substitution must be explicit, bounded, and reported.
PM approved this verification seam on 2026-09-23; root execution is still pending.

On 2026-09-23, direct checks found the proposed container directory, status
root, update.conf, updater executable, updater/container units, socket directory,
data mount and port 10000 free. Docker reports 29.1.3. Setup repeats these checks;
this observation is not permission to overwrite anything.

## Scoped tests and mutants

Run build:ui, tsc, ESLint on touched TypeScript, installer embedding checks,
installer/container tests and scripts/update-{sh,deps-sync,network-bind}.test.ts,
server/update-{conf,trigger,checker}.test.ts, server/version.test.ts,
server/test-support/routes-{office-update,table,agents-manifest}.test.ts.
Root acceptance additionally runs against the committed lane's real artifacts.

- Remove `officeOwner` from the POST route: a member's valid request must still
  assert 403, and the root update unit must remain inactive before owner launch.
- Remove helper tag validation: invalid tags with newline, slash, whitespace,
  shell punctuation and unit suffixes must return failure without invoking the
  runner. A recording runner in unit tests checks that no argv was emitted;
  the real socket test checks no root update job was started.
- Remove exact-key/duplicate-key checks: otherwise valid tags with command,
  path, unit, Docker-operation or duplicate tag fields must be refused.
- Remove EOF/size enforcement: oversized input and a second JSON object must
  be refused, with no launch.
- Replace the helper's fixed argv/environment with request-derived operation
  data: tests assert the entire argv is the fixed systemctl start command with
  the validated tag instance and only the fixed environment.
- Remove the image revision comparison: a wrong-revision image must fail before
  stopping the office. Remove the running-version check: a ready HTTP listener
  reporting the wrong commit/release must not produce successful update status.

PM rulings, 2026-09-23: the bounded root fixture and explicit test-only artifact
substitution are approved for implementation, not execution. Root setup requires
review before Nil runs sudo. No guest or tool installation. Describe this as
updater-chain acceptance, not full fresh-host acceptance. Build version metadata
is approved; retain Git precedence and refuse malformed records.

Implementation notes: context.py synthesizes version-info.json inside the tar
export from the selected commit and its exact CalVer tags. The direct-host
updater template has Type=oneshot and ExecStart, with no filesystem sandbox
directives to weaken. Container mode adds a fixed environment to its template;
the request helper has ProtectSystem=strict, ProtectHome=yes, PrivateTmp=yes
and NoNewPrivileges=yes. The updater template still needs Docker and the host
installation paths. UpdatePane.tsx awaits apiFetch, whose res.ok check accepts
202 and parses the JSON body. No UI file changes are needed. The Python helper
unit tests run through deploy/container/update-helper.test.ts.

The container-side socket exchange runs in deploy/container/update-client.py,
launched with Python isolated mode and only the validated tag as an argument.
The image already requires Python for its supervisor. The standard socket test
uses a real Python peer. On 2026-09-23, the initial Bun 1.3.11 socket client
closed its receive side during the half-close test; the Python exchange passed
the transport check. No protocol or host-helper restriction changed.

Changed existing test assertions: context.test.ts now expects the generated
version-info.json alongside server/main.ts in the context file list.
install-container.test.ts adds git and python3 to the required host package list.
No existing authorization or failure-path assertion was removed. The installer
fixture stubs the new privileged support-install step; its real root execution
is covered only by the pending root acceptance check.

Review round 1 fixes: the other-office guard reads a unique literal container
deployment marker, so a completed install and an interrupted first install can
retry. Tests exercise host, container and ambiguous config markers. The helper
and real-socket negatives include a 257-byte valid JSON request, which isolates
the size limit from JSON parsing. The root fixture checks the final installer
entry-point line before sourcing definitions. The container publication phase
is named `publish`, distinct from asset preparation.
