# Agent-built apps

> Status: direction, not a build plan (2026-08-05). Idea: Nil. Written up by
> Isomux Brainstormer.
> Companion reading: `port-proxy-design.md` (the transport and auth layer this
> sits on, and which this changes in two places), `hosted-isomux-design.md`
> (domain shape), `server/identity/tokens.ts` (the token model).

## The idea

Today an agent's useful output is a conversation. Sometimes it builds a web app,
serves it on a port it picked, and tells the boss to go look. The app dies when
the session ends, the port is folklore, and nothing outside that chat knows the
app exists.

The direction: an office is not just agents, it is the agents plus the apps they
run for you. An agent builds an app, registers it with isomux under a name, and
isomux runs it as a service from then on. It has a stable URL you can open from
any device, it survives the agent that built it, and it can message that agent
when something happens inside it. The loop closes: the agent builds the app, the
app tells the agent what users did, the agent acts on it.

That is a different product sentence than "chat with several agents at once".

## What has to exist

### 1. An app registry, and isomux owns the ports

An agent does not pick a port. It registers an app - name, start command, working
directory - and isomux allocates the port and passes it in as `$PORT`. The
registry maps name to port; nothing else needs to know the number.

This deletes a live problem rather than adding a feature. The agent system prompt
currently tells agents to "pick an uncommon port and keep it" because several
agents share a box and collide on 3000 and 5173. Allocation from one place ends
that.

**Prior art: portless** (`vercel-labs/portless`, Apache-2.0, a Vercel Labs
experiment). It is this exact mechanism for local development: an HTTPS reverse
proxy holding a hostname-to-port route table, allocating the port itself and
passing it in as `$PORT`, so you open `https://myapp.localhost` and never think
about a number. Worth reading before building this section, and the license lets
us borrow from it with attribution. The detail most worth taking is flag
injection - allocating the port is the easy half, and frameworks that ignore
`$PORT` need a `--port` argument injected per framework, which is knowledge
otherwise rediscovered one framework at a time.

Reference rather than dependency, and the disqualifying reason is topological
rather than a matter of taste: portless binds 443 with its own local CA, and on
an isomux box Caddy owns 443 and terminates TLS for the office. Supporting
reasons: it is CLI-only with no documented library API, it needs Node 24 where
isomux runs Bun, and it is pre-1.0 with a state directory format its README says
may change between releases, which is a poor foundation with self-hosters to keep
working. Its TLS and naming model is also the half we cannot use at all: a
`.localhost` name and a locally trusted CA resolve on the machine running the
browser, and the problem this design exists to solve is a phone reaching a box in
another country. That is what section 4 is for.

### 2. A supervisor, so apps outlive sessions

Apps are systemd user units, generated and owned by isomux. Agents never write
unit files; they call an API and isomux writes, starts, and enables the unit.

Systemd over an isomux-managed child process because it brings restart policy,
journald logs, reboot survival, and cgroup resource limits for free. Resource
limits are not a nicety: on hosted, one customer's runaway app is the failure
mode, and `MemoryMax` plus `CPUQuota` per app is the answer already used for the
daemon itself.

User units are not free on every install, which is the one thing this transport
costs. A tailnet box that runs isomux itself with `systemctl --user` already has
everything. A box built by `deploy/install.sh` does not: isomux runs there as a
system unit under a service account nobody logs into, so logind never starts
that account's user manager and `systemctl --user` has no bus to reach. The
installer therefore enables linger for the account and gives the service
`XDG_RUNTIME_DIR=/run/user/<uid>` through a drop-in, then checks the bus answers
before reporting success; the dependency sync the updater runs from the target
release applies the same to boxes installed before apps existed.

Linger is also where the boundary really sits. "Agents never write unit files"
above is the API, not an enforced rule: agents run as the account the units
belong to and can write `~/.config/systemd/user` themselves, and with linger on
whatever they put there survives logout and reboot exactly like a registered app
does. Enforcing the sentence would take a separate Unix identity for the
supervisor, which the user-unit transport does not have.

Surface: an Apps tab beside Cronjobs - name, state, restart count, screenshot preview, logs, stop and
delete. Cronjobs are the precedent for "a thing isomux runs that is not an
agent"; apps are the second one.

### 3. Ownership: apps belong to the user, not the agent

An app that dies with its author is a demo. The registry entry is owned by the
user; the agent that built it is attribution and a default message target. Kill
the agent, the app keeps running. Retarget or orphan its messages.

**This contradicts `port-proxy-design.md`**, which has shares expire in hours and
die with the agent. That rule is right for its case (a scratch dev server exposed
for a look) and wrong for this one. Both should exist: ephemeral shares keep the
short leash, registered apps do not.

### 4. Naming and access

Reuse the transport already designed. A registered app gets a stable hostname on
the per-customer wildcard the hosted design already provisions
(`*.apps.<name>.isomux.app`), so `hello.apps.nil.isomux.app` needs no new
certificate work. Whether to flatten that to `hello.nil.isomux.app` is cosmetic,
and costs a reserved-name list so an app cannot claim `www` or `api`.

**Shipped flat** (Nil, 2026-08-06): an app answers at `hello.<office host>`,
with no `apps.` tier and the reserved-name list guarding the office namespace.
The parent domain is derived from the office's public origin - there is no
configuration key - so an office published over https has app hostnames the
moment its DNS and terminator carry them.

Hosted readiness now proves that an unguessable, instance-stable child name
resolves only to that office's IPv4 address, with no AAAA answer, before the
office becomes ready. This is the same `verify_https` step that already waits
for the manually created office A record. The operator creates the office A and
wildcard A records together; an earlier negative lookup can otherwise stay
cached while the ticker retries, whose backoff caps at five minutes.

Per-app origin rather than per-user path (`nil.isomux.app/hello`) for the two
reasons already argued in the port-proxy doc: the app sees itself at the root so
frameworks do not break, and one app's compromise does not reach a sibling app's
storage. The office session cookie is host-only and never reaches either.

Access is the existing office login through the same handshake. Logged into
isomux on your phone, apps just work; no per-app password, no tailnet
requirement, no anonymous access. That is also the honest limit of the privacy
question: apps are private to the office users who can already see the agent's
room, and there is no public-app story in this direction.

**Second contradiction with `port-proxy-design.md`**: it forbids recycling
hostnames, because origin state can survive deletion. Nil accepted that state as
the smaller harm than permanently losing a wanted URL (2026-08-15). Deleting an
app frees its name and port, and a later registration of that name reuses the
lineage's most recently issued hostname. Existing generated labels do not move;
if a rollback issued `hello-g2`, later versions keep `hello-g2`.

Safety is server-held registration identity, not browser cleanup. Every
registration advances a persisted registration generation. Mint codes, app
sessions, HTTP relays and both WebSocket legs bind the hostname label and that
generation. Delete stays synchronous: stop and remove the unit, close in-flight
routes, purge codes and sessions, revoke the persistent app API token, and only
then remove the registry row so the name and port become reusable. This order
also makes a partial delete safe to retry. The code and session maps are
in-memory and disappear on restart; that fact is required by the legacy-state
identity derivation. Persisting either map later requires revisiting the
derivation.

A pre-auth response can send `Clear-Site-Data` after reuse as a courtesy. It is
not a safety boundary. Surviving origin state is the accepted tradeoff for never
losing a wanted URL. The filesystem has a separate rule: delete moves the data
directory to `apps/data/.retired/<name>-<deletedAt>`, so the replacement starts
with an empty directory.

### 5. Apps message their agent

isomux starts the app, so it injects a scoped token the same way agents get
theirs (`ISOMUX_APP_TOKEN`). The app's server side holds it; browser JavaScript
never sees it. Capability: message its owning agent, touch its own storage,
nothing else - not spawning agents, not the task board, not other agents' logs.

Three things this needs that agent tokens do not:

- **Persistence.** Today tokens are in-memory only, justified by the fact that a
  server restart kills every subprocess that holds one. Apps are the first
  consumer that outlives isomux, so app tokens are the first that must survive a
  restart, hashed at rest per the existing secrecy rule. The alternative is
  isomux restarting every app unit after boot purely to re-inject, which throws
  away the reason to use systemd.
- **Rate limiting, because messages cost money.** A message wakes an agent and
  burns model tokens. An app in a loop is a bill. Per-app rate limit, and a
  visible daily cap.
- **Labelling.** App-origin messages are not boss authority and not agent
  authority, same rule the system prompt already states for agent-to-agent
  messages.

The other direction needs nothing: an agent can already curl its app's local
port.

### 6. Data, and being in the backup set

Each app gets a data directory isomux creates and hands over. It exists so app
state is somewhere known rather than scattered wherever the agent felt like
writing, and so it lands in the existing backup set instead of being discovered
missing after a restore.

### 7. The convention in the system prompt

None of the above happens unless agents reach for it by default. The system
prompt's current advice - pick an uncommon port, expect the server to die with
your session, hand the boss an SSH tunnel - gets replaced by: register the app,
isomux runs it, give the boss the URL. Per `documentation.md` this is guidance
for every isomux deployment, so it belongs in `server/system-prompt.ts` rather
than office memory.

## Rulings (Nil, 2026-08-06)

1. **Shelf.** Apps are private to one office. There is no ecosystem phase - no
   template registry, no cross-office installs, and nothing here should be
   built ahead of time on that assumption.
2. **No approval click.** Registering an app installs and starts it with no
   human confirm. Principle: anything humans can do, agents can do.
3. **No app cap** beyond a sanity check, same as tasks, cronjobs, and rooms.

## Open questions

1. **What happens on update?** Apps are agent-written code sitting outside the
   isomux release. An isomux update must not break them, and there is no story
   yet for an app whose dependencies rot.

## Rough phasing

1. Registry, port allocation, systemd units, Apps tab. Local and tailnet offices
   get the whole feature here, since ports are already reachable on a tailnet.
2. App tokens plus app-to-agent messages. Closes the loop; still no new
   networking.
3. Stable hostnames on the port-proxy transport. This is what makes it work from
   a phone and on hosted, and it is the piece that waits on the hosted control
   plane provisioning wildcard DNS and certificates.

Order matters: 1 and 2 are useful on their own on the box isomux already runs on,
and 3 is the expensive part that depends on hosted infrastructure that does not
exist yet.

**Phase 3 shipped 2026-08-07** (task f51fe505; commits d1d1fb2, ec5794f,
5abf799, 39a8ba0, 73765ce, cc00e1b, 5bcdcbe, dcf0eac, ca7c29f, b955eaa), and it
did not wait on hosted: one generic design, where a self-hoster adds a wildcard
DNS record and the installer's Caddy block obtains certificates on demand.
