# Post-release verification (mandatory)

**Maintained document.** Every release runs this playbook. A release is not
finished when `scripts/release.sh` publishes the tag - it is finished when
this playbook passes or its failures are recorded and dispositioned.

The reason it exists: local CI and the GitHub Build workflow prove the code
compiles and the suite passes. Neither proves a customer can install isomux
on a clean machine and reach a working office. That gap is exactly where
onboarding breaks, and onboarding is the highest-visibility surface the
product has - a new user's first ten minutes.

Written 2026-09-01 after v2026.9.1, whose batch changed provider sign-in,
the welcome-agent experience, and the auth-error notice path - all of them
first-run surfaces that no automated gate exercises end to end.

## When it runs

Immediately after `scripts/release.sh` reports the tag and the GitHub
Release is live. Not the next morning, not "when there is time": a broken
onboarding path ships to whoever installs in the meantime, and the fix is a
same-day patch tag (`vYYYY.M.D.N`), which is cheap only while the release is
fresh in someone's head.

If the playbook cannot run (no test box, provider outage, no operator
available), that is a REPORTED state, not a silent skip. Say so to Nil in
the release report, with what is unverified.

## What you need before starting

- **A test box, identified from the system of record.** Never from memory,
  a naming convention, or a port probe: query the control-plane database
  (`instances` joined to `subscriptions`) and read which offices are
  customers and which are tests. Provider consoles show boxes, not
  customers - a box named like a test can be someone's office. Touching a
  customer box destroys a customer office; if the record is ambiguous, stop
  and ask Nil.
  Creating, rebuilding, or cancelling any box is a billing action and needs
  Nil's word.
- **The published tag.** The installer resolves `releases/latest`, so the
  release must be published, not drafted, before stage A means anything.
- **A previous-release office** for stage B. If the test box is being used
  for stage A, stage B needs either a second box or a stage-A run kept at
  the old tag first (install old, update to new, then rebuild and install
  new). Prefer install-old-then-update: it exercises both paths on one box
  and in the customer's actual order.

Two install paths exist and they are not the same test. A HOSTED office is
provisioned by the control plane; a SELF-HOSTED office is installed by the
unattended installer on a raw VPS. Stage A below is the self-hosted path.
Run the hosted path too whenever the release touches provisioning, boot, or
first-run behaviour - it is the path paying customers take.

## Stage A - fresh install on a clean box

1. Rebuild the test box to its base image.
2. Run the unattended installer exactly as the docs tell a customer to run
   it, with no local overrides. Capture the whole output to a file.
3. Watch for: the installer resolving the NEW tag (not a stale cached one),
   the service coming up enabled, and TLS/domain steps completing.
4. Claim ownership through the documented first-owner path.

**Pass criteria:** the installer exits 0, the service is active after a
reboot, and the claim flow produces a working owner session.

## Stage B - update from the previous release

1. On a box already running the previous release, run `scripts/update.sh`
   as a customer would.
2. Watch for: the bun pin (a mismatch WARNS and rolls back on the installed
   bun - see `internal-docs/release-design.md`), state migrations, and the
   service restarting into the new version.
3. Confirm the office's existing state survived: agents, rooms, tasks, and
   any provider sign-ins that were present before the update.
4. Reach the office FROM OUTSIDE THE BOX. This is not the same check as the
   updater's, and on 2026-09-01 it was the only one that failed.

**Pass criteria:** the update completes, the version reports the new tag,
no pre-existing state is lost, and the office's public URL serves - proven
by an external request, never by a loopback one.

The updater declares success on a loopback `/readyz` poll, so every check
that runs on the box agrees with it by construction. On 2026-09-01 the
service was active, `/readyz` answered over loopback, agents worked, and the
office had been off the internet since the update, because Caddy was dead.
Anything that only asks the box how it is doing cannot see that class at
all.

## Stage C - the onboarding walk

Do this as a user, in a browser, not with curl. The point is to see what a
new customer sees.

1. Three welcome agents exist (Claude, Codex, OpenCode).
2. **Message the free OpenCode welcome agent first.** It must answer with no
   sign-in and no subscription. This is the promise the product makes to
   someone who has not connected anything, and it is the single most
   important check in this playbook.
3. Message a signed-out Claude agent and a signed-out Codex agent. Each must
   produce ONE short notice plus the in-chat sign-in card - not a wall of
   text, not a raw provider error, not a "you are signed in" dead end.
4. Complete one real provider sign-in through the card, then message that
   agent again and confirm it answers.
5. Sign out through the card and confirm the state reverts.

**Pass criteria:** every step above, plus: no message anywhere in the flow
tells the user to do something impossible on that box (install a CLI that is
already installed, sign in to an account that is already connected, run a
command that does not exist there).

## Stage D - environment-shape checks

The box is where environment assumptions get tested, because a developer box
has years of accumulated state that a customer box does not - and the
inverse: a customer box lacks things a developer box has.

1. **Service PATH.** Probes that shell out (`which`, binary lookups) resolve
   under the SERVICE's PATH, not a login shell's. Confirm every
   install/presence check agrees with reality on this box.
2. **Provider directories.** Probes that read credential files must resolve
   the effective configured directory, not a hardcoded home path.
3. **Absent-tool paths.** Whatever the box genuinely lacks, exercise one
   flow that depends on it and confirm the guidance is correct.

## Disposition

Record every finding as a board task before deciding anything.

- **Onboarding is broken** (stage C fails at step 1, 2, or 3): fix forward
  today with a patch tag. A new user cannot get started; nothing else in the
  release matters as much.
- **A path is wrong but recoverable** (bad guidance, cosmetic, a flow that
  works with a workaround): file it, fix it in the next batch, and say
  plainly in the release report that it shipped.
- **The playbook could not run:** report which stages are unverified. Never
  let "not run" be read as "passed".

Then update this document with anything the run taught: a check that would
have caught the failure earlier belongs here, not in a transcript.

## What the v2026.9.1 run taught (2026-09-01)

The run found a stop-ship defect on the update and fresh-install paths, and
it also found several ways a verification run can lie to itself. Both are
worth keeping.

**Ask the system, not the box.** Covered in stage B above, and it
generalises: for every pass criterion, ask which vantage point can observe
it. A criterion only checkable from inside the thing under test is not a
criterion.

**A test that stubs the mechanism proves the branching, not the
behaviour.** The failing code shipped with its own test suite, green. The
suite stubbed `systemctl`, so it proved which commands the script calls and
could never observe that a real `systemctl restart` returns 0 while the
process it started dies milliseconds later. That assumption was baked into
the code and its test at once, which is why passing tests were no defence.
When a release changes something that only a real service can exercise,
this playbook is where it gets exercised - that is the whole reason the
playbook exists downstream of CI.

**The rig must reproduce the condition before its results count.** A fresh
office booted with a PATH that omitted the Claude CLI showed a signed-out
Claude agent giving install instructions. Reported as a P0; it was the rig.
On a box where the CLI is installed, the same release shows the sign-in
card. Before filing anything against onboarding, prove the office resolves
what you think it resolves - and prefer a real box, which cannot have this
class of rig error.

**Know which stage a check belongs to.** Welcome agents seed once, on a
fresh office's first owner claim. An UPGRADED office keeps whatever set it
was created with, so "three welcome agents exist" is a stage-A/C-on-a-fresh-
office check and says nothing on a box that updated. A second false P0 came
from applying it to the wrong stage.

**Identify and photograph the box before touching it.** Query the control
plane (instances joined to subscriptions) and record hostname, instance
identity and test-versus-customer status; then, over SSH and BEFORE
updating, record the trust repo's resolved tag and the service checkout's
`git tag --points-at HEAD`. Both were missing on 2026-09-01, and the
pre-state had to be recovered from the updater's own derived value.

**Say which range you actually ran.** The available box was two releases
behind, so the run exercised v2026.8.25 to v2026.9.1 and the
previous-release path went untested - as did the target release's own
updater changes, because an update runs the INSTALLED updater, which is the
old one. Name the range and name what the old updater therefore never
executed.

**Stage A has a part that needs no box.** Confirm the GitHub Release is
published and not a draft, that `releases/latest` resolves to the new tag,
that the tag points at the intended commit, and that the installer the docs
tell a customer to fetch is byte-identical to the one in the tree. Those
four take a minute and gate whether the rest of stage A means anything.
They are not a substitute for an install on a clean box.
