# Off-box backup copies

> Status: design, nothing decided. Drafted 2026-08-02 by Isomuxer5, reviewed
> by Reviewer5. Task 903ce4c6, follow-up from the restore drill (962965dc).
> Companion reading: `backup-restore.md` (the runbook this extends),
> `control-plane-design.md` (rulings 3 and 4, which constrain every option
> here).

## The gap

`server/backup.ts` writes a daily tarball of the state root to
`$ISOMUX_BACKUP_DIR` (default `~/isomux-backups`), keeps 7, and nothing
copies it anywhere. The directory sits outside the state root, so a restore
cannot clobber it - but it is the same disk. Hence `backup-restore.md`'s
"restoring onto a new box" opening with step 0, "have the tarball somewhere
other than the dead box", which is an instruction to have already solved the
problem.

Two facts that shape the answer:

- **The archive is sensitive, and partly a credential.** Under the default
  state root it holds `codex-home/auth.json`, so a copy hands over the
  customer's Codex credentials, plus every conversation, memory and
  attachment. (`backup-restore.md`'s qualification applies: a provider home
  redirected outside the state root is not in there.) It does **not** hand
  over office sign-in - invites and sessions persist hashed
  (`server/auth.ts`: "raw tokens never persist").
- **It is big.** Nil's office archives at ~1 GB/day; 7 copies is ~7 GB.

## Three different failures, three different answers

They get conflated. Separating them is most of the design.

| Failure | What covers it | Status |
| --- | --- | --- |
| Someone deleted something; state got corrupted | the local daily tarball | works today |
| The disk or the box died | a copy the box's disk does not hold | **missing** |
| The provider account, or isomux, goes away | a copy outside our control | **missing** |

Row 2 is what the hosted backup promise depends on. Row 3 is not a promise
anyone in this market makes; it needs storage outside our failure domain,
which customer-controlled satisfies but so would an independent custodian or
a customer-held key over storage we operate.

## Option 1: the provider's own backup add-on

Contabo, like every VPS provider, sells scheduled whole-disk snapshots kept
on the provider's storage. `hosted-isomux-design.md` already assumes we buy
this per box, and `control-plane-design.md` lists it as an unmodelled cost.

For hosted this is the strongest option and needs no isomux code. It is
genuinely off the box's disk, and it matches the promise ruling 5 says to
mirror: if a drive fails, the server comes back from a backup at most 24h
old. It does little for row 1 (a whole-disk rollback to recover one deleted
room is a sledgehammer) and nothing for row 3, since it lives in our
provider account.

**How it lands against ruling 3 is an open question, not a given.** If the
provider restores a snapshot as a blind disk replacement through the API, it
is administrative, the same class as reboot and reinstall, which the terms
already reserve as ours. If it runs through the rescue console - the thing
that can mount and read a disk - it falls under ruling 11 and is only
available on a customer's per-incident request, which makes it useless as an
automatic disaster response. Ruling 11 governs console sessions; it does not
classify snapshot restore, so this needs Nil rather than an inference.

To verify with Contabo: add-on price and retention depth, whether a snapshot
can be restored onto a different box, and which of those two mechanisms a
restore actually uses.

## Option 2: isomux pushes the tarball to object storage

A destination configured in the office; after each successful daily tarball,
the server uploads it. S3-compatible is the obvious target shape, but the
surface is larger than one PUT - signing, listing and deleting for retention,
multipart for large archives, and real differences between providers. The
config belongs in `office-config.json` behind an owner-only route rather than
an env var, so it stays inspectable like the rest of office settings.

**Who owns the bucket is the entire question.**

**Customer-owned.** They supply bucket and credentials; the tarball lands
somewhere we cannot read. This is one clean way to answer row 3, it leaves
rulings 3 and 4 untouched, and it costs us nothing. Cost: almost
nobody will do it. It asks a customer who bought "no server chores" to go
create storage credentials.

**Ours.** Convenient, and the only version most customers would ever have.
It also means holding a daily copy of every customer's Codex credentials and
private conversations, which is what rulings 3 and 4 exist to prevent.
Encrypting at rest with our own key changes nothing about who can read it; a
customer-held key does fix it, but then all we contribute is storage, and a
customer who loses the key has paid for nothing. The one gain over option 1
is surviving the loss of our provider account, a failure we would be present
for anyway.

My read: we should not hold customer archives, and the customer-owned
destination should ship anyway, since it is also the self-hosted answer.

## Option 3: the customer pulls

A download button, or a documented `scp`. The honest "export your data" path,
and it belongs in the product regardless - the cancellation grace week exists
so people can take their work. Not a backup story: it happens when someone
remembers, and it needs the box alive. Small scope but not free (an
authenticated streaming endpoint over ~1 GB archives, with concurrency and
abuse to think about).

## The self-hosted shape

Same feature, different default. A self-hoster has no provider add-on we
control, so option 2 with their own destination is the whole answer, and the
same code. `docs/features.md` should also say the low-tech version, which
needs no feature at all: a cron job on another machine running `rsync`
against `~/isomux-backups`. Today the docs never mention that the daily
backup is single-disk.

## Restoring, under zero standing access

Box loss is ours to fix: restore the provider snapshot or reinstall, subject
to the classification question above. State corruption on a live box is not.
The runbook needs a root shell, and a hosted customer only has one if they
supplied an SSH key at signup, which `control-plane-design.md` makes
optional. Without a key there is no restore path short of a whole-disk
rollback. That argues for pushing the signup key harder than "optional", or
for accepting that fine-grained restore is not a hosted capability. Either is
defensible; drifting into the second by accident is not.

## Cost

Provider add-on: Hetzner documents +20% of box price, Contabo's needs
checking. On an EUR 5.50 box that is roughly EUR 1/month against the EUR 8
Standard plan - real, and already anticipated in the pricing note on
`site/hosted.html`. Object storage is cents per box per month at ~7 GB, so
retention stays at 7 for the sake of one number in the product, not money.

## Decisions for Nil

1. **What the hosted backup promise covers.** Mirror the reference (drive
   failure only, at most 24h stale) or promise more. *Recommend: mirror it.
   It is what option 1 can deliver, and ruling 5 already points here.*
2. **Primary hosted mechanism.** Provider add-on, isomux-side push, or both.
   *Recommend: the add-on. No code, no customer action, no data of theirs in
   our hands, and the published promise is written for its shape.*
3. **How a provider snapshot restore is classified** - administrative like
   reboot and reinstall, or a ruling-11 console action. *Recommend: settle it
   once Contabo's mechanism is verified, and if it turns out to be
   console-class, say so in the terms rather than quietly using it.*
4. **Do we ever hold customer archives?** *Recommend: no, not even
   encrypted. Codex credentials and private conversations are in there, and
   the terms would have to admit it.*
5. **Ship the customer-owned destination in isomux?** *Recommend: yes, but
   not as a hosted launch blocker. It is the self-hosted answer and the only
   row-3 answer.*
6. **Off-box schedule and retention.** *Recommend: piggyback the existing
   daily tarball (upload on success, no second scheduler) and mirror the
   local 7.*
7. **How loud is a failing off-box copy?** Status field only, or an office
   banner after N consecutive failures. *Recommend: banner to the owner after
   3 days. A silent backup failure is discovered at the worst moment.*
8. **Encrypt before upload?** *Recommend: no in v1. The bucket is theirs, and
   a lost key is a worse failure than a misconfigured bucket. Say plainly in
   the setting's copy what the archive contains.*
9. **Add a "download this backup" button.** *Recommend: yes. Useful during
   the cancellation grace week, and it weakens every argument for us storing
   copies.*
10. **Is the signup SSH key still optional?** *Recommend: keep it optional
    but state what is lost, in the terms rather than during a support
    incident.*

## Doc surfaces this would touch

`docs/features.md` (the backup paragraph says nothing about single-disk),
`internal-docs/backup-restore.md` (step 0 stops being a wish),
`site/hosted.html` (any backup promise), `control-plane-design.md`'s ops
floor, and `api/chat.ts` if the feature list gains a destination setting.
