# Hosted launch domain checklist

The comment above `OFFICE_DOMAIN` is not true: launch is one reviewed change,
not a one-line flip. Customer office naming, DNS authorization, and persisted
test offices need separate checks.

## Before the reviewed change

- Resolve task `1e28f3f5`. As checked on 2026-08-20, it is open and
  `isomux.app` is not in the Public Suffix List. Record whether launch waits for
  acceptance or proceeds with a reviewed certificate-rate-limit bound.
- Before general signup, meet the wildcard-per-office certificate requirement
  recorded in `internal-docs/port-proxy-design.md` on 2026-08-13.
- Recheck Cloudflare. On 2026-08-20, `isomux.app` was active in Cloudflare,
  its public nameservers were `arturo.ns.cloudflare.com` and
  `kristina.ns.cloudflare.com`, and the staged `ISOMUX_CF_ZONE_ID` named that
  same apex zone. Nil owns
  `~/.config/isomux/control-plane-certificate.env` on auntie and stages its
  allowlisted values with
  `bun control-plane/deploy/certificate-secrets.ts`. Change the zone ID there
  and restage it only if this check no longer names `isomux.app`.
- Recheck DNS and certificate issuance. On 2026-08-20,
  `*.test.isomux.app` resolved to `116.203.73.126`, while
  `cp2.test.isomux.app` had its own `169.58.97.2` record and a Let's Encrypt
  certificate valid through 2026-11-10. No certificate was served for
  `test-nil.test.isomux.app` or a random wildcard name.
- Read the live control-plane instance records and record every name ending in
  `.test.isomux.app`. The read attempted on 2026-08-20 failed at the deployed
  database, so the live list is not proven. The maintained operator record says
  `cp2.test.isomux.app` and `test-nil.test.isomux.app` existed on 2026-08-13;
  `cp2` is control-plane infrastructure, while `test-nil` is the known customer
  office.

## The reviewed change

1. Change `OFFICE_DOMAIN` in `control-plane/signup.ts` from
   `test.isomux.app` to `isomux.app`, and replace its one-line-launch comment.
   This changes names created by `hostnameFor()` and the suffix shown on the
   signup page. The provisioner, installer, DNS writer, and certificate path
   consume the stored instance name and need no domain edit. Correct the stale
   customer-domain sentence in `internal-docs/port-proxy-design.md`.
2. Update the customer-name fixture
   `continue-browser.test.isomux.app` in
   `control-plane/web/e2e/signup-flow.e2e.ts`. Keep the other 29 unit-test files
   and two e2e fixtures on synthetic test-domain names: they test isolated
   records or the `cp1`, `cp2`, and `cp5` infrastructure hosts and must not
   target the production namespace.
3. Deploy the control-plane web and provisioner from the same reviewed commit.
   Run the signup, DNS, certificate, installer, and liveness gates against one
   disposable production-domain office before opening paid signup.

## Names that do not move

Changing `OFFICE_DOMAIN` does not rename a persisted instance or its DNS record,
certificate, invite links, or cookies. Decide the disposition of every proven
customer office under `test.isomux.app`; keep its old DNS and certificate until
it is retired or migrate it as a separate operation.

The hardcoded `cp1`, `cp2`, and `cp5` names are control-plane infrastructure,
not customer naming. They stay under `test.isomux.app` at launch. This includes
`control-plane/deploy/recycle-run.ts`, the defaults in
`control-plane/exercises/`, the liveness warning, the three e2e fixtures, and
the dated operational evidence in `control-plane/README.md` and
`internal-docs/control-plane-design.md`. Move them only through a separate
infrastructure change that replaces their DNS records, certificates, and
operator procedures together.
