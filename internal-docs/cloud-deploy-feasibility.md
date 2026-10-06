# cloud.isomux.com: deploy from main automatically (feasibility)

Superseded 2026-10-06: Hosted Isomux left Vercel for one Docker host, which
deploys from main by itself (`control-plane/README.md`, "Deploying from main").

Task f87752d1. Written 2026-10-05 by Isomux Worker 5. No provider writes were
made. The provider facts below come from read-only Vercel and GitHub API calls
on 2026-10-05; the vendor facts come from the Vercel docs pages linked inline,
read on the same day.

## The gap today

- **isomux.com** is the Vercel project `isomux`. It is linked to GitHub
  `nmamano/isomux` with production branch `main`, no Root Directory, and the
  build from the repository-root `vercel.json` (`bun install && bun run
build:demo && bun run build:docs`, output `site`). Every push to `main`
  deploys it with Git source. Example: commit 708374c2 deployed at
  2026-10-05T05:31:41Z, and the Build workflow on the same commit started at
  05:31:42Z. So the landing page does not wait for CI. It has no Deployment
  Checks.
- **cloud.isomux.com** is the Vercel project `isomux-control-plane`. It has
  **no Git link** (`link: null`). Its settings: Root Directory
  `control-plane/web`, "include files outside the root directory" on, framework
  `nextjs`, and the install command
  `cd ../.. && test -f control-plane/web/package.json && bun install --frozen-lockfile && cd control-plane/web && bun install --frozen-lockfile`.
  The last four production deployments all have source `cli`: 2026-08-26,
  2026-08-27, 2026-09-06 and 2026-10-05T05:16Z.
- The team `nmamanos-projects` is on the **Hobby** plan.
- GitHub: `main` has no branch protection and no rulesets. The repository has
  no Actions secrets and no self-hosted runners. It has the environments
  `Preview` and `Production`, which the Vercel integration of `isomux` uses.
  The Build workflow takes about 6-7 minutes (runs on 2026-10-03 and
  2026-10-05). Its check runs on a commit are named `build` and `web`.

## What `production-phase.ts --redeploy` does

Source: `control-plane/deploy/production-phase.ts` (`main`, from about line
1050). In order:

1. **Local harness check.** It starts `control-plane/web/e2e/production-probe.ts
--preflight` and refuses if the local probe runtime cannot start.
2. **Source check.** It refuses when a runtime path under `control-plane/`
   that HEAD carries has uncommitted changes. Documentation changes and paths
   that HEAD does not carry do not stop it (`tree-state.ts`). It records the digests of the files the artifact
   replaces.
3. **Project check.** By the Vercel API, it proves the project name, the team
   (same as the landing project), the exact install command, and the Root
   Directory and framework settings (`judgeSettings` in `vercel-preview.ts`).
4. **Domain check.** It proves that `cloud.isomux.com` is attached and
   verified, has no conflicts and no open challenges, and that its live CNAME is
   exactly `7f093b64d7196cf5.vercel-dns-017.com`.
5. **Database identity and schema.** By the Neon API, it proves that the
   `production` branch is the one default branch with no parent. Then it opens
   the production database with the **owner** role through `Store.open`. That
   call runs the additive `SCHEMA` (`create table if not exists`), the late
   indexes and the audit-sequence seed, and it refuses a database whose tables
   or columns are older than the code (`assertSchemaIsCurrent`, which checks
   the whole `PRODUCT_TABLES` roster). It does **not** run the
   owner migrations (`migrate*` in `control-plane/bootstrap.ts`, or
   `cli.ts migrate-customer-ssh-key`). Those stay separate operator steps.
6. **Row counts.** It reads the counts of `accounts`, `name_reservations`,
   `instances` and `operations`. It requires each to be readable and at least
   one account.
7. **Environment.** It reads the env inventory and requires exactly 2 Preview
   and 11 Production entries of the approved names and types. In redeploy mode
   it **writes no env** and generates no secret. It does not read the OAuth,
   mint or Stripe files. It still reads the Vercel token and the database
   credentials (below).
8. **Artifact.** It runs `git archive HEAD` into a temporary directory, removes
   the root `vercel.json`, and replaces the root `package.json` and `bun.lock`
   with `control-plane/deploy/vercel-root/*`. It proves that the transform is
   exact and that the repository did not change.
9. **Deploy.** It runs `vercel@58.9.1 deploy --prod --yes` from that
   directory.
10. **After the deploy**, inside one failure boundary (`afterInvocation`): it
    finds this run's deployment, waits for `READY`, and judges the build log
    (Next detected, two frozen installs, no unresolved module, no landing build).
    It re-reads the row counts, waits for TLS (already present on a redeploy),
    runs the **anonymous** production probe suite against
    `https://cloud.isomux.com` (providers, sign-in page, signed-out redirect, no
    credential names reflected), and re-reads the rows, the domain attachment
    and the env inventory.
11. **Rollback.** If a step after the deploy fails or throws, it **detaches
    `cloud.isomux.com` from the project**. It does not restore the previous
    deployment. The site is down until an operator runs
    `control-plane/deploy/attach-phase.ts`. On 2026-08-13 a local probe import
    failure detached a healthy deployment this way (`control-plane/README.md`,
    "Next hosted release"). That is why step 1 exists.

The secrets it reads: `~/nil/secrets/vercel.token` (Vercel API),
`~/nil/secrets/neon.token` (Neon API) and `~/nil/secrets/control-plane-neon.env`
(the owner role of the production database). All three paths are fixed in
source (`vercel-api.ts`, `exercises/neon-api.ts`).

## What a plain Vercel Git integration skips

With a Git link, Vercel clones `main` and builds with the project settings. No
command from this repository runs. Of the list above:

| Step                                     | Git integration                                                                                                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1-2 harness and clean tree               | Not needed: Vercel builds the commit, not a working tree.                                                                                                                               |
| 3 project settings proof                 | Skipped. The settings apply but nothing re-proves them.                                                                                                                                 |
| 4 domain and CNAME proof                 | Skipped. Vercel assigns the domain.                                                                                                                                                     |
| 5 Neon identity, additive schema, schema-currency refusal | **Skipped.** Nothing creates new tables, indexes or the seed, and nothing refuses a stale schema. See "The rule every option must meet" below.                                                        |
| 6 row counts                             | Skipped.                                                                                                                                                                                |
| 7 env inventory                          | Skipped. The env is not changed by either path; Git builds use the same Production env.                                                                                                 |
| 8 artifact transform                     | **Skipped.** The build then installs a different dependency set from the proved artifact. See below.                                                                                    |
| 9 deploy                                 | Done by Vercel on each push.                                                                                                                                                            |
| 10 build judgement, anonymous probe      | Skipped. A failed build is never promoted; a bad runtime is not caught.                                                                                                                 |
| 11 rollback                              | Replaced by Vercel Instant Rollback (below).                                                                                                                                            |

**On a Git checkout the install command installs the office dependencies.**
It runs `bun install --frozen-lockfile` at the repository root, and in a Git
checkout the root holds the office `package.json` and `bun.lock`, not the pair
in `control-plane/deploy/vercel-root/`. I have no evidence that this fails:
the office root also declares `pg` and `@types/pg`, its `postinstall` is only
`git config core.hooksPath .githooks 2>/dev/null || true`, and the CI `web` job
runs the same root install before `ci:web`. But it is a much larger install
than the proved artifact, and the build that ships would not be the one
`artifact.ts` describes (its swap exists so that `pg` and its types resolve
from an ancestor of `control-plane/`). To keep the proved shape, do the swap
inside the install command:

```
cd ../.. && test -f control-plane/web/package.json && cp control-plane/deploy/vercel-root/package.json package.json && cp control-plane/deploy/vercel-root/bun.lock bun.lock && bun install --frozen-lockfile && cd control-plane/web && bun install --frozen-lockfile
```

The copy writes the same bytes on the CLI artifact, which already holds them.
This needs a code change: `INSTALL_COMMAND` in `control-plane/deploy/artifact.ts`,
because `--redeploy` refuses when the project command differs from it.
Unchecked until a Git preview build runs it.

The root `vercel.json` (the landing build) should not apply. Vercel reads
`vercel.json` "at the project root"
([project settings](https://vercel.com/docs/project-configuration/project-settings)),
and the monorepo examples put it in the app directory
([monorepos](https://vercel.com/docs/monorepos)). With Root Directory
`control-plane/web` that is `control-plane/web/vercel.json`, which does not
exist. No doc page states it for a Git build in plain words, so the same preview
build must prove it (`judgeBuild`'s `landingBuildCommandAbsent`).

## The rule every option must meet

Isomux PM ruling, 2026-10-05: a deploy path that relies on an operator step
before affected pushes is not acceptable. Every recommended option must keep,
automated and before production promotion, what `production-phase.ts` does in
step 5: the live schema refusal and the additive table, index and seed work of
`Store.open`.

`Store.open` is not "all migrations". It runs `SCHEMA`, the late indexes and
the seed, and it refuses stale tables or columns. The owner column migrations
(`migrate*` in `bootstrap.ts`, `cli.ts migrate-customer-ssh-key`) are not run
by `production-phase.ts` today, and no option below runs them. With the
refusal in front of promotion, a commit that needs one of them is held: the
old code keeps serving until an operator runs the migration. Whether the
deploy path should also run them is a separate question for the PM (see the
end).

## Options

### A. Plain Vercel Git integration: rejected alone

Plain Git integration builds and promotes without running any command from
this repository, so it cannot run the schema step before promotion. It meets
the rule only with one of the two mechanisms in A1 and A2. These parts are
common to both:

- **Git link:** `nmamano/isomux`, production branch `main`.
- **Install command:** the swap above.
- **Skip unrelated commits:** "Skipping unaffected projects" needs npm, yarn,
  pnpm or Bun workspaces ([monorepos](https://vercel.com/docs/monorepos)); this
  repository has none. So use the Ignored Build Step "Only build if there are
  changes in a folder", or the custom command
  `git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- ..` (it runs in the Root
  Directory, so `..` is `control-plane/`). Exit 0 skips; exit 1 builds
  ([project settings](https://vercel.com/docs/project-configuration/project-settings)).
  The web imports only from `control-plane/` (checked by grep on 2026-10-05).
  Vercel clones with `--depth=10`
  ([configure a build](https://vercel.com/docs/builds/configure-a-build)); when
  the previous SHA is outside that depth or empty, `git diff` fails and the
  build runs. That fails toward building, never toward promoting: promotion
  stays behind A1's or A2's gate. A skipped build still counts against the 100
  deployments per day of Hobby.
- **Previews:** a Git link also builds every pushed branch as a Preview
  deployment, with the Preview env (the preview database DSN and its
  `AUTH_SECRET`). Fork pull requests need authorization (`gitForkProtection` is
  `true`), and previews are behind Vercel Authentication
  (`all_except_custom_domains`). CI does not run the Vercel build, so a Preview
  is the only check of the Vercel build configuration before production.
- **Rollback:** Instant Rollback points the domain back to an earlier
  production deployment; on Hobby, only to "the immediately previous
  deployment". After a rollback, "Vercel turns off auto-assignment of
  production domains" ([Instant Rollback](https://vercel.com/docs/instant-rollback)).
  The old CLI deployments were aliased to production, so they are eligible. A
  rollback restores code only, not database state: tables the schema step
  added stay. They are additive, so the old code runs against them, the same
  as today after `--redeploy`. Unlike the script's detach, the site stays up.
- **Setup lock:** two documented settings keep production from changing while
  the link is new. With "Auto-assign Custom Production Domains" off, a
  production deployment "won't automatically be served to your production
  traffic", and it stays "Staged" until somebody promotes it
  ([promoting a deployment](https://vercel.com/docs/deployments/promoting-a-deployment)).
  With the Ignored Build Step "Only build preview", a production build is
  canceled ([project settings](https://vercel.com/docs/project-configuration/project-settings)).
  Both go on before the Git link, so it does not matter whether connecting
  starts a build.

### A1. Git integration + a GitHub schema job as a Deployment Check

- **Mechanism:** a third job, `production-schema`, in `.github/workflows/build.yml`.
  It runs only on `push` to `main`, with `needs: [build, web]`, in a GitHub
  environment whose deployment branch policy allows `main` only. It checks out
  `GITHUB_SHA` (the pushed commit, which is the commit Vercel builds), proves
  the production branch identity, and runs `Store.open` from that commit. Vercel
  Deployment Checks require this job, so the deployment is "not automatically
  assigned to your custom domains until all Deployment Checks are met"
  ([Deployment Checks](https://vercel.com/docs/deployment-checks)). Because the
  job needs `build` and `web`, red CI also blocks it, and the schema step never
  runs for a commit that CI refused.
- **Credentials in GitHub:** the production owner credentials (`Store.open`
  needs CREATE; a least-privileged role cannot run it, `store.ts` at
  `openRuntime`). The identity proof needs either the Neon API key as a second
  secret, or new code that compares the session's branch to a pinned id
  (unchecked). Environment secrets "are only available to workflow jobs that use
  the environment"
  ([GitHub environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)).
  The repository is public, so its Actions logs are public.
- **Failure mode:** the job fails (stale schema, unreachable database, wrong
  branch) and the deployment stays unpromoted; the old code keeps serving. If
  the job passes and the Vercel build then fails, the additive schema is
  already applied for code that did not ship. That is safe for the old code
  and is the same order as `--redeploy` today (schema before deploy).
- **Hard prerequisite:** Deployment Checks on the Hobby plan. The changelog of
  2025-10-09 says "available for all projects connected to GitHub
  repositories" and names no plan. **Unchecked.** Deployment Checks also
  require auto-assignment on, so A1 turns the setup lock off at the end,
  and only after every selected check, `production-schema` included, is
  configured and has been seen to hold a deployment on a red run.

### A2. Git integration, staged builds + a promoter on this box (recommended)

- **Mechanism:** auto-assignment stays **off for good**, so every Git
  production build of `main` is staged and serves nothing. A job on this box
  (an Isomux cronjob or a systemd user timer; every few minutes; one run at a
  time, under a lock) does, in order:
  1. **Select the candidate.** The tip of `origin/main` often has no build of
     its own, because the Ignored Build Step cancels commits that do not
     change `control-plane/`. So the candidate is the newest commit C on
     `main` that has a staged production deployment in state `READY`, with no
     change under `control-plane/` between C and the tip
     (`git diff --quiet C <tip> -- control-plane`). The web build reads
     nothing outside `control-plane/` (grep, 2026-10-05), so C ships the same
     code as the tip. If a newer commit changes `control-plane/` and its build
     is not `READY` yet, there is no candidate: wait. A candidate older than
     the deployment now serving is never chosen, so an older commit never
     replaces a newer one.
  2. Require green `build` and `web` check runs on C (`gh api`).
  3. Check out C clean. From it, run the Neon identity proof and `Store.open`
     against production, the same code as `production-phase.ts` step 5, with
     the same row-count read. Refusal: stop, no promotion.
  4. Re-prove the domain and the env inventory (steps 4 and 7).
  5. Re-check the selection (step 1) against the current tip; if it changed,
     stop and let the next run start again.
  6. Promote: `POST /v10/projects/{projectId}/promote/{deploymentId}`
     ([promote API](https://vercel.com/docs/rest-api/projects/point-production-traffic-to-a-given-deployment)).
     The API can answer 202, so the job then reads the project until its
     current production deployment is C's deployment, within a bound. If it
     is not, alert and stop.
  7. Run the anonymous probe against `https://cloud.isomux.com`. On failure,
     alert (Isomux PM message); do not detach.
- **Rollback (hard prerequisite, unresolved):** an operator rollback must
  stay in force, so while the project reports a rollback the job promotes
  nothing and alerts. Two parts are unproved:
  - Which project field reports a rollback (`lastRollbackTarget` is present
    on the project record, read 2026-10-05; its meaning is unchecked).
  - How a rollback ends with auto-assignment still off. Vercel documents that
    Undo Rollback, from the dashboard or by `vercel promote`, re-enables
    auto-assignment ([Instant Rollback](https://vercel.com/docs/instant-rollback),
    "Undo a rollback"). With auto-assignment on, the next push goes live
    without the schema step or CI, so Undo Rollback is not a recovery path
    for A2.
- **Credentials:** the three that `production-phase.ts` reads today, where
  they live today (`~/nil/secrets/vercel.token`, `neon.token`,
  `control-plane-neon.env`). Nothing goes to GitHub.
- **Failure mode:** every known failure before step 6 leaves the old
  deployment serving and retries on the next run. After step 6 the outcome
  can be unknown (a 202, then no confirmation within the bound): the job does
  not retry and does not probe; it alerts and stops, because it cannot tell
  which deployment serves. If this box is down, nothing is promoted
  and the old code keeps serving. If the schema step passes and the promote
  fails, the additive schema is applied ahead of the code, as in A1 and as in
  `--redeploy` today. The schema step runs with CI already green and the build
  already `READY`, so it never runs for code that cannot ship.
- **No Deployment Checks needed**, so the Hobby question does not block A2.
- **Code:** a new script that reuses the `production-phase.ts` pieces for
  steps 3-4, plus the selection, lock, promote and confirmation.
  `production-phase.ts` itself changes too. The CLI docs describe
  `vercel --prod --skip-domain` to stage one deploy; what a plain
  `vercel deploy --prod` does while the project setting is off is unmeasured.
  If it stages, `--redeploy` would probe the old deployment and report success
  on code it did not serve, so it must promote explicitly or refuse.

### B. GitHub Action that runs `production-phase.ts --redeploy`

A workflow on `workflow_run` of Build, `conclusion == success`, branch `main`,
with a diff check for `control-plane/` (the `workflow_run` event has no path
filter). It keeps every proof in the list above. A `workflow_run` success alone
is not enough:

- It must check out `github.event.workflow_run.head_sha`, not the default
  branch tip, because the script deploys `HEAD`.
- It must not let an older run deploy over a newer one. Use one `concurrency`
  group with `cancel-in-progress: false`, and refuse before the deploy unless
  `head_sha` is still the tip of `main` (`git ls-remote`).

The rest:

- **Secrets in GitHub:** the Vercel token (account-wide: it can also deploy
  isomux.com), the Neon API key (the whole Neon project, including branch
  create and delete) and the production owner credentials (full read and write
  of customer rows). The repository is public, so its Actions logs are public.
  The script prints only booleans by design, but a future print regression
  would publish there.
- **Code changes:** the three secret paths are fixed under the home directory,
  so the workflow must write them as files with mode 0600, or the code must
  read them from the environment.
- **Bad deploy:** the script detaches the domain on any post-deploy failure,
  including a flaky probe. Unattended, that takes cloud.isomux.com down with no
  one present, and only a manual `attach-phase.ts` run brings it back.
- **Wait for CI:** built in, through `workflow_run`.

### C. A job on this box that runs `--redeploy`

An Isomux cronjob or a systemd timer on this box polls `origin/main`, waits
for green `build` and `web` check runs on the tip commit (`gh api`), checks
that commit out clean, and runs `--redeploy` on it. It deploys only the tip, so
an older commit cannot replace a newer one. The secrets stay where they are
now. It keeps every proof, including the schema step before the deploy. It has
the same unattended-detach risk as B, and it depends on this box being up.

## Recommendation

**Option A2, on one condition:** a proved way to end an operator rollback
with auto-assignment still off, and a proved rollback indicator (see A2,
"Rollback"). Without them A2 is not recommended. With them, A2 meets the PM
rule (the schema refusal and the additive work
run, automated, before every promotion, from the exact commit being promoted),
adds no secret anywhere, does not depend on Deployment Checks being on Hobby,
and fails safe: every failure before the promote leaves the old code serving,
and nothing detaches the domain. Vercel builds from Git, so the CLI artifact
upload goes away. Its cost is a new script and a dependency on this box being
up; a down box delays a release, it does not break one.

A1 is the alternative if the PM prefers GitHub to this box: it needs Hobby
Deployment Checks (unchecked) and the production owner credentials in a GitHub
environment. C keeps every proof with no new code but keeps the unattended
detach. B has the detach and also puts three production secrets in GitHub.

Like C, A2 runs a production promotion with no agent in the loop; the PM
classifier refuses the agent-run deploy command, and Nil authorizes the job
once.

Order of work, each step gated:

1. **Code (this lane, after the PM rules):** change `INSTALL_COMMAND` to the
   swap form; write the promoter script and its tests; make
   `production-phase.ts --redeploy` safe with auto-assignment off; update
   `control-plane/README.md` (the deploy section and the deployment order) and
   the PM push-checklist line in the `isomux-manager-session` skill.
2. **Provider changes for Nil to approve**, on Vercel project
   `isomux-control-plane` only (isomux.com is not touched), in this order:
   1. Install Command: the swap form, in the same sitting as the code merge
      (`--redeploy` refuses while the two differ).
   2. Environments → Production → Branch Tracking: turn off "Auto-assign
      Custom Production Domains". It stays off.
   3. Ignored Build Step: "Only build preview".
   4. Git: connect `nmamano/isomux`; production branch `main`.
   5. Preview proof: push one branch that touches `control-plane/` and read the
      Preview build log (install swap, no landing build, Next output). This is
      a Preview deployment, not production.
   6. Ignored Build Step: "Only build if there are changes in a folder",
      folder `control-plane` (or the custom `git diff` command above). From
      here, pushes to `main` make staged production builds; none serves.
   7. Turn on the promoter job (Nil's authorization).

   Production cannot change before step 7: steps 2 and 3 are on before the
   link, and step 6 still only stages. No GitHub settings change is needed.

## Findings that stay open

- **Hobby Deployment Checks:** unchecked; vendor docs name no plan. It blocks
  A1 only.
- **Rollback recovery for A2:** unresolved hard prerequisite. Undo Rollback
  re-enables auto-assignment, so A2 needs a proved way to end a rollback with
  it still off, and a proved rollback indicator.
- **CLI deploy with auto-assignment off:** unchecked whether `vercel deploy
  --prod` stages. It decides the `--redeploy` change in A2.
- **Preview proof:** whether the root `vercel.json` stays out of the build and
  whether the install swap works on a Git checkout. Both are measured by one
  Preview build before any production build.

## Open questions for the PM

- A2 or A1, and Isomux cronjob or systemd user timer for A2's job.
- Should the deploy path also run the owner column migrations
  (`bootstrap.ts` `migrate*`)? `production-phase.ts` does not today; with the
  schema refusal in front of promotion, a missing migration holds a release
  until somebody runs it.
- Keep branch Preview deployments for every branch, or build Preview only on
  request? They are the only check of the Vercel build before production.
- Outside this task: the team is on the Hobby plan, and Vercel restricts Hobby
  "to non-commercial, personal use only"
  ([Hobby plan](https://vercel.com/docs/plans/hobby)). cloud.isomux.com takes
  payments.
