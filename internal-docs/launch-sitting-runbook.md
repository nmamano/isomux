# Hosted launch sitting runbook

Parked 2026-08-22 by Isomux PM on Nil's instruction. This document is the
complete, self-contained plan for the one sitting that takes Hosted Isomux
live. It survives PM session resets; the board task `9f69ed8e` points here.
Nothing below runs without Nil present - the first third is his logins.

## State when parked (all verified 2026-08-22, ~02:30Z)

- `main` = `origin/main` = `2d568f3` = published release tag `v2026.8.22`
  (CI-gated; GitHub Release live; `releases/latest` resolves to it).
- isomux.com fully deployed through `2d568f3`: three truth-checked policy
  pages, prices beside plan names, agent-readable site. Verified live.
- Provisioner (`isomux-provisioner` on Fly) runs the current build; probe
  fully accepted. The SSH-key retention sweep is live (no eligible rows
  existed at deploy; both stored keys were already null).
- Production database carries the multi-office migration: the
  `name_reservations.account_id` UNIQUE is dropped, the plain lookup index
  exists, rows preserved (before/after probes in the 2026-08-22 PM session).
- cloud.isomux.com still runs the 2026-08-13 web build. The redeploy is
  env-gated shut by design: production Vercel holds 9 env entries and the
  approved shape needs 11 (the four live Stripe entries are the gap).
- Branch `launch-domain-flip` @ `e722066` is committed, reviewer-approved
  (384 lines / 59ce1bd9), deliberately UNMERGED. It carries the
  OFFICE_DOMAIN flip to isomux.app, the 40-per-7-days signup bound, and the
  four launch-status copy flips (hero "Sign up" -> cloud.isomux.com, Plans
  paragraph, two chatbot passages). All its customer copy is Nil-approved.
- Real-channel validation (task `65e0ceeb` second half): GREEN, task done.
  Reviewer 3 verified PASS 2026-08-22 ~02:25Z against logs and git: hosted
  file-staging install of real v2026.7.23 on the Hetzner box, then the
  two-invocation bridge to v2026.8.22 - both arms in the right order,
  polkit-authorized owner trigger (service uid, not root), dependencies
  converged by effect (bubblewrap installed on invocation 2), final office
  at v2026.8.22 @ `2d568f3` with the Apps tab live. The follow-up
  uncorrected (tag-present) run confirmed a real but non-blocking gap:
  dependency convergence gates on tag state instead of recording whether
  deps synced - filed as task `032743c0`, R3-ruled not a launch item
  (normal installs and the real customer bridge both converge). Evidence
  archived at ~/nil/evidence-archives/65e0ceeb/; the Hetzner test box
  holds the live reproducer state until next needed.
- test-nil: attention card stays (truthful); box 203525282 cancel-scheduled,
  service ends ~2026-09-20. Signup is closed ("no price configured").

## The sitting, in order

Step 0, PM pre-checks (no Nil needed): re-run the domain checklist
pre-checks (`internal-docs/hosted-launch-domain-checklist.md`): Cloudflare
zone for isomux.app, DNS state, live instance-record read. Confirm the last
site deploy is READY and the 65e0ceeb validation verdict is green.

Step 1, Nil in the Stripe Dashboard (live mode; the terms URL also in test
mode):
0. Public details MUST carry the Terms of service URL (https://isomux.com/terms)
   and Privacy policy URL (https://isomux.com/privacy) before any customer
   checkout: our sessions require ToS consent (checkout.ts:263, Managed
   Payments compliance), and Stripe refuses to render the consent box
   without the URL - proven the hard way in test mode 2026-08-22. Nil
   started filling live-side values that night (plus support email
   llc@isomux.com, URL https://isomux.com); verify saved.
1. Accept Managed Payments terms; confirm account + each sold Product
   passes eligibility review.
2. Tax: sign off `tax_behavior=exclusive` and the final tax code - review
   the Managed-Payments-eligible list for a code closer to SaaS/hosted
   offices than the tentative `txcd_10701410`. Assign it to every Product
   that can appear in Checkout; re-open each and verify the stored value.
3. Create live USD recurring Prices (Entry, Poweruser) with
   `tax_behavior=exclusive`.
4. Mint the restricted `rk_live_` key: Subscriptions read, Invoices read,
   Checkout Sessions read and write (the documented minimum; the code
   refuses an `sk_live_` account key at client construction).
5. Public details: set the terms-of-service URL to exactly
   `https://isomux.com/hosted-terms` and privacy to
   `https://isomux.com/hosted-privacy` - the Dashboard values must equal
   our pages, in BOTH test and live mode (Checkout's consent checkbox links
   the Dashboard value, not our page).
6. Enable a customer portal configuration (the intended card-change path;
   none exists today - measured 2026-08-21).

Step 2, Nil -> secrets file: the `rk_live_` key and the two live price IDs
into the staging env file, single-quoted values, mode 0600. Never printed,
never shell-sourced; verify with boolean greps and file metadata only.

Step 3, PM: `bun control-plane/deploy/production-phase.ts --stage-live-env`.
Expects exact start inventory 9 (Preview 2 + legacy Production 7), stages
the four Stripe entries, re-proves exact 13, then hard-stops. Operator
refusals are legible: "refusing: production already matches the staged live
environment target" means already done; "PARTIAL PRODUCTION ENVIRONMENT -
no reconciliation attempted" means stop and investigate. Note (R1): the
README's dated 2026-08-11 redeploy proof was at 2+7; the sitting's redeploy
is the first at 2+11, and "nine-entry" means two different things on that
page - read `control-plane/README.md:1202` context before relying on it.

Step 4, PM: test-mode Checkout proof (billing-cli openCheckout): session
creation succeeds AND the created session carries
`consent_collection.terms_of_service = "required"`. Until Dashboard step
1.5 lands, every test-mode session create fails at creation by design
(the `f6da59d` commit message documents the two affected callers).

Step 5, PM: web redeploy (`--redeploy`). Ships: terms consent, signup
policy links, cloud favicon, multi-office dashboard. Verify the favicon,
the signup-page policy notice, and that a signed-in account sees its
office(s).

Step 6, PM: domain flip. Rebase `launch-domain-flip` onto main - the known
conflict region is `control-plane/signup.ts` ~345-385 where the multi-office
legacy-constraint catch and the bound's post-INSERT arm meet: preserve
BOTH. If the rebase conflicts non-trivially, spin a quick review before
merging. Then ff-merge, push (the site auto-deploys: the hero flips to
"Sign up", chatbot copy goes live), and deploy web + provisioner from that
same commit.

Step 7, PM with Nil watching: one disposable production-domain office
through all gates - signup on Nil's account (multi-office makes this
possible), payment (live mode - a real charge on his card; refund manually
per the refund policy afterwards), DNS, certificate, installer, liveness.
Retire it after.

Step 8, acceptance row: one clean 7-day-policy row with a real customer SSH
key, completing the two remaining evidence gaps: the instant webhook
trigger leg, and the full auto chain through installer and certificate.

Step 9, copy decisions (batched at the sitting):
- Capacity refusal wording: today "we cannot accept another office signup
  yet; try again later" - R4 flags "another" (reads as already-owns-one)
  and "later" (can be days). Reword or keep.
- Legal pages date treatment: "Last updated" vs an effective date.
- Active-sessions docs sentence: default is Nil's shipping version (the
  reviewer alternative is recorded in task `65e0ceeb`).
- Upgrade-path UX (from the 65e0ceeb rerun, proven working): a
  v2026.7.23-era box reaches v2026.8.22 only after TWO owner update
  clicks, and between them the office reports a bare commit sha with no
  release name. Only pre-v2026.8.22 boxes hit this; fresh installs get the
  latest release in one pass. Decide whether that interim state is
  acceptable to leave as-is for launch.

Step 10, after every gate is green: announce. Launch is open.

## Post-launch queue (not the sitting)

Account deletion command (`68e45dff`), then strengthen the privacy deletion
promise; operator alerting implementation (`4cde32f8`; design merged in
`internal-docs/operator-alerting-design.md`, go/no-go with Nil); provisioner
Stripe key to read-only (`ad6ca394`); web-owned Stripe ops behind a
provisioner seam (`ddebcdb6`); PSL submission stays backlogged (`1e28f3f5`).

## Standing dates

2026-08-29: cp2 runbook obligations + customer-pass teardown check
(`75a97096`, scheduled reminder exists). ~2026-09-20: box 203525282 service
ends; delete the provider-side SSH secret `isomux-cp-run-3b167d31...` at
teardown.
