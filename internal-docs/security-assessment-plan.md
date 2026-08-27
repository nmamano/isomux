# Isomux security assessment plan

## Status

Planning draft, 2026-08-21. Tracked by task `40fd7774`.

This assessment extends the authorization review in
[`docs/security-audit.md`](../docs/security-audit.md). That review was done on
2026-05-17 and focused on an external attacker without an invite. This plan also
covers authenticated users, agents, apps, rooms, hosted offices, and deployment
lifecycle boundaries.

## Objective

Find security defects before a public bug bounty starts. Test the two deployed
Isomux products as separate targets:

1. A self-hosted office that matches `office.nilmamano.com`.
2. The hosted Isomux product, with at least two separate test offices.

The assessment must show whether one identity, room, app, or office can reach a
resource that belongs to another security boundary.

## Safety rules

- Production targets get passive checks only.
- Active scans run only against disposable targets with synthetic data.
- Real customer offices and data are always out of scope.
- Tests must not use denial of service, resource floods, social engineering,
  credential stuffing, persistence, malware, or destructive payloads.
- A test stops after harmless evidence proves the impact.
- The operator must approve the exact targets before an active scan starts.
- Test logs must redact cookies, invite URLs, bearer tokens, and user data.

## Target matrix

| Target | Purpose | Required identities | Allowed testing |
| --- | --- | --- | --- |
| Personal production office | Check its real public edge | Anonymous only | Headers, TLS, redirects, public routes |
| Disposable self-hosted office | Match the personal Caddy and server setup | Owner, member, ordinary agent, privileged agent, app | Authenticated passive and active tests |
| Disposable hosted office A | Test one hosted tenant and its lifecycle | Owner, member, ordinary agent, privileged agent, app | Authenticated passive and active tests |
| Disposable hosted office B | Prove isolation from hosted office A | Owner, member, agent, app | Cross-office tests from both directions |

The hosted assessment also covers provisioning, DNS, TLS enrollment, wildcard
app hosts, suspension, cancellation, deletion, hostname reuse, port reuse,
token retirement, and loss of control-plane access.

## Workstreams

### 1. Public edge baseline

For each deployment path, record:

- HTTP-to-HTTPS behavior and supported TLS versions.
- Certificate name, issuer, and validity.
- Security headers on HTML, JSON, errors, redirects, and public assets.
- Cookie attributes after synthetic login.
- Public `/.well-known/security.txt` behavior.
- Host-header, origin, CORS, cache, and framing behavior.

The first scan of `office.nilmamano.com`, measured 2026-08-21, returned a
Mozilla Observatory grade of C with a score of 50. The anonymous JSON `401`
response did not include `Strict-Transport-Security`,
`X-Content-Type-Options`, or `Content-Security-Policy`. The
`/.well-known/security.txt` path also returned `401`.

### 2. Automated application scan

Run a local OWASP ZAP instance against each disposable target. Do not give a
production cookie to ZAP or to a hosted scanner.

Use separate ZAP contexts for anonymous, owner, member, and app-host traffic.
Start with crawling and passive analysis. Review the discovered routes before
active rules run. Disable destructive or high-volume rules. Save the ZAP
version, add-on versions, configuration, target build, start time, end time,
and raw report with each result.

### 3. Authorization and isolation review

Build an authorization matrix for every REST route and WebSocket message. Test
both the allowed and denied cases for:

- Users, owners, ordinary agents, privileged agents, cron runs, and apps.
- Rooms and files that are visible or hidden from the caller.
- Agent logs, prompts, terminal sessions, diffs, file reads, previews, apps,
  messages, tasks, cronjobs, and backups.
- Session creation, migration, revocation, expiry, and logout.
- Invite creation, acceptance, reuse, expiry, and concurrent acceptance.
- Office-host and app-host routing before URL parsing and authentication.
- WebSocket origin checks, upgrades, reconnects, and per-message authorization.

### 4. Hosted lifecycle review

Test the security properties that do not exist in one self-hosted office:

- A control-plane user cannot affect an office that they do not own.
- Office A cannot reach office B through DNS, HTTP, WebSocket, app, or provider
  lifecycle operations.
- The provisioner loses its promised access after handoff.
- Suspension and cancellation do not expose state or permit unauthorized reuse.
- Deletion retires DNS, certificates, sessions, tokens, app registrations, and
  control-plane records before a name becomes reusable.
- Logs and run records do not contain invite links, credentials, or customer
  content.

### 5. Source-assisted attack review

Trace each external input to its authorization decision and sensitive sink.
Prioritize IDOR/BOLA, SSRF, path traversal, command injection, stored and
reflected XSS, CSRF, cross-site WebSocket hijacking, origin confusion, host
confusion, race conditions, and confused-deputy chains.

The review must cover chains of low-severity behaviors when the combined result
can cause account takeover, cross-office access, code execution, or credential
exposure.

## Initial hardening candidates

These are hypotheses until implementation review and tests confirm the correct
scope:

1. Apply HSTS and `X-Content-Type-Options: nosniff` consistently to office-host
   responses, including JSON errors. Give non-HTML data responses a restrictive
   CSP where it is useful. Do not overwrite responses from agent-built app
   hosts.
2. Serve a public `/.well-known/security.txt` on the office host before the
   authentication wall. Define a reporting address, canonical policy, expiry,
   safe harbor, scope, prohibited tests, and response targets.
3. Add regression tests that enumerate the required headers and the public
   disclosure route across anonymous and authenticated responses.

## Finding standard

Each confirmed finding must include:

- Severity and affected security boundary.
- Preconditions and exact reproduction steps.
- Expected and observed behavior.
- Minimal redacted evidence.
- Impact and possible attack chain.
- Relevant source locations.
- Remediation and a regression-test proposal.
- Cleanup that the test target needs.

Keep hypotheses and hardening suggestions separate from confirmed
vulnerabilities.

## Exit criteria

- Both deployment paths have dated passive-scan reports.
- All three disposable targets have authenticated ZAP reports.
- The authorization matrix has an observed result for every sensitive action.
- Cross-office tests run in both directions.
- Every confirmed finding has a fix decision and regression test.
- A retest confirms each implemented fix.
- Isomux has a public disclosure route and a reviewed policy before a private
  bounty starts.

After these gates pass, start with an invitation-only bounty. Use only the
disposable targets and researcher-owned synthetic accounts. A public bounty is
a later decision.
