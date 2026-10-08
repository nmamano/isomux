# Access and invites

How to claim an office, invite people, add your own devices, and get back in.

## Who can do what

An office has two roles. An owner creates members, sends them sign-in links, sets which rooms each member can open, revokes sessions, and changes office settings. A member works in the rooms an owner gives them and adds their own devices.

Agents run shell commands as the server's user, so every member effectively has shell access to the server. Only invite people you trust.

## Claim the office

On first boot the office has no owner, and the server answers only on its own machine. The server prints a setup link in its terminal and log, such as `http://localhost:4000/setup#key=...`. Open the link in one of two ways:

- On the machine itself, open the link.
- From another machine, open a tunnel with `ssh -L 4000:localhost:4000 <user>@<host>`, and then open the link in that machine's browser.

Enter a display name and submit. You are the owner. Until someone claims the office, the server prints the same link on every boot.

The link carries the setup key. The key is also in `~/.isomux/setup-key` on the server, and the claim deletes it. If `ISOMUX_SETUP_KEY` is set, the office uses that value as its key: container, [Render](hosting-render.md) and [Kubernetes](hosting-kubernetes.md) offices do this, and their setup guides show where to find it.

## Invite a member

1. **Create the member.** In `Settings`, select `New member` at the end of the `Members` list. Fill in the name, owner role, room access, profile prompt and avatar, and click `Create member`. The list shows "never signed in" until they accept a link.
2. **Send a sign-in link.** Open `Settings` → `Office` → `Invites`, select the member and click `Create sign-in link`. The URL shows once. Send it privately (Signal, text, email).

A sign-in link works once and expires 24 hours after you create it. A new link replaces the member's previous one. If a link expires, the member stays as they are: send a new one. The link still works after you rename the member; deleting the member revokes it.

The invitee opens the link and is signed in. No installs, no accounts, no passwords. On first sign-in, the page asks for their language. A browser that is already signed in as a different member cannot accept the link.

`Outstanding invites`, in the same pane, lists every unused link with its token prefix. Revoke any of them there.

## Add your own devices

Open `Settings` → `You` → `Sign-in links` and click `Generate device link`. The URL shows once. Open it on the other device, and you are signed in there as yourself.

A device link works once and expires after 1 hour. You can have one at a time: a new link replaces the previous one. The pane also lists your unused device links and your active sessions.

If you are signed out of every device, you cannot make a device link. An owner sends you a sign-in link, the same as for a new member.

## Sign out and revoke sessions

`Sign out`, at the bottom of `Settings`, ends the session on this device. Your other devices stay signed in.

To end a session on another device, revoke it. Owners see every session in `Settings` → `Office` → `Sessions`. Every member sees their own in `Settings` → `You` → `Sign-in links`. An open tab on that device disconnects within about a second.

Isomux refuses to sign out or revoke the last owner session in the office. Sign in on a second device first.

A session ends after 30 days without use, and after 1 year in any case. Server restarts keep sessions.

## External access on a self-hosted office

Until you turn on external access, the office answers only on its own machine or through an SSH tunnel. To open it to other devices, first make the machine reachable: see the [private Tailscale](hosting-private.md), [Tailscale Funnel](hosting-funnel.md) and [own domain](hosting-domain.md) guides. Then:

1. Open `Settings` → `Office` → `Access`.
2. Turn on `Enable external access` and enter the `Public URL`, the address other devices open (for example `https://my-mac-mini.<your-tailnet>.ts.net`).
3. Save. Copy the sign-in link that the pane shows. It expires after 1 hour.
4. Restart Isomux: `systemctl --user restart isomux` for a user service, `sudo systemctl restart isomux` for a system one.
5. Open the sign-in link at the new address.

Hosted offices show their address in the `Access` pane, read-only. Isomux manages it.

## Locked out as owner

If you lose your only owner session (cleared cookies, the 1-year cap, etc.), mint a sign-in link on the box while the office runs. The admin socket answers only root: agents run as the office's own user, so it refuses that user.

```
sudo curl -s --unix-socket /home/isomux/.isomux/admin.sock -X POST http://localhost/admin/owner-login -H 'Content-Type: application/json' --data '{"name":"<your-display-name>"}'
```

The response's `url` is a one-time sign-in link, valid for 15 minutes. The socket is `.isomux/admin.sock` in the home directory of the user that runs Isomux (`/home/isomux` on a VPS install). `bun run server/isomux-office.ts owner-login --name "<your-display-name>"` prints the command with this office's path.

In the container image (Docker), run it in the container as root:

```
docker exec <container> curl -s --unix-socket /var/data/home/.isomux/admin.sock -X POST http://localhost/admin/owner-login -H 'Content-Type: application/json' --data '{"name":"<your-display-name>"}'
```

On Render, run the `curl` part of that command in the service's Shell. It works only if that Shell runs as root, which is unchecked.

On Kubernetes, run it in the `recovery` container:

```
kubectl -n isomux exec deployment/isomux -c recovery -- curl -s --unix-socket /run/isomux-admin/admin.sock -X POST http://localhost/admin/owner-login -H 'Content-Type: application/json' --data '{"name":"<your-display-name>"}'
```

How access works inside the server (cookies, state files, origin checks) is in the [security audit](security-audit.md#appendix-access-internals).
