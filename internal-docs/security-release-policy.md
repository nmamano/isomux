# Security-release policy

> Status: design, nothing decided. Drafted 2026-08-02 by Isomuxer5, reviewed
> by Reviewer5. Task d2a4a381, follow-up from `control-plane-design.md`'s ops
> floor. The release marker, sticky detection data, and private reporting path
> described below were implemented 2026-08-13 without deciding the fleet policy.
> Companion reading: `release-design.md` (the update trigger this extends),
> `scripts/update.sh`, `server/update-checker.ts`, `server/update-trigger.ts`.

## The gap

`release-design.md` picked customer-clicked updates (option B), and that is
right for features. It means the fleet fragments by design: a box runs
whatever release its owner last clicked, forever. For a security fix that is
not a version-spread problem, it is a box still running the vulnerable code
with nobody obliged to notice. Ruling 3 removes the obvious fix - we hold no
SSH access to a live box, so we cannot push anything.

Three things are missing, and only the second is really about mechanism:

1. Nothing marks a release as a security release. `server/update-checker.ts`
   compares CalVer tags; every release looks the same to a box.
2. Nothing reaches a box whose owner ignores the banner.
3. We cannot see what any box runs. `GET /api/version` is authenticated, and
   `/readyz` deliberately carries no deployment state ("minimal body, no
   deployment state" - `server/routes/table.ts`). So "the fleet is patched"
   is currently unmeasurable, not just unmet.

## Implemented machinery

Nil Mamano owns vulnerability response. Reports go privately to
`llc@isomux.com` as documented in `SECURITY.md`.

`scripts/release.sh --security [tag]` creates the ordinary annotated CalVer tag
and GitHub Release, and adds one exact line to the Release body:

```
isomux-severity: security
```

The release checker treats only that complete, case-sensitive line as the
marker. On updater-managed boxes it walks published, non-draft,
non-prerelease CalVer release history to a complete short page. It exposes the
newest marked release after the running tag as sticky data, even when a later
ordinary release exists. `releases/latest` remains the existing banner target.
The banner and update behavior do not consume the new field. A failed page or
malformed response does not publish a new result. The hourly scan uses two
GitHub calls normally, three at 100 releases, and refuses after 21, below the
anonymous 60/hour budget. At 2,000 releases it keeps the prior whole status
until the mechanism changes rather than publishing an incomplete all-clear.

This baseline does not remove the owner from the update loop. It creates no
control-plane route, credential, box check-in, SSH path, or remote command
channel. A failed update still follows `scripts/update.sh` recovery and remains
visible to the owner through the updater status file. Isomux has no evidence
that an owner applied the release.

## What already exists

The box can already update itself without a human at the keyboard. On
installer-built boxes `server/update-trigger.ts` launches the updater with
`systemctl start --no-block isomux-update@<tag>.service`, a root-owned
template unit started under a polkit rule scoped to the service user, the
start verb, and an anchored CalVer unit pattern.

So auto-apply needs **no new authorization** - the grant already covers any
CalVer instance and belongs to the whole service user. That is a narrow
point: auto-apply is still a significant policy change, because it removes
the owner from the loop and lets a marker in a remote release initiate a
root-executed dependency sync.

The safety net is real but narrower than "it rolls back". `update.sh`
recovers the checkout if install or build fails, snapshots the state root
with the service stopped, and restores that snapshot if the new version
fails its readiness poll. System packages from the deps sync are additive
and **not** undone - the script says so itself - and recovery can itself
fail, which ends in a status file and a human.

## Designating a security release

`update-checker.ts` polls `releases/latest` hourly and compares CalVer. Two
things need adding.

**A marker.** The cheapest place is the GitHub Release body, which the
checker already fetches and `pickRelease` currently discards: one
machine-readable line, e.g. `isomux-severity: security`. No new file, no new
endpoint, and it renders harmlessly in the notes. `scripts/release.sh` would
take a flag that writes it; today it creates the release with
`--generate-notes` and sets no body of its own.

**Stickiness.** `releases/latest` is not enough: if a security release is
followed by a feature release, a box three releases behind sees only the
newest and learns nothing. The checker has to ask whether *any* release
between the running tag and latest is marked, which means walking
`GET /releases` - one or more calls following Link pagination until the
running tag is reached, filtered to CalVer, published, non-draft, no
prereleases (what `releases/latest` already implies). Caching a last-known
security floor avoids rescanning history hourly and keeps this inside the
60/hour anonymous budget.

**The repo is public**, which constrains timing more than the marker does. A
security fix is visible to anyone watching main the moment it is pushed, so
fix and tag have to land together; merging quietly and tagging a week later
publishes the vulnerability and withholds the remedy. There is also no
`SECURITY.md` today, so a finder has no non-public way to report anything.

## Reaching the fleet: the candidates

**A. Banner only (today).** Zero work, zero reach. Fine for features.

**B. Escalated banner.** A marked release turns the banner red and
persistent, with a modal on load. Small change, honest, and still entirely
dependent on someone opening the office.

**C. Auto-apply, security releases only.** The box applies a marked release
itself after a grace period, during which the owner can click sooner or
defer. This is option C from `release-design.md` narrowed from "all updates"
to "security releases", which is what makes it tolerable: the scheduling
policy still exists - wait for no agent mid-turn, up to a hard deadline, then
apply anyway, with fleet-wide jitter - but it runs a few times a year rather
than continuously.

Two risks. It widens the trust boundary `release-design.md` already flags,
since the target release's `deploy/install.sh` runs as root during deps sync
and no human now approves that hop; the mitigation is process, not code - the
release serves Nil's own office first, and the fleet applies on a jittered
delay. And a failed auto-apply leaves the box on the vulnerable release
silently, with packages from the failed deps sync left behind. That makes
reporting a dependency, not a nicety.

**D. Email from the control plane.** We have the address from Google sign-in
and never needed the box for it. It reaches the person who is not looking at
the office. Not a mechanism on its own; it is what makes B or a deferred C
land.

**E. Provider power actions.** Under ruling 3 our only physical lever is the
provider API: power off, or pull the DNS record. The last rung, and only for
a vulnerability that endangers someone other than the box's owner.

## Seeing whether it worked

Auto-apply without reporting cannot distinguish "fleet patched" from "fleet
silently rolled back". Options:

- **Blind.** No telemetry, no claim. Honest only if we never state a fleet
  number.
- **Box check-in.** The box posts its name, running release and last update
  outcome to the control plane on a schedule. No user data, no conversation
  content, nothing model-related. It is still a phone-home from a box we
  promised to stay out of, so the payload goes in the terms.
- **Unauthenticated version on the box.** Rejected: it reverses a deliberate
  choice and publishes to attackers which boxes are unpatched.

Check-in is the only one that makes the window verifiable, and the only place
this policy asks to walk back a little of ruling 3.

## Who owns it, and what we publish

Nil, because there is nobody else. What matters is that it stops being
folklore. The written version is four steps: confirm the report, land fix and
tag together, mark the release, watch the fleet reach the target. Everything
else here is machinery for step 4. For self-hosters my recommendation is the
marker and the escalated banner and nothing more, since auto-applying to a
box we do not rent is a bigger call than it looks (decision 9).

The reference competitor publishes no window and ruling 5 points toward
mirroring them (decision 5). Either way an internal target has to exist, or
there is nothing to run the ladder against. One copy dependency:
`site/hosted.html`
says "When a new release is out, your office tells you and you apply it with
one click." If auto-apply ships, that sentence is no longer complete.

## Decisions for Nil

1. **Mark security releases, and how.** *Recommend: a machine-readable line
   in the GitHub Release body, with the checker walking every release between
   the box's tag and latest so the mark is not buried by the next feature
   release.*
2. **Fleet mechanism for hosted.** Escalated banner (B), auto-apply (C), or
   banner-plus-email and accept the stragglers. *Recommend: C for marked
   releases only, with D alongside. The authorization and the readiness
   rollback already exist, so the cost is the policy, not the plumbing.*
3. **Grace period before auto-apply.** *Recommend: 72h, with an in-office
   "apply now" and a "defer once" that cannot push past the deadline.*
4. **The internal target.** Two numbers: a fix released within X of a
   confirmed report, and Y% of the fleet on it within Z of release.
   *Recommend: 7 days for a confirmed high-severity report, and 100% within
   7 days of release - achievable only under C.*
5. **Publish a window externally?** *Recommend: no, matching the reference.*
6. **Fleet version visibility.** Blind, or a minimal box check-in.
   *Recommend: check-in - name, version, last update outcome, nothing else -
   disclosed in the terms. Without it, auto-apply failures are invisible and
   decision 4 is unmeasurable.*
7. **The last rung for a box that never patches.** *Recommend: provider
   power-off only for a vulnerability that endangers third parties, with
   notice; never for a self-harming one. Write the distinction down before an
   incident.*
8. **`SECURITY.md` with a private reporting address.** *Recommend: yes. A
   public repo with no reporting path gets its vulnerabilities disclosed in
   issues.*
9. **Self-hosters get auto-apply?** *Recommend: no. Marker and banner only.*

## Doc surfaces this would touch

`site/hosted.html` (the one-click sentence), `README.md` and `SECURITY.md`,
`docs/features.md` (update behaviour), `release-design.md` (option C stops
being deferred), `control-plane-design.md`'s ops floor, and `api/chat.ts` if
the fleet policy becomes something visitors ask about.
