# General-purpose Isomux container

Design proposal, 2026-09-19. Task 91403f8f. Code inspected at `abe2f213`.
No image or AWS deployment is verified by this document. Implementation waits
for Nil's design go/no-go in the consolidated batch report.

## Recommendation

Generalize the existing Render container into one Linux image. Keep one office
and its generated apps in one container, with one persistent `/var/data` mount.
Keep the existing provider login, app API, and hostname rules. Do not integrate
Hermes or use its image as a base.

For Nil's first AWS check, recommend Docker Compose on one x86-64 EC2 instance,
a retained EBS data volume, and an HTTPS reverse proxy. This has fewer unproved
runtime/storage assumptions than Fargate. Darwin can use his existing workflow
if it meets the contract below; EC2 and Compose are a reference deployment,
not a customer requirement. His AWS service, CPU architecture, ingress,
registry, storage, and domain remain unknown.

[Hermes on Docker Hub](https://hub.docker.com/r/nousresearch/hermes-agent)
links to its [Docker instructions](https://hermes-agent.nousresearch.com/docs/user-guide/docker).
Their useful pattern is a published image, one persistent data mount, and image
replacement for updates. Its current [Dockerfile](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/Dockerfile)
uses Debian and s6 supervision. Isomux can keep its existing supervisor.
Darwin's eventual hand-off must explain Isomux's browser owner claim, provider
login, and office plus app HTTPS names. These differ from the Hermes setup
wizard and gateway workflow. No customer message is part of this slice.

## Verified current code

- [Render image](../deploy/render/Dockerfile): Node 24 Bookworm, Bun 1.3.11,
  Python, build tools, Git, Chromium, and tini; frozen dependency install and UI
  build. [render.yaml](../render.yaml) calls the deployment a prototype.
- [Entrypoint](../deploy/render/entrypoint.sh): sets `HOME=/var/data/home`,
  `ISOMUX_HOME=/var/data/home/.isomux`, container supervision, and default
  `PORT=10000`. Root initializes home/workspaces ownership, then drops to `node`.
  App and agent processes run without root.
- [Office launcher](../deploy/render/office.ts): requires an HTTPS
  `ISOMUX_PUBLIC_URL`, reapplies public origin and all-interface binding on each
  boot, and runs the [setup form](../deploy/render/bootstrap.ts) before the
  office if there is no owner. Setup requires `ISOMUX_SETUP_KEY` of at least
  32 characters, checks the request Origin, limits attempts, and sets the owner
  session cookie. The launcher removes the key from its own environment before
  loading the office. The supervisor still inherits the original environment;
  this is not complete secret erasure. The form currently names Render.
- [Supervisor](../deploy/render/supervisor.py) and
  [adapter](../server/container-app-supervisor.ts): private Unix socket,
  persisted desired app state, descendant cleanup, and office/app restarts.
  Office restart preserves apps; container replacement interrupts all processes.
  Logs are bounded files under `.isomux/container-runtime`, not normal container
  stdout. App RSS/process guards are sampled, with no per-app CPU quota or hard
  memory isolation. The adapter currently references the Render script path.
- [State root](../server/config.ts), [provider accounts](../server/provider-account-manager.ts),
  [Codex home](../server/backends/codex/native-bin.ts), and
  [OpenCode profiles](../server/backends/opencode/profile-paths.ts) put managed
  state under home/state paths. Explicit provider-directory overrides can point
  elsewhere. Persisting only `.isomux` does not preserve the whole CLI home.
- [App domains](../server/app-domain.ts) derive child hostnames from the HTTPS
  office origin. [Host dispatch](../server/app-hosts.ts) separates app requests
  before office routes. The container adapter binds addressed apps to loopback.
  Apps need no separate published ports.

## Proposed image contract and shared work

| Input | Proposed contract |
| --- | --- |
| Image | Linux amd64 first; arm64 only after native provider binaries, PTY, and browser checks |
| Storage | One persistent read/write filesystem at `/var/data`; home and workspaces keep their current paths |
| Public URL | Existing `ISOMUX_PUBLIC_URL=https://office.example.com` |
| First owner | Existing `ISOMUX_SETUP_KEY`, supplied as a deployment secret; remove from deployment configuration after claim |
| Listener | Existing `PORT`, default 10000; HTTP inside the private container network |
| Runtime | Default root initialization then `node`; pre-owned mounts can run as `node`; no privileged mode or Docker socket |
| Scheduling | Exactly one writer per data directory; stop old container before starting its replacement |

Move common entrypoint, bootstrap, office launcher, supervisor, and Dockerfile
under `deploy/container/`; update the adapter reference and Render Blueprint
together. Keep the old Render Dockerfile path usable for existing integrations.
Keep Render's disk layout and variables unchanged. Keep Render-specific service
configuration in `render.yaml`. These are proposed edits, not changes in this
commit. Coordinate extraction with the Render effort before implementation.

Replace the form's Render-specific sentence with this proposed copy:
“Enter the setup key from your deployment settings to become this office's first owner.”
No other user-visible copy is proposed here.

Build from a clean tracked-source export. The current Dockerfile copies its
build context and its ignore list is not a complete private-file allowlist.
Use an explicit production context policy before publishing. Pin base-image
digests, retain the lockfile, build the UI in the image, and include native
provider dependencies and the browser. Keep writable project/dependency installs
under persistent home/workspaces; packages installed elsewhere disappear on
replacement. No runtime systemd installer or updater runs inside the image.

Reuse the supervisor without changing provider behavior. Require a container
restart policy, a shutdown grace period (initial reference: 30 seconds, to be
measured), and a probe that works before and after owner claim. The bootstrap
has `/health`; this inspection did not find a matching office health route.
Use `GET /` for the initial deployment probe and verify its expected response
in both phases. Do not advertise `/health` as an office readiness API. Any new
route or changed public contract goes back to PM.

Keep existing private file logs; do not copy agent/app output to AWS logs by
default. Document where operators can read them. Enforce whole-container memory
and CPU limits; size them from acceptance results, not an unmeasured guarantee.
All office members and their code share this container's OS trust boundary.
Do not give the runtime an AWS role with deployment permissions or pass registry
credentials into it. Image pull credentials belong to the host/orchestrator.

## AWS storage and network reference

Mount an encrypted EBS filesystem into `/var/data`. Set and check
`DeleteOnTermination=false`; automate mount-before-container startup so a missing
volume fails startup rather than creating an empty office on the root disk.
AWS documents [EBS retention](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/preserving-volumes-on-termination.html).
Back up the complete data mount while the container is stopped; retain an
independent snapshot before image updates. A same-disk office backup does not
protect workspaces or against volume loss. Restore the matching data snapshot
and previous image together if a new version changes stored state.

Provider login happens through the existing Isomux connection flow after owner
setup. Test an actual login and turn for each provider Darwin needs. Keep custom
provider homes under the persistent mount. Do not bake credentials into layers
or replace provider login with an AWS-specific authentication scheme.

Terminate TLS outside the image. Configure DNS and certificates for both
`office.example.com` and `*.office.example.com`; forward both to the same office
port, preserving Host and WebSocket upgrades. Publish only HTTPS, plus HTTP if
needed for redirects/certificate setup. Deny public access to the container
port and `/__isomux/tls-ask`; do not publish app ports. For the EC2 reference,
use a proxy with a wildcard certificate and persist its certificate state.
Automate certificate renewal. An existing AWS ALB is also suitable: AWS documents
[HTTPS and WebSockets](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-listeners.html)
and [Host preservation](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html).
Verify proxy timeouts with a long turn and an app WebSocket.

ECS is an alternative, not the first certification target. AWS lists
[EFS as persistent storage and service-managed EBS as ephemeral](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/using_data_volumes.html);
[Fargate task storage is ephemeral](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-storage.html).
Do not substitute either ephemeral option for the data mount. EFS needs explicit
validation of ownership, locks, atomic writes, Unix socket placement, and latency.
Fargate also needs validation of the supervisor's Linux process operations.
A shared volume does not make concurrent office replicas safe. Deployment
settings must prevent overlap, including during updates and recovery.

## Build, distribution, and acceptance

After design approval, deliver a generic Dockerfile, a small Compose reference,
and AWS instructions. Build a local image from the approved source first.
Recommend a public GHCR image with release and commit tags plus a recorded digest;
registry ownership/name and publication need separate approval. Customers can
build it themselves or mirror it into their registry. AWS supports
[OCI images in ECR](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-push.html).
Publish only after local image checks and Nil's AWS acceptance. Pin deployments
to a digest, not `latest`. No registry operation is authorized in this slice.

Manual AWS acceptance, for Nil after implementation and spend approval:

1. Record the source commit, image digest, architecture, AWS runtime, disk,
   proxy, and date. Configure the persistent mount, private port, HTTPS names,
   setup secret, restart policy, and single-writer replacement policy.
2. Open the HTTPS office. Check that a wrong setup key fails, a correct key
   creates one owner, and a second claim cannot replace that owner. Remove the
   setup secret from the deployment. Invite a second member and check access.
3. Connect the required providers, run real agent turns, use the terminal, and
   save a file under `/var/data/workspaces`. Check a browser preview using the
   existing browser implementation; any failure returns to PM's browser lane.
4. Register an app that stores a counter in its data directory. Check HTTPS,
   sign-in, access restrictions, and WebSockets on its child hostname. An unknown
   child hostname must not serve the office. Check Stop, Start, and Delete;
   keep another running app and a stopped app for the replacement check.
5. Restart only the office process: the running app must remain available.
   Replace the container, then reboot the host: owner, provider login, project
   file, counter, and app start/stop intent must remain. Confirm only one office
   writes the volume. Active turns may be interrupted and are not a pass criterion.
6. Restore a stopped-volume snapshot to an isolated test mount and verify it
   with the recorded image. Record failures and resource use; close the test
   deployment only after confirming which data must be retained.

Unknowns that block a support claim: Darwin's deployment contract, working
provider login behind that ingress, CPU architecture, storage semantics, load,
and completed image/AWS acceptance. September 24 morning is the target, not a
verified delivery promise. The next decision is approval of this contract and
reference path; do not silently drop apps or alter providers to meet the date.

Future documentation surfaces: `docs/self-hosted.md`, `deploy/render/README.md`,
the new container README, and applicable deployment guidance in
`server/system-prompt.ts`, per [documentation index](documentation.md).
This design changes none of those surfaces and removes no test assertions.
