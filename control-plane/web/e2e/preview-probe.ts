// The Preview probes, run as a child of the coordinator.
//
//   (cwd control-plane/web) bun e2e/preview-probe.ts   < one JSON line
//
// It lives beside the other transcripts rather than in `deploy/` because
// `next-auth/jwt` resolves only from inside this package.
//
// IT IS A CHILD FOR ONE REASON: minting an Auth.js session cookie needs
// `next-auth/jwt`, which resolves only from inside `control-plane/web`. The
// alternative was reimplementing a JWE by hand, which is not a thing to do to
// save a process.
//
// THE SECRET ARRIVES ON STDIN, never in argv - the process table is readable by
// every user on the box - and never through a file. It exists in this process
// for the length of the probe and dies with it.
//
// WHAT IT PRINTS: one `name: value` line per check, where value is a boolean,
// a small integer, or an HTTP status. The parent validates every line against a
// fixed shape before letting any of it into a report, so this program cannot
// widen what the parent may say.

import { encode } from "next-auth/jwt";

interface Input {
  baseUrl: string;
  secret: string;
  ownerAccountId: string;
  ownerEmail: string;
  strangerAccountId: string;
  strangerEmail: string;
  instanceId: string;
  officeName: string;
  hostname: string;
}

/** Auth.js derives its encryption key from the secret AND the cookie name, so
 * the name is part of the credential rather than a detail. HTTPS means the
 * `__Secure-` prefix. */
const COOKIE = "__Secure-authjs.session-token";

async function main(): Promise<void> {
  const raw = await new Response(Bun.stdin.stream()).text();
  const input = JSON.parse(raw) as Input;
  const base = input.baseUrl.replace(/\/$/, "");

  const cookieFor = async (accountId: string, email: string): Promise<string> =>
    encode({
      token: { accountId, email },
      secret: input.secret,
      salt: COOKIE,
    });
  const owner = await cookieFor(input.ownerAccountId, input.ownerEmail);
  const stranger = await cookieFor(
    input.strangerAccountId,
    input.strangerEmail,
  );

  const get = async (path: string, cookie?: string): Promise<Response> =>
    fetch(`${base}${path}`, {
      redirect: "manual",
      headers: cookie ? { cookie: `${COOKIE}=${cookie}` } : {},
    });

  // 1. The sign-in providers, from outside. A production build settles the
  //    dev-auth gate at compile time, so an empty object is the whole proof
  //    that no credentials provider exists - and Google is absent in preview
  //    because its redirect URI could not work there.
  const providers = await get("/api/auth/providers");
  const providersBody = await providers.text();
  // `-1` is the sentinel for a body that is not JSON at all, which is what a
  // protected deployment answers with. It is assigned on the failing path only:
  // an initialiser here would be a value nothing ever reads.
  let providerCount: number;
  try {
    providerCount = Object.keys(JSON.parse(providersBody)).length;
  } catch {
    providerCount = -1;
  }
  console.log(`providers_status: ${providers.status}`);
  console.log(`providers_count: ${providerCount}`);

  // 2. The sign-in page carries no developer form.
  const signin = await get("/signin");
  const signinBody = await signin.text();
  console.log(`signin_status: ${signin.status}`);
  console.log(
    `signin_has_dev_form: ${/name="email"|Developer sign-in/i.test(signinBody)}`,
  );

  // 3. A store-backed route, signed OUT, must not serve.
  const anonymous = await get(`/office/${input.officeName}`);
  console.log(`office_signed_out_status: ${anonymous.status}`);

  // 4. The owner's dashboard renders THIS office out of the database.
  const dashboard = await get(`/office/${input.officeName}`, owner);
  const dashboardBody = await dashboard.text();
  console.log(`office_owner_status: ${dashboard.status}`);
  console.log(
    `office_shows_hostname: ${dashboardBody.includes(input.hostname)}`,
  );

  // 5. A second signed-in account is refused the same office. That is what
  //    makes check 4 a claim about a durable account rather than about any
  //    signed-in caller.
  const other = await get(`/office/${input.officeName}`, stranger);
  console.log(`office_stranger_status: ${other.status}`);

  // 6. Internal instance ids are not customer-facing route keys, even for the
  // owner. Both identities get the same 404 as for an absent office name.
  const internalIdOwner = await get(`/office/${input.instanceId}`, owner);
  console.log(`office_internal_id_owner_status: ${internalIdOwner.status}`);
  const internalIdOther = await get(`/office/${input.instanceId}`, stranger);
  console.log(`office_internal_id_stranger_status: ${internalIdOther.status}`);

  // 7. The ops floor is not reachable without the operator flag.
  const ops = await get("/ops", owner);
  console.log(`ops_status: ${ops.status}`);
}

if (import.meta.main) {
  await main();
}
