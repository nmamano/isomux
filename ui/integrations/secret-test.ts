// Whether a secret has a Test: the server runs an identity check for an
// Authorization secret that lists the check's host (secretTestKind in
// server/connection-tests.ts). The page needs the answer for every scope,
// including another member's, where the caller's connections list says
// nothing; secret-test.test.ts holds this to the server's rule.

import type { SecretForm } from "../../shared/secret-hosts.ts";

const IDENTITY_CHECK_HOSTS = ["api.github.com", "api.stripe.com", "api.fly.io"];

export function hasSecretTest(secret: {
  form: SecretForm;
  hosts: string[];
}): boolean {
  return (
    secret.form.kind === "authorization" &&
    IDENTITY_CHECK_HOSTS.some((host) => secret.hosts.includes(host))
  );
}
