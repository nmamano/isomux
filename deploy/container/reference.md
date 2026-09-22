# Container technical reference

For AWS setup, use the [step-by-step guide](README.md).

## Build from source

From a reviewed source checkout with Git, Python 3, and Docker BuildKit:

```sh
bash deploy/container/build.sh COMMIT isomux:COMMIT
```

The script exports allowed regular files from that Git commit. It excludes
untracked files, local edits, private directories, and local dependencies. It
prints the context checksum and local image ID. Both base images use pinned
digests; dependency installation uses the lockfile. Debian package repositories
can change, so rebuilding a commit is not a promise of identical image bytes.
Keep the built image for repeat deployments.

The Render Dockerfile path remains usable. Both Dockerfiles and their context
rules are identical. Use the export script for production builds; do not send a
live working directory to Docker. Source builds remain supported without GHCR.
Record the source commit and registry digest, and deploy `registry/image@sha256:…`
instead of a moving tag. Registry credentials belong on the host.

## Runtime details

| Setting            | Value                                                            |
| ------------------ | ---------------------------------------------------------------- |
| Architecture       | Linux amd64                                                      |
| Data mount         | `/var/data`, one writer                                          |
| Public origin      | `ISOMUX_PUBLIC_URL=https://office.example.com`                   |
| First owner        | `ISOMUX_SETUP_KEY`, at least 32 characters                       |
| Internal HTTP port | `PORT`, default `10000`                                          |
| Home and state     | `/var/data/home`, `/var/data/home/.isomux`                       |
| Projects           | `/var/data/workspaces` or another directory under the data mount |

Root creates the home and workspace directories, then starts the runtime as
`node` (UID/GID 1000). A mount whose directories already belong to that user can
run with `--user 1000:1000`. The container needs neither privileged mode nor the
Docker socket. Keep provider-home overrides and project dependency installs on
the data mount. Installs elsewhere disappear with the container.

The Compose reference uses the included `seccomp/chromium.json` profile so
non-root Chromium can create its sandbox namespaces. The profile adds `clone`,
`setns`, and `unshare` to a pinned Docker default basis for all container
processes. It adds no capabilities. See the [profile notes](seccomp/README.md)
for the exact basis and host requirements. Host-specific verification results are in the
[internal verification record](../../internal-docs/container-verification.md).

After owner creation, the setup endpoint no longer accepts the setup key.
Operators can optionally remove `ISOMUX_SETUP_KEY` from the deployment
configuration and replace the container to remove it from the supervisor's
environment. This removes an unused secret; it is not required to finish setup.
Provider connection steps are in the [setup guide](README.md#9-connect-an-ai-provider).

The image probe sends `GET /`: setup returns 200; the office returns 401 without
a session. The probe accepts those two codes. A passing probe checks the HTTP
listener, not provider or app readiness. Do not use `/health` after setup.

The supervisor preserves running and stopped app intent. Office restart keeps
apps running; container replacement interrupts all processes. Office and app
logs and worker diagnostics are private files under
`/var/data/home/.isomux/container-runtime`. `docker logs` carries container
supervisor diagnostics.
All members and their code share one OS trust boundary. App memory/process
guards are sampled, with no per-app CPU quota or hard memory isolation.

## Installer contract

Use `ISOMUX_INSTALL_MODE=container DOMAIN=office.example.com ISOMUX_REF=vYYYY.M.D`
with `deploy/install.sh` downloaded from that exact release tag. The installer
resolves the tag to a source commit, compares its bytes with that commit's copy,
and requires the image's source revision to match. It embeds the release's Compose file,
unit, mount check, and seccomp profile. The public GHCR release image must be
available before installation. Publication instructions are in
[the release design](../../internal-docs/release-design.md).

The host needs Ubuntu 24.04 on amd64 and a writable filesystem with a UUID
mounted at `/srv/isomux-data`. Docker Engine must be at least version 28, which
closes the older same-network exposure of loopback-published ports
([Docker port publishing](https://docs.docker.com/engine/network/port-publishing/)).
The installer installs Ubuntu's Docker/Compose packages if Docker is absent.
Install `curl` and `jq` before running the installer.
If Docker is already installed, it must be running and have Compose available. The installer does not replace an existing Docker
installation. No host account is added to the Docker group.

The root-only `/opt/isomux-container` directory records the release tag, source revision, image
digest, domain, disk UUID, and installer checksum before office service changes.
The systemd unit checks the disk UUID and writable mount on every start. It
stops the container when the mount disappears. Compose does not restart the
container independently of systemd. The runtime also locks the data directory
against a second writer.

A rerun requires the same release, installer, domain, and disk. It verifies the
tag still resolves to the recorded digest and starts that digest. It preserves
the setup key; an absent key is accepted only when the disk has an owner.
Custom configuration, unrelated Caddy configuration, and existing direct-host
offices are refused. A package-default Caddyfile can be replaced. Container mode
does not install the host updater or change SSH authentication; `OWNER_NAME`,
`ISOMUX_DEPS_ONLY`, and `INSTALL_CALLBACK_URL` do not apply.

For a manual deployment using the shipped systemd unit, install `mount-check.sh`
in `/opt/isomux-container` with mode 755, and write the data filesystem's UUID to
`/opt/isomux-container/mount.uuid`. Keep the directory and settings root-owned
with modes 700 and 600 respectively. The unit refuses to start without them.

## Update and restore

The [AWS guide](README.md#update-and-restore) contains the update and recovery
procedure for the installer-managed EC2 deployment. Apply the same single-writer
and complete-storage rules to custom deployments, using their storage provider's
snapshot and restore controls.

Development test commands, tested source revisions, and acceptance limits are
in the [internal verification record](../../internal-docs/container-verification.md).
