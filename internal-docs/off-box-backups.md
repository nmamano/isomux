# Off-box backup copies

> Status: hosted add-on request and provider-snapshot proxy implemented; the API
> does not expose direct add-on health, and one restore-classification decision
> remains for Nil. Initial design
> drafted 2026-08-02 and reviewed by Reviewer5. Implementation decisions below
> were approved by Isomux Manager and Reviewer2 on 2026-08-13 for tasks
> 903ce4c6 and 624f38d0. They are not Nil rulings unless stated.

Companion reading: `backup-restore.md` and `control-plane-design.md`.

## Product boundary

There are two backup layers.

- Every office makes a verified local archive of its state root. This covers a
  deleted or damaged file while the VPS disk still works.
- A hosted office asks the VPS provider for its Automated Backup add-on. The
  control plane monitors provider snapshot rows as a proxy. The API does not
  identify which rows came from the add-on, so it does not directly prove
  add-on health.

Neither layer backs up control-plane state. The provisioner state can contain a
temporary private key until revocation. A snapshot could restore a key after
the control plane proved that it was destroyed. The Fly volume therefore keeps
scheduled snapshots off. A separate control-plane recovery design needs its own
threat model and must preserve key destruction structurally.

The hosted promise remains narrow: box loss only. The control-plane proxy checks
for a provider snapshot no more than 26 hours old. The published
promise can remain "at most 24 hours old"; the two-hour margin is an alerting
tolerance, not a promise expansion.

## Local archive publication

`server/backup.ts` never writes to a final backup name. It:

1. checks free bytes without deleting an existing backup;
2. writes a unique partial file in the destination filesystem;
3. accepts GNU tar exit 1 only as a warning and rejects exit 2 or higher;
4. walks the complete archive with `tar -tzf`;
5. renames the verified partial to a final name;
6. writes a marker containing the final file's size and modification time; and
7. only then prunes the oldest verified archive and marker pairs to seven.

A marker whose size or modification time no longer matches does not verify its
archive. An unchanged invalid legacy archive gets an invalid marker, so the
hourly scheduler does not read the same corrupt gigabytes again. If that file
changes, it is checked again.

A same-day second successful run gets `-2`, then `-3`, and so on. Retention
orders verified files by modification time, not ASCII filename order.

Before a later run, the minimum free space is the newest verified archive size
plus the larger of 25% or 256 MiB. A first run needs 2 GiB free because no prior
archive gives a sizing basis. These are refusal thresholds, not archive-size
limits. A short write still fails verification and never publishes.

After a low-space refusal, the hourly scheduler retries only the cheap free-space
check. It does not read the state root until the preflight passes. Existing
verified backups are never deleted to make room.

On scheduler startup, partial files left by a killed prior server process are
removed before free space is checked. Backup status is reconstructed from verified files and markers on disk after a
restart. No archive, a stale newest archive, and a failed attempt after the
newest archive do not read as success.

## Hosted request and verification

The official Contabo API, read 2026-08-13, provides the required operations:

- instance create accepts an `addOns` object;
- `POST /v1/compute/instances/{instanceId}/upgrade` accepts `backup: {}` for
  the Automated Backup add-on;
- `GET /v1/compute/instances/{instanceId}/snapshots` lists snapshot identifiers,
  instance identifiers, creation times and automatic deletion times; and
- `POST /v1/compute/instances/{instanceId}/snapshots/{snapshotId}/rollback`
  exists, but this load does not call it.

Source: [Contabo API](https://api.contabo.com/), sections "Upgrading instance
capabilities", "List snapshots", and "Revert the instance to a particular
snapshot based on its identifier", read 2026-08-13.

New hosted instance requests include `addOns: { backup: {} }`. The create
response proves only that the order was accepted. It never proves backup
coverage. The provisioner reads every snapshot page and verifies that every row
belongs to the requested instance. Missing pagination, incomplete pages, a
foreign row, an invalid date, a timeout, and a provider error all fail closed.

The control-plane snapshot watch runs on startup and then at most hourly:

- no snapshot during the first 26 hours is pending, not verified;
- no snapshot after that window raises critical attention;
- a newest snapshot more than 26 hours old raises critical attention;
- evidence that cannot be read raises warning attention; and
- a later fresh snapshot clears only backup-related attention.

The endpoint does not distinguish manual snapshots from Automated Backup rows.
A fresh manual snapshot can satisfy this proxy while the add-on is unhealthy.
The existing operator loop therefore prints "provider snapshot" rather than
"backup coverage". The exact durable prose is listed in
`control-plane/README.md`.

Provider credentials stay in the provisioner environment. No storage
credential is installed on a customer VPS. The provider snapshot contains the
customer VPS disk, including office data and model credentials stored there. It
does not contain the provisioner's temporary private key, which exists only on
the separate provisioner volume.

## Restore boundary

This load does not automate provider rollback. A rollback may delete newer
snapshots, and the access classification is not settled. The operator must:

1. identify the failed instance and newest observed provider snapshot;
2. record the snapshot timestamp and expected data-loss window;
3. obtain the required customer incident authority if the action is classified
   as console access;
4. use the provider rollback operation;
5. wait for power, DNS, TLS and `/readyz`; and
6. verify sign-in, state version compatibility and the next provider snapshot.

Fine-grained restoration from a local tarball needs root access to the running
box. A hosted customer has that path only if they supplied an SSH key. Without
one, the provider whole-disk rollback is the available box-loss path.

## Retention

- Local: seven finalized, verified archive-marker pairs.
- Hosted off-box: provider Automated Backup retention. Isomux observes the
  newest provider snapshot time as a proxy and does not delete snapshots.
- Control plane: no backup. Scheduled Fly volume snapshots remain disabled.

## Still needs Nil

1. **Provider rollback classification.** Is it administrative, like reboot and
   reinstall, or customer-authorized console access under ruling 11? This
   decides the terms copy and whether an operator can start a box-loss restore
   without a per-incident customer request. Open as of 2026-08-13.
2. **User-facing backup copy.** The draft in `docs/features.md` needs Nil's copy
   approval before push. It describes what the user gets and does not expose the
   internal evidence mechanism.

Customer-owned object storage, backup download UI, and broader restore promises
remain deferred. They are not hosted launch blockers for this mechanism.
