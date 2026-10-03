# Owner-login recovery without an agent route (design, task 636901c1)

Status: approved by Nil on 2026-10-03 (Option 1 with Option 1b). Implemented in task 636901c1.

## Problem

`server/admin-socket.ts` binds `<state root>/admin.sock` (mode 0600) and answers `POST /admin/owner-login` with a 15-minute owner sign-in URL. The file mode is the only check. Every agent, terminal panel and app runs as the server's OS user, so each of them can mint an owner URL in one call. The safety policy refuses the recognized command forms (this lane), but that is a guardrail: a Python one-liner or a renamed binary still connects.

## Constraints (Isomux PM, 2026-10-03)

1. The admin recovery RPC refuses the server's own uid, so a process that runs as that user (every agent) cannot mint a sign-in URL through it (Isomux PM, narrow reading). Other same-uid routes are residuals, below.
2. The control plane's `mint_invite` and `install.sh` `claim_owner` keep working while the office runs.
3. Operator recovery keeps working on installer boxes, Nil's office (systemd user service, owner has sudo), Docker, Render and EKS (non-root pod), or this doc says plainly which setup loses what.

## Facts the options depend on (checked 2026-10-03)

- Callers' privilege. `install.sh` refuses to run unless `EUID` is 0, so `claim_owner` runs as root. The control plane pipes `mint-invite.sh` over SSH as root, or through `sudo -n` when the login user is not root (`privilegeArgvFor` in `control-plane/handlers.ts`, the `mint_invite` handler). Both connect to the socket with `curl --unix-socket`.
- Peer UID in Bun. `Bun.serve` exposes no socket and no peer data (`requestIP` returns null on a Unix socket). `Bun.listen` exposes the accepted socket's `fd`, and `getsockopt(fd, SOL_SOCKET, SO_PEERCRED)` through `bun:ffi` returned the peer's pid, uid and gid (probe on this box, Bun 1.3.11, Linux). Not probed: a root peer (the kernel reports uid 0; inferred), macOS (needs `getpeereid` or `LOCAL_PEERCRED` instead).
- Containers. The image has no `USER` line, so `docker exec` runs as root by default. The entrypoint starts as root and drops to `node` before the office starts. Render starts the same image; whether the Render shell runs as root is unchecked. The EKS manifest sets `runAsNonRoot`, `runAsUser: 1000`, drops all capabilities and forbids privilege escalation, so `kubectl exec` runs as uid 1000, the same uid as every agent.
- Containers cannot stop only the office. `supervisor.py` relaunches the office 0-2 s after it exits; stopping the supervisor stops the container.

## Option 1: the socket answers only root peers

The server binds the socket with `Bun.listen` instead of `Bun.serve`, reads the peer uid with `SO_PEERCRED`, and closes any connection whose peer uid is not 0. It parses the one HTTP request itself (request line, `Content-Length`, JSON body), so the `curl` callers do not change. The recovery client is the system `curl` run by root (`sudo curl --unix-socket <state root>/admin.sock …`) or another root-owned client, never `bun run server/…` as root: `install.sh` clones the repo as the service user, so running it as root would hand root to anyone who can edit it. `admin-cli.ts` stays for printing the command or goes away.

| Setup | Result |
|---|---|
| Installer box | Works. `claim_owner` and `mint-invite.sh` already run as root. |
| Nil's office | Works with `sudo`. If the login user has passwordless sudo, an agent can also become root, and no option in this doc helps. |
| Docker | Works: `docker exec <container> …` without `-u node` is root. |
| Render | Works if the Render shell is root (unchecked). |
| EKS | Lost: no root in the pod. See Option 1b. |
| macOS local office | Works with `sudo` after a `getpeereid` branch (not probed). |

Cost: about 60 lines in `admin-socket.ts` (raw listener, peer check, minimal HTTP parse), a `bun:ffi` call per platform, and the recovery docs (the curl recipe replaces the `bun` CLI). Callers do not change. Nothing secret is stored.

### Option 1b: EKS recovery container

The pod gets a second container (`recovery`, same image, `runAsUser: 1001`) with `command: ["sleep", "infinity"]`. It must set `command`, not only `args`: the image `ENTRYPOINT` runs `entrypoint.sh`, which ignores appended arguments and always starts the supervisor. The socket moves to an `emptyDir` that both containers mount, and the office accepts peer uid 0 or the uid named in `ISOMUX_RECOVERY_UID` (a per-deployment value, so an env var fits). The recovery uid must differ from the office uid: the office always refuses its own uid, also when `ISOMUX_RECOVERY_UID` names it by mistake, and logs that the setting is ignored. The operator runs `kubectl exec deploy/isomux -c recovery -- curl --unix-socket … --data '{"name":"…"}'`. The image code under `/opt/isomux` is copied as root and is not writable by the office uid, and `curl` ships in the `node:24-bookworm` base. The socket file mode must let uid 1001 connect; the peer check, not the mode, is then the boundary. Cost: manifest change, one env var, the socket path becomes configurable. Without 1b, EKS recovery is offline only: scale the deployment to 0, run a one-off pod on the PVC (`ReadWriteOncePod`), scale back up.

## Option 2: root-held secret

Root creates a random secret in a root-only file and its sha256 in a root-owned file that the server can read but not write. Callers send the secret; the server compares hashes.

Coverage is the same as Option 1 (it depends on a root-only file, so EKS is lost the same way; a Kubernetes Secret mounted in the pod is readable by uid 1000, and an env var is readable through `/proc/<pid>/environ` by the same uid). It adds provisioning (installer, entrypoint, a manual `sudo` step on Nil's box and on existing installs), rotation, and a bearer secret that works from anywhere it leaks to. Both callers change to send it. No advantage over Option 1 where Bun can read the peer uid.

## Option 3: supervisor hold file (containers)

`supervisor.py` does not relaunch the office while a hold file exists. The operator creates the hold, stops the office, runs an offline `owner-login` that writes the invite into the state, and removes the hold. The office reads the invite at boot.

It has no RPC to refuse anyone: the hold file, the office process and the state are all reachable by the agent uid, and under `tini` a detached agent helper outlives the office, so an agent can run the same sequence. It is the residual class below, made into the recovery path. It covers containers only, restarts the office (all agents stop), and does not help `mint_invite` or `claim_owner`.

## Residuals (not closed by any option here)

The narrow reading closes the one-call RPC only. A process with the server's uid can still write auth state that the server loads at boot (for example an invite hash in `invites.json`) and can change the server's code, so after the next restart it can hold a sign-in it made itself. The safety policy blocks writes under the state root, but that is a guardrail. The fix for this class is OS-level separation: task 01f5038c (dedicated OS user for the server, P0).

## Recommendation

Option 1, with 1b for EKS. The admin RPC refuses the server's uid on every setup and answers only a non-agent identity (root, or the EKS recovery uid). It keeps both root callers unchanged and stores no secret. What changes for operators: recovery is a `curl` from root (`sudo` or a root shell), the Docker recipe drops `-u node`, and EKS uses the recovery container. Open points for review: a root-peer probe on a box with sudo, the Render shell user, and the macOS branch.
