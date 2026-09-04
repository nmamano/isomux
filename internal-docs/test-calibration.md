# Test-retention calibration

Temporary decision paper for Nil, measured 2026-09-04. This round changes no tests.

## Decision proposed

Keep a test only when all applicable checks below pass. A failed check makes the test a cut candidate, not an automatic deletion: a test can justify an exception when it protects a high-severity invariant that has no stable, cheaper oracle.

1. **Actionable failure.** A failure names a product, compatibility, security, or operational regression that someone would fix. Cut alarms for facts that nobody intends to preserve. Example: `control-plane/web/components/dashboard-papercuts.test.ts` pins `right: 166px`; a deliberate spacing change fails without showing that copied feedback is unusable.
2. **Independent protection.** No cheaper retained test already fails for the same defect. Prefer one test at the lowest useful boundary. Example: the two `shared/update-notice.test.ts` cases “untagged at main tip: quiet” and “on a tag at the main tip: quiet” exercise the same quiet-at-tip decision with different setup labels.
3. **Observable contract.** Assert an outcome a customer, agent, operator, or supported peer component can observe. Do not pin statement order, private helper shape, source text, or a chosen mechanism unless that mechanism is itself the safety property. Example: `control-plane/signup-private-boundary.test.ts` searches TSX source and statement order instead of submitting the form and inspecting the request.
4. **Independent oracle.** The assertion must add information beyond the fixture. A mock call is useful when the call is the contract at that boundary; it is not useful when the mock returns a scripted value and the test checks only that same value. Example to retain: an adapter test can assert that a refusal prevents its provider seam from being called. Example to cut: a wrapper test that scripts one response and checks only that the wrapper copied it unchanged.
5. **Proportional cost.** Wall time, process churn, network use, global state, and maintenance cost must be proportional to the severity and uniqueness of the protected failure. Example: the 18.65 s OpenCode durability test buys a unique real-SIGKILL recovery guarantee; two 2.6–5.7 s real-lock waits do not justify elapsed sleeps when a lock-probe seam can establish the policy.
6. **Deterministic trigger and oracle.** Do not use elapsed wall time as the behavior under test when a controlled clock, event, or process state can express it. Polling with a deadline is acceptable as a bounded observation method for a real-process test; passing because an arbitrary delay elapsed is not. Example: `control-plane/invite-hold.test.ts` sleeps 25 ms to prove timer expiry even though the same file tests expiry through an injected clock.
7. **Plausible regression sensitivity.** State the credible code change that makes the test fail. A test that survives the likely bug, or fails only after a harmless refactor, is not useful. Example: checking that `STATE_ROOT` is absolute is implied by every resolver case and is unlikely to catch a defect those cases miss.
8. **Owned compatibility lifetime.** Keep migration and compatibility tests only while the product promises to read that old state or protocol. Record the removal condition. Example: legacy `envFile` migration tests remain useful while old persisted records are supported; a test for a fully removed UI control should leave with the control.
9. **Diagnostic scope.** Prefer a failure that points to one decision. A broad end-to-end test can stay for boundary integration, but it does not justify many overlapping unit cases, and a unit test does not replace one thin wiring test. Example: the real OpenCode permission-route case covers transport plus denial wiring; the separate generic reply case needs a distinct failure claim to justify another 18.44 s.
10. **Risk-weighted negative space.** Security, authorization, destructive-operation, corruption, and recovery boundaries deserve more cases than low-risk formatting or getters. Each case must still represent a distinct equivalence class. Example: path traversal and symlink escape cases can both stay; multiple spellings that reach the same normalized path should usually collapse into a table in one test.
11. **Fail-closed test instrument.** The test must fail when the anchor it searches for disappears. Example: candidate 25 compares two `indexOf` results without first proving that either string exists. Removing `account-line` returns `-1`, which still passes the ordering assertion. Candidate 23 uses the same technique but first asserts that its anchor exists.
12. **Stakes can require repair instead of deletion.** When a brittle test is the only guard on a secret boundary or production-damage path, replace its instrument before removing it. Example: candidate 21 pins source strings, but it is also the only test that says a customer's private SSH key never enters `FormData`; candidate 27 pins a low-stakes CSS pixel and can be cut.

Verdicts in this paper are **KEEP**, **CUT**, or **REPAIR**. REPAIR means that the protected property is worth keeping but the current test instrument is not. A later sweep must add the replacement before it deletes the old test.

## Questions for Nil

1. Is supported compatibility an explicit release window, or does a migration test stay until the reader is removed from production code?
2. Should source-inspection tests be forbidden except for build artifacts and security inventory checks, or allowed when browser-level verification is difficult?
3. Does “not timing-based” forbid only delay-as-oracle tests, or also real-process tests that poll with a deadline and assert the final process state?
4. For high-severity invariants, may a slow end-to-end test duplicate a unit test as a thin wiring proof?
5. Should REPAIR remain a first-class verdict? Applying it to six sample cases prevented a choice between keeping a known flaky or brittle instrument and deleting a real guard.

## Measurements

The CI log reports durations only on slower individual tests, not file start/end timestamps. “Logged wall time” below is therefore the sum of the durations printed for that file and is a lower bound on its actual file time. Per-file counts include the pass lines under each file header; Bun prints skips later in one trailer. The full `bun test` stage took 730.76 s and ran 6,074 tests across 370 files.

### Top 30 files by logged wall time

| Rank | File | Tests | Logged wall time (s) |
| ---: | --- | ---: | ---: |
| 1 | `server/backends/opencode/supervisor.test.ts` | 20 | 68.747 |
| 2 | `control-plane/governance-reapply.test.ts` | 25 | 42.964 |
| 3 | `server/backends/opencode/adapter.test.ts` | 19 | 42.374 |
| 4 | `control-plane/store-schema-check.test.ts` | 16 | 36.794 |
| 5 | `scripts/update-sh.test.ts` | 23 | 35.819 |
| 6 | `server/test-support/agent-manager.di.test.ts` | 25 | 25.778 |
| 7 | `deploy/harden-ssh.test.ts` | 44 | 20.248 |
| 8 | `server/backends/opencode/durability.test.ts` | 1 | 18.648 |
| 9 | `control-plane/governance-apply.test.ts` | 15 | 14.481 |
| 10 | `control-plane/deploy/provisioner-move-run.test.ts` | 94 | 13.840 |
| 11 | `server/test-support/app-ws-relay.test.ts` | 23 | 12.860 |
| 12 | `control-plane/store.test.ts` | 59 | 10.755 |
| 13 | `control-plane/handlers.test.ts` | 44 | 10.019 |
| 14 | `control-plane/requests.test.ts` | 16 | 9.861 |
| 15 | `control-plane/tick.test.ts` | 37 | 9.772 |
| 16 | `control-plane/progress.test.ts` | 46 | 9.163 |
| 17 | `control-plane/create-latch.test.ts` | 23 | 8.838 |
| 18 | `control-plane/wait-apt.test.ts` | 3 | 8.520 |
| 19 | `server/test-support/file-editor-watch.test.ts` | 18 | 8.148 |
| 20 | `server/backends/codex/safety-hook-install.test.ts` | 9 | 8.016 |
| 21 | `control-plane/lifecycle-tick.test.ts` | 28 | 8.006 |
| 22 | `control-plane/instance.test.ts` | 11 | 7.769 |
| 23 | `scripts/release-sh.test.ts` | 20 | 7.442 |
| 24 | `server/test-support/queue.test.ts` | 42 | 7.198 |
| 25 | `control-plane/signup.test.ts` | 45 | 7.177 |
| 26 | `server/test-support/app-proxy.test.ts` | 38 | 6.871 |
| 27 | `control-plane/adopt-run.test.ts` | 10 | 6.582 |
| 28 | `control-plane/deprovision.test.ts` | 12 | 6.554 |
| 29 | `control-plane/stripe/webhook.test.ts` | 27 | 6.080 |
| 30 | `server/test-support/log-search-isolation.test.ts` | 5 | 5.977 |

### Highest direct test-to-source line ratios

This conservative ratio includes a test only when its tested executable entry point is its same-path source peer. It excludes thin adapters whose tests mainly exercise a collaborator. In particular, `server/safety-hooks.test.ts` and `server/backends/codex/safety-hook.test.ts` primarily exercise the 2,133-line `server/safety-policy.ts`; charging their 1,664 combined test lines to 74- and 127-line adapters produced false ratios of 14.34 and 4.75. The safety policy is not over-tested by this line ratio. The table does not claim semantic coverage, and it excludes integration tests without one direct source subject.

| Rank | Test | Test lines | Source lines | Ratio |
| ---: | --- | ---: | ---: | ---: |
| 1 | `control-plane/stripe/checkout-poll.test.ts` | 563 | 138 | 4.08 |
| 2 | `server/managed-env-migration.test.ts` | 277 | 79 | 3.51 |
| 3 | `control-plane/lifecycle-tick.test.ts` | 957 | 290 | 3.30 |
| 4 | `server/process-name.test.ts` | 116 | 43 | 2.70 |
| 5 | `ui/voice-input-error.test.ts` | 33 | 13 | 2.54 |
| 6 | `control-plane/stripe/billing-tick.test.ts` | 414 | 165 | 2.51 |
| 7 | `shared/opencode-model.test.ts` | 45 | 18 | 2.50 |
| 8 | `ui/user-merge.test.ts` | 186 | 76 | 2.45 |
| 9 | `server/attachment-prompt.test.ts` | 316 | 136 | 2.32 |
| 10 | `control-plane/reboot.test.ts` | 231 | 105 | 2.20 |
| 11 | `server/backends/opencode/supervisor.test.ts` | 851 | 391 | 2.18 |
| 12 | `control-plane/certificate-contact-watch.test.ts` | 163 | 75 | 2.17 |
| 13 | `server/app-url-reconcile.test.ts` | 470 | 219 | 2.15 |
| 14 | `control-plane/stripe/webhook.test.ts` | 1,100 | 511 | 2.15 |
| 15 | `shared/update-notice.test.ts` | 169 | 79 | 2.14 |
| 16 | `server/app-visibility.test.ts` | 74 | 35 | 2.11 |
| 17 | `control-plane/resume.test.ts` | 496 | 238 | 2.08 |
| 18 | `server/backends/opencode/credential-scan.test.ts` | 80 | 40 | 2.00 |
| 19 | `ui/roomSelection.test.ts` | 84 | 43 | 1.95 |
| 20 | `server/app-tokens.test.ts` | 640 | 328 | 1.95 |

## Calibration sample

The original 40-case sample was intentionally broad. Worker and reviewer independently retained or repaired about three cases for every one they cut. This is evidence that the draft criteria over-select candidates and that agreed KEEP cases must remain as the control group. Cases 21–40 cost only 24 ms in the CI log; their decision is about maintenance and signal, not suite speed.

The added cases 41–55 cover two gaps found in blind review: the hand-written `FakeBackend` is tested directly even though production does not import it, and five of the seven most expensive files were absent from the first sample. Plugin and slide-mode cases remain excluded. No removed-feature residue was found: the tree has no `.skip` or `.todo` declarations, and every file reported by CI still exists. This does not prove that every behavior remains supported, but it gives no honest removed-feature candidate for this round.

“Lost if cut” states the property that would no longer have a direct guard. Logged time is the individual duration printed by Bun; `0` means Bun printed no duration, not that the test had zero cost.

| # | Stratum | Path and test | Logged s | Worker | Reviewer | Reason and what is lost if cut |
| ---: | --- | --- | ---: | --- | --- | --- |
| 1 | cost | `server/backends/opencode/durability.test.ts` — adopts the pinned server and resumes context after SIGKILL | 18.648 | KEEP | KEEP | Unique real process-loss, re-adoption, and recalled-context proof. |
| 2 | cost | `server/backends/opencode/adapter.test.ts` — denies controlled shell tools through the real OC1 permission route | 23.419 | KEEP | KEEP | Unique pinned-binary permission contract; a cut loses upstream denial coverage. |
| 3 | cost | `server/backends/opencode/adapter.test.ts` — one reply through real OC1 HTTP and SSE | 18.444 | CUT | KEEP | **Disagreement.** Worker: case 2 already crosses the transport. Reviewer: this case uniquely covers discovery credential redaction, free/offline classification, process reuse, normalized events, and fork isolation. A cut loses those five guards. |
| 4 | cost | `server/backends/opencode/supervisor.test.ts` — replaces changed environment contents and refreshes retained leases | 9.864 | KEEP | KEEP | Reads the live process environment; a fake cannot prove replacement content. |
| 5 | cost | same file — refuses cross-process adoption when the environment revision changed | 9.507 | KEEP | KEEP | A cut loses stale-environment adoption protection. |
| 6 | cost/duplicate | same file — waits for an active turn before an environment replacement | 8.126 | CUT | CUT | Both environment and permission setters raise the same `replacementRequested` flag; the drain cannot distinguish them. The surviving “waits for an active turn before a permission-config replacement” case is non-cuttable. This cut must wait for Worker 4's OpenCode supervisor lane. |
| 7 | cost/timing | `control-plane/wait-apt.test.ts` — held dpkg lock is busy and times out | 5.715 | REPAIR | REPAIR | Keep real `fcntl` detection; replace the 400 ms Python-start guess with a readiness signal. |
| 8 | cost/timing | same file — becomes ready once the lock is released | 2.650 | REPAIR | REPAIR | Distinct release behavior; replace the 300 ms setup guess. |
| 9 | cost | `server/test-support/log-search-isolation.test.ts` — SIGKILLs a non-yielding scan at deadline | 2.115 | KEEP | KEEP | Load-bearing proof that caller regex work is killable off the event loop. |
| 10 | cost | same file — holds caller slot until the child actually exits | 1.137 | KEEP | KEEP | Distinct admission rule: observed exit, not a sent kill, releases capacity. |
| 11 | cost | same file — caps concurrent searches per caller | 1.206 | KEEP | KEEP | A cut loses the per-caller 429 policy. |
| 12 | cost | same file — caps concurrent searches office-wide | 1.286 | KEEP | KEEP | A fresh caller proves the separate office-wide ceiling. |
| 13 | timing | `server/test-support/file-editor-watch.test.ts` — keeps firing after rename-replace | 2.018 | KEEP | KEEP | Condition polling observes a real regression; it is not a delay-as-oracle test. |
| 14 | timing | same file — ignores sibling files | 1.307 | CUT | CUT | Fixed 1.3 s negative wait. A cut loses the directory-wide false-event guard, which can be tested by touching sibling then target and inspecting the first event. |
| 15 | timing | same file — no delete for one-poll transient absence | 0.513 | REPAIR | REPAIR | Two misses are a real UI invariant, but a 300 ms sleep races a 250 ms poll. Inject the poll/clock. |
| 16 | timing | same file — no delete across repeated atomic rename-replace saves | 0.479 | KEEP | KEEP | Atomic replacement under repetition is distinct from a single transient miss. |
| 17 | timing | `control-plane/invite-hold.test.ts` — scheduled half drops an unclaimed hold | 0.031 | CUT | CUT | Delay-as-oracle duplicates deterministic stale-read safety. Only timer housekeeping loses direct coverage. |
| 18 | timing | `control-plane/timeout.test.ts` — kills a real child beyond its bound | 0.320 | KEEP | KEEP | Real reap behavior with a generous liveness guard; a fake cannot prove it. |
| 19 | timing | `control-plane/deploy/provisioner-move-run.test.ts` — descendant cannot perform delayed effect after return | 2.466 | KEEP | KEEP | External file witness uniquely proves whole-process-group kill. |
| 20 | timing | `server/test-support/app-ws-upstream.test.ts` — bounds the whole upgrade, including a connect that never completes | 0.125 | KEEP | KEEP | Fake connector plus 2 s liveness ceiling tests a 120 ms product deadline deterministically. |
| 21 | shape | `control-plane/signup-private-boundary.test.ts` — private key is unnamed and only public key enters `FormData` | 0 | REPAIR | REPAIR | Source strings are brittle, but this is the only guard that the customer's private SSH key never enters the request. Replace with a submitted-form boundary test. |
| 22 | shape | same file — server page gets no key prop and continuation renders no key field | 0 | KEEP | KEEP | Cheap fail-closed absence guard on the same secret boundary. |
| 23 | shape | same file — keyless initial request refuses before reservation | 0 | KEEP | KEEP | Guarded ordering assertion protects a security boundary. |
| 24 | shape | same file — continuation refuses a key and keeps the reserved name | 0 | REPAIR | REPAIR | Four source strings are brittle; exercise the route with `FormData`. |
| 25 | shape | `control-plane/web/components/dashboard-papercuts.test.ts` — account controls sit above title | 0 | CUT | CUT | Fail-open `indexOf` and source order do not prove layout. A cut loses no reliable layout guard. |
| 26 | shape | same file — signup links back to signed-in office page | 0 | CUT | CUT | Fail-open order plus verbatim markup. A cut loses link presence until a rendered assertion replaces it. |
| 27 | shape | same file — copied feedback keeps a gap from copy button | 0 | CUT | CUT | Pins `right: 166px` and a CSS occurrence count; no user-visible usability oracle. |
| 28 | shape | `server/process-name.test.ts` — main renames the process before server boot | 0 | REPAIR | REPAIR | Only wiring guard, but source order is dead-branch blind. Spawn the entry point and inspect `/proc`. |
| 29 | shape/duplicate | same file — rename is not an import side effect | 0 | CUT | CUT | The first real subprocess case already imports the module and asserts its name remains `bun`. |
| 30 | duplicate | `server/config.test.ts` — empty `ISOMUX_HOME` is unset | 0 | CUT | CUT | Dominated by case 31. The set, not each case alone, requires one trim-and-falsy guard. |
| 31 | duplicate | same file — whitespace-only `ISOMUX_HOME` is unset | 0 | KEEP | KEEP | Non-cuttable survivor that uniquely pins trim before the falsy check. |
| 32 | duplicate | same file — normalizes a trailing slash | 0 | CUT | CUT | Asserts `path.resolve` behavior already reached by the relative-path case. |
| 33 | duplicate | same file — trims surrounding whitespace | 0 | CUT | CUT | Dominated by case 31 for the implementation defect under consideration. |
| 34 | implied | same file — `STATE_ROOT` is absolute | 0 | CUT | CUT | Implied by equality to the resolver plus resolver cases. |
| 35 | implied | `ui/user-merge.test.ts` — owner's public view is still not full | 0 | KEEP | KEEP | Uniquely kills a role-based fullness guard that would read absent private fields. |
| 36 | duplicate | same file — `upsertUserView` does not mutate prior map | 0 | KEEP | KEEP | Separate exported function; same title does not mean duplicate behavior. |
| 37 | duplicate | same file — `rebuildUserViews` does not mutate prior map | 0 | KEEP | KEEP | Separate exported function and failure mode. |
| 38 | duplicate | `shared/update-notice.test.ts` — case 12, untagged at main tip is quiet | 0 | KEEP | KEEP | Distinct no-release input in the signed-off state enumeration. |
| 39 | duplicate | same file — case 15, tag at main tip is quiet | 0 | KEEP | KEEP | Distinct tagged input and quiet counterpart to its noisy sibling. |
| 40 | implied | `ui/voice-input-error.test.ts` — never shows raw browser code | 0 | KEEP | KEEP | Only assertion that the fallback omits the raw code. |
| 41 | mock/fake | `server/test-support/fake-backend.test.ts` — defaults capabilities and exposes config overrides | 0 | CUT | CUT | Constructor stores what the test passed; default fork capability is a fixture choice. Dependents lose an early fake diagnostic. |
| 42 | mock/fake | same file — `oneShotPrompt` returns configured value and counts | 0 | CUT | CUT | Directly asserts that the fake returns its configured value. Dependents retain behavior coverage. |
| 43 | mock/fake | same file — `detectAuthError` configurable, default never | 0 | CUT | CUT | Direct scripted-return assertion; a real/fake contract suite would better detect permissive drift. |
| 44 | mock/fake | same file — `approve()` records the decision | 0 | CUT | CUT | Tests only the fake's recorder. No server test asserts an empty fake recorder, so a broken recorder cannot make a checked negative pass vacuously. |
| 45 | mock/fake | same file — context usage null by default, override honored | 0 | CUT | CUT | Mock-asserts-mock; dependents already consume this seam. |
| 46 | cost | `control-plane/governance-reapply.test.ts` — forward lands current matrix from declared baseline | 3.040 | KEEP | KEEP | Real catalog transition is the purpose of the command, but the baseline is a test literal, not an observation of production. |
| 47 | cost | same file — reverse restores exactly the old matrix | 3.082 | KEEP | KEEP | Unique reverse transition guarantee against production-code `priorRuntimeRoles()`. |
| 48 | cost/duplicate | same file — round trip leaves catalog where it started | 3.278 | CUT | KEEP | **Disagreement.** Worker: forward and reverse endpoint cases cover the composition. Reviewer: this is the only case that compares the production-code prior posture to the suite's declared production baseline through the observed starting catalog. A cut may let reverse land somewhere other than production's actual start. |
| 49 | cost | same file — roles themselves are not touched | 3.170 | KEEP | KEEP | A cut loses the no-role-mutation boundary. |
| 50 | cost | `control-plane/store-schema-check.test.ts` — every product-roster table is asked about | 14.177 | KEEP | KEEP | Expensive but uniquely proves mechanical roster completeness as the schema evolves. |
| 51 | cost | `scripts/update-sh.test.ts` — no-op when already on target tag | 1.434 | KEEP | KEEP | A cut loses idempotent update behavior on customer boxes. |
| 52 | cost | `server/test-support/agent-manager.di.test.ts` — keeps provider credentials out of guidance and logs | 14.337 | KEEP | KEEP | High-cost secret-leak boundary with no safe weaker oracle identified. |
| 53 | cost | same file — drops real provider-error canary before normalized events and JSONL | 11.071 | KEEP | KEEP | Distinct redaction path from provider failure to durable logs. |
| 54 | cost | `deploy/harden-ssh.test.ts` — reports listening ports it could not identify | 5.487 | KEEP | KEEP | Prevents the hardening check from reporting clear when a listening port is unknown; criterion 11 applies to the shell check too. |
| 55 | cost | `control-plane/governance-apply.test.ts` — clean bootstrap reports both roles exact | 1.448 | KEEP | KEEP | A cut loses evidence/report correctness even if catalog mutation remains covered. |

### Current result

Across all 55 cases, both reviewers agree on 16 CUT, 6 REPAIR, and 31 KEEP verdicts. They disagree on cases 3 and 48. The 16 agreed cuts account for 9.47 s, or 1.3% of the 730.76 s test stage. Case 6 alone accounts for 8.13 s, 86% of that saving; the other fifteen recover 1.35 s. Cases 41–55 hold 60.52 s of logged time and contain 0.000 s of agreed cuts.

The five direct fake cases cost no measurable time and remove about 60 lines from roughly 140,000 test lines. The file must not be treated as one cut unit: its stream-lifecycle cases, such as “close() unblocks a parked stream()” and “ignores pushes after close()”, encode asynchronous behavior used by 28 dependent test files. Cases 52 and 53 account for 25.41 s of `agent-manager.di.test.ts`'s 25.78 s; nearly that file's whole cost protects secret redaction.

The original sample held 109.40 s of logged time, but cases 1–6 held 88.0 s of it. Before expansion, top-20 files absent from the sample held 255.4 s, or 37% of all attributed case time. `server/test-support` contains 113 of 370 files (31%) but supplied three original sample files; OpenCode contains 11 files (3%) and supplied three. Also, 193 of 370 files (52%) contribute under 0.1 s in total, so their main cost is maintaining and reading test code rather than CI wall time.
