# Isomux container

One Linux amd64 container runs an office and its generated apps. Mount one
persistent filesystem at `/var/data`. AWS acceptance is pending; this reference
does not require a particular AWS service.

## Build and record an image

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
live working directory to Docker. Registry publication is a separate step.
Record the source commit and registry digest, and deploy `registry/image@sha256:…`
instead of a moving tag. Registry credentials belong on the host.

## Runtime contract

| Setting | Value |
| --- | --- |
| Architecture | Linux amd64 |
| Data mount | `/var/data`, one writer |
| Public origin | `ISOMUX_PUBLIC_URL=https://office.example.com` |
| First owner | `ISOMUX_SETUP_KEY`, at least 32 characters |
| Internal HTTP port | `PORT`, default `10000` |
| Home and state | `/var/data/home`, `/var/data/home/.isomux` |
| Projects | `/var/data/workspaces` or another directory under the data mount |

Root creates the home and workspace directories, then starts the runtime as
`node` (UID/GID 1000). A mount whose directories already belong to that user can
run with `--user 1000:1000`. The container needs neither privileged mode nor the
Docker socket. Keep provider-home overrides and project dependency installs on
the data mount. Installs elsewhere disappear with the container.

Open the HTTPS office and enter the setup key and owner name. Remove the key
from the deployment configuration after claim. The office launcher removes it
from its environment, but the supervisor retains its original environment until
container replacement. Replace the container immediately after removing the key.
Connect providers through Settings → You → Connections.
Real provider login and turns need acceptance checks on the target deployment.

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

## EC2, retained EBS, and Compose reference

This reference uses a Linux x86-64 EC2 host with Docker Engine, the Compose
plugin, and systemd. An ALB terminates HTTPS. Choose host capacity for the
workload. The Compose defaults cap the whole container at 4 GiB and two CPUs;
these are starting limits, not a capacity guarantee.

1. Attach an encrypted EBS data volume. Set and verify
   `DeleteOnTermination=false` in the instance block-device mapping. Identify
   the volume and its filesystem UUID before mounting it; format only a new,
   empty volume. [AWS retention instructions](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/preserving-volumes-on-termination.html).
2. Create `/srv/isomux-data` and add this `/etc/fstab` entry, replacing `UUID`
   and the filesystem type with the actual values:

   ```fstab
   UUID=UUID /srv/isomux-data ext4 defaults,nofail,x-systemd.device-timeout=30s 0 2
   ```

   Run `sudo mount /srv/isomux-data` and `findmnt /srv/isomux-data`. Confirm that
   the mounted device is the retained EBS volume. A missing disk must stop the
   office from starting; an empty root-disk directory is not a replacement.
3. Copy `compose.yaml` and `isomux-container.service` from this directory to
   `/opt/isomux-container/`. In that directory, create a mode-0600 `office.env`:

   ```dotenv
   ISOMUX_IMAGE=registry/image@sha256:REPLACE_WITH_DIGEST
   ISOMUX_PUBLIC_URL=https://office.example.com
   ISOMUX_SETUP_KEY=REPLACE_WITH_A_RANDOM_SECRET_OF_AT_LEAST_32_CHARACTERS
   ISOMUX_BIND_IP=REPLACE_WITH_EC2_PRIVATE_IP
   ```

   Pull the image with `sudo docker compose --env-file office.env pull`.
   Keep deployment and registry credentials outside the container. Give the
   runtime no AWS role with deployment permissions.
4. Install the host unit and start it:

   ```sh
   sudo cp /opt/isomux-container/isomux-container.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now isomux-container.service
   ```

   The unit requires the mount and checks it before starting Compose. It owns
   restart policy, including after reboot; Docker's independent restart policy
   is disabled so Docker cannot start the office before EBS is mounted. The
   unit stops Compose when the mount stops. Keep one container and one host
   writer; do not configure rolling replicas or EBS multi-attach.
5. Create an ACM DNS-validated certificate for `office.example.com` and
   `*.office.example.com`. Keep its DNS validation records and attach it to the
   ALB HTTPS listener. ACM manages renewal while the certificate remains
   eligible. [ACM renewal](https://docs.aws.amazon.com/acm/latest/userguide/managed-renewal.html).
6. Send both DNS names to the ALB. Forward both hostnames to the same EC2
   private address on port 10000. Enable ALB Host header preservation. Set the
   target health check to HTTP `GET /` and success codes `200,401`. Give
   `/__isomux/tls-ask` a higher-priority fixed 403 response rule. Reject other
   hosts at the listener. The EC2 security group must accept port 10000 only
   from the ALB security group; do not publish app ports. Permit public HTTPS
   and, if needed, HTTP redirects at the ALB.
7. Preserve WebSocket upgrades and set an idle timeout suitable for long turns.
   Check a long turn and an app WebSocket through the actual ingress.
   [ALB attributes](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html),
   [ALB listeners](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-listeners.html).

8. Claim the office at its HTTPS address. Immediately remove `ISOMUX_SETUP_KEY`
   from `/opt/isomux-container/office.env`, and run
   `sudo systemctl restart isomux-container.service`. The unit removes the old
   container and starts its replacement with the same data mount. Reopen the
   office and confirm the owner can sign in. Keep the key absent on later starts.

An existing proxy can supply the same HTTPS, Host, WebSocket, and access rules.
The default Compose bind address is loopback for a host-local proxy. Other AWS
container workflows must meet the same persistent-storage and single-writer
contract. Fargate task storage is ephemeral; EFS and Fargate process behavior
need separate validation.

## Update and restore

Pull the next immutable image before the outage. Stop the host unit with
`sudo systemctl stop isomux-container`. Confirm the office container is stopped,
run `sudo sync`, and then snapshot the complete EBS volume. Record the old image digest with that
snapshot. Change `ISOMUX_IMAGE` in `office.env`, keep the setup key absent,
and start the unit. Check the owner, provider connections,
project files, and running/stopped apps. Never start a second writer to reduce
the outage.

To roll back stored-state changes, stop the unit and restore the matching data
snapshot and previous image together. Test restoration on an isolated mount.
The office's own backup does not cover the complete home/workspace mount and
does not protect against volume loss. Keep independent snapshots.

## Acceptance still required

Run the local image check with `python3 deploy/container/smoke.py IMAGE`. It
creates isolated containers and a temporary volume, disables networking, and
checks setup, native executables, PTY, browser rendering, app HTTP/WebSockets,
office restart, and container replacement. It deletes its containers and volume
when complete. It uses synthetic state and makes no provider login or model turn.

With Docker Compose installed, `python3 deploy/container/compose-check.py IMAGE`
checks the reference command with isolated storage, stop/start persistence,
resource limits, and missing-directory refusal. Host mount ordering and reboot
still need the AWS check.

Nil must verify the real AWS deployment: owner claim and invites; required
provider logins and turns; terminal and browser preview; app HTTPS, access, and
WebSockets; office restart; container replacement; host reboot; missing-volume
startup refusal; and snapshot restore. Record the date, image digest, runtime,
storage, ingress, resource limits, and results. Local image tests do not certify
AWS or a customer's workflow.
