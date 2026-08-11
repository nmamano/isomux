// The Production probes, run as a child of the coordinator.
//
//   (cwd control-plane/web) bun e2e/production-probe.ts   < one JSON line
//
// Same reason for being a child as `preview-probe.ts`: minting an Auth.js
// session cookie needs `next-auth/jwt`, which resolves only from inside this
// package. The alternative was hand-rolling a JWE, which is not a thing to do
// to save a process.
//
// THE SECRET ARRIVES ON STDIN, never in argv - the process table is readable by
// every user on the box - and never through a file. It exists for the length of
// the probe and dies with it.
//
// TWO MODES, AND THE SECRET IS THE SWITCH. Given a secret, this runs the full
// set; given an empty one it stops after the anonymous checks, because without
// a readable AUTH_SECRET there is no cookie to mint. The authenticated branch
// is therefore FIRST-DEPLOY ONLY: a redeploy cannot read the write-only secret
// it wrote, so it proves less and says which parts it did not prove.
//
// WHAT THE AUTHENTICATED BRANCH PROVES, AND WHAT IT DOES NOT. Its minted cookie
// names an account that DOES NOT EXIST, so no fixture is seeded and no row is
// written - Auth.js is JWT-backed with no database adapter. It proves that
// Auth.js accepted the cookie, that the deployment OPENED production Neon, and
// that the store answered "no such account". It does NOT prove that a
// populated, Google-bound account renders.
//
// PRODUCTION'S DATA, measured 2026-08-11: one deliberate Google-bound account
// from Nil's own sign-in, and nothing else. Neither mode may change that count;
// the coordinator asserts it before and after.
//
// WHAT IT PRINTS: one `name: value` line per check, value a boolean or a small
// integer. The reveal result is reported as BOOLEANS rather than as its status
// string, so the parent's fixed line shape stays closed and this program cannot
// widen what the parent may say.

import { encode } from "next-auth/jwt";

interface Input {
  baseUrl: string;
  secret: string;
  /** An account id that does not exist, and must not come to exist. */
  accountId: string;
  email: string;
  /** A fabricated instance id: no such office. */
  instanceId: string;
  /** A fabricated operation id: no such request. */
  operationId: string;
  /** EVERY secret the coordinator holds, so the reflection scan covers all of
   * them rather than only the one this probe needed. Order is fixed:
   * AUTH_SECRET, the DSN, the mint bearer, the OAuth client secret. The OAuth
   * client ID is deliberately NOT here - it is public and the sign-in page is
   * supposed to contain it. */
  secrets: string[];
}

/**
 * Names that must never appear in anything the deployment sends back.
 *
 * A REDEPLOY cannot scan for secret VALUES - it has none to compare against,
 * because `AUTH_SECRET` is write-only and the process that made it is gone. So
 * it checks what it honestly can: that no forbidden credential NAME and no
 * bypass marker appears in a body or a header. That is a weaker claim than the
 * equality scan the first deploy ran, and it is reported under a different name
 * so the two are never mistaken for each other.
 */
const CREDENTIAL_NAMES = [
  "CONTROL_PLANE_DB",
  "AUTH_SECRET",
  "AUTH_GOOGLE_SECRET",
  "CONTROL_PLANE_MINT_TOKEN",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
];

/** Auth.js derives its encryption key from the secret AND the cookie name, so
 * the name is part of the credential rather than a detail. HTTPS means the
 * `__Secure-` prefix. */
const COOKIE = "__Secure-authjs.session-token";

/** Hosts a redirect may never land on: Vercel's own SSO would mean we probed
 * the platform's login page and called it our application. */
function isVercelHost(location: string): boolean {
  try {
    const host = new URL(location, "https://cloud.isomux.com").hostname;
    // BOTH families. `*.vercel.com` is not the same set as `vercel.com`, and a
    // login host lives in it.
    return (
      host === "vercel.com" ||
      host.endsWith(".vercel.com") ||
      host === "vercel.app" ||
      host.endsWith(".vercel.app")
    );
  } catch {
    return false;
  }
}

/** Our own sign-in page, EXACTLY. Any other path on the same hostname is a
 * different answer and must not read as a pass. */
function isOurSignin(location: string, origin: string): boolean {
  try {
    const url = new URL(location, origin);
    return url.origin === new URL(origin).origin && url.pathname === "/signin";
  } catch {
    return false;
  }
}

/** Headers matter as much as bodies: a value echoed into a `location`, a
 * `set-cookie` or a debug header has left the deployment just as surely. */
function headerText(res: Response): string {
  return [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
}

async function main(): Promise<void> {
  const raw = await new Response(Bun.stdin.stream()).text();
  const input = JSON.parse(raw) as Input;
  const base = input.baseUrl.replace(/\/$/, "");

  // No secret means no cookie, and therefore no authenticated checks at all.
  const authenticated = input.secret.length > 0;
  const cookie = authenticated
    ? await encode({
        token: { accountId: input.accountId, email: input.email },
        secret: input.secret,
        salt: COOKIE,
      })
    : "";

  const get = async (path: string, signedIn: boolean): Promise<Response> =>
    fetch(`${base}${path}`, {
      redirect: "manual",
      headers: signedIn ? { cookie: `${COOKIE}=${cookie}` } : {},
    });

  // Kept only to be JUDGED: only booleans leave this process.
  const seen: string[] = [];

  // 1. The sign-in providers, from outside. A production build settles the
  //    dev-auth gate at compile time, so the provider set is the whole proof.
  const providers = await get("/api/auth/providers", false);
  const providersBody = await providers.text();
  seen.push(providersBody, headerText(providers));
  // Declared without an initialiser: every path below assigns it, and an
  // empty list here would be a value nothing ever reads.
  let providerKeys: string[];
  try {
    providerKeys = Object.keys(JSON.parse(providersBody)).sort();
  } catch {
    providerKeys = [];
  }
  console.log(`providers_status: ${providers.status}`);
  console.log(`providers_count: ${providerKeys.length}`);
  console.log(`providers_only_google: ${providerKeys.join(",") === "google"}`);
  console.log(`providers_has_dev: ${providerKeys.includes("dev")}`);

  // 2. The sign-in page: Google present, no developer form.
  const signin = await get("/signin", false);
  const signinBody = await signin.text();
  seen.push(signinBody, headerText(signin));
  console.log(`signin_status: ${signin.status}`);
  console.log(
    `signin_has_dev_form: ${/name="email"|Developer sign-in/i.test(signinBody)}`,
  );
  console.log(`signin_has_google: ${/Continue with Google/i.test(signinBody)}`);

  // 3. A store-backed route, signed OUT, refused BY THE APPLICATION - not by
  //    Vercel's SSO, which would mean we never reached our own code.
  const anonymous = await get(`/office/${input.instanceId}`, false);
  seen.push(await anonymous.text(), headerText(anonymous));
  const anonLocation = anonymous.headers.get("location") ?? "";
  console.log(`office_signed_out_status: ${anonymous.status}`);
  console.log(
    `office_signed_out_redirects_to_signin: ${isOurSignin(anonLocation, base)}`,
  );
  console.log(`office_signed_out_to_vercel: ${isVercelHost(anonLocation)}`);

  if (!authenticated) {
    // The unauthenticated close: the two claims a redeploy can actually make.
    const joined = seen.join("\n");
    console.log(
      `no_bypass_reflected: ${!/VERCEL_AUTOMATION_BYPASS_SECRET/i.test(joined)}`,
    );
    console.log(
      `no_credential_names_reflected: ${!CREDENTIAL_NAMES.some((n) => joined.includes(n))}`,
    );
    return;
  }

  // 4. THE STORE-CONNECTIVITY PROOF. The home page opens production Neon,
  //    looks for a reservation this account does not have, and says so.
  const home = await get("/", true);
  const homeBody = await home.text();
  seen.push(homeBody, headerText(home));
  console.log(`home_status: ${home.status}`);
  console.log(`home_shows_identity: ${homeBody.includes(input.email)}`);
  console.log(
    `home_shows_no_office: ${/You have no office yet/i.test(homeBody)}`,
  );

  // 5. An office that does not exist, and an operator page this account is not
  //    entitled to. Both 404: "no such instance" and "not yours" are the same
  //    answer on purpose.
  const office = await get(`/office/${input.instanceId}`, true);
  seen.push(await office.text(), headerText(office));
  console.log(`office_fake_account_status: ${office.status}`);
  const ops = await get("/ops", true);
  seen.push(await ops.text(), headerText(ops));
  console.log(`ops_fake_account_status: ${ops.status}`);

  // 6. THE ROUND TRIP. This reaches the provisioner on fly through the
  //    DEPLOYMENT's own credentials: the route calls the seam with the bearer
  //    Vercel injected, and the provisioner refuses a fabricated triple with
  //    `forbidden`. It reads; it writes nothing, here or there.
  const reveal = await fetch(`${base}/api/invite/reveal`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie: `${COOKIE}=${cookie}`,
      origin: base,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      instanceId: input.instanceId,
      operationId: input.operationId,
    }),
  });
  const revealBody = await reveal.text();
  seen.push(revealBody, headerText(reveal));
  let revealStatus: string;
  // This one KEEPS its initialiser: the catch below does not reassign it, so
  // a body that is not JSON at all leaves it false, which is the right answer.
  let revealHasUrl = false;
  try {
    const parsed = JSON.parse(revealBody) as {
      status?: unknown;
      url?: unknown;
    };
    revealStatus = typeof parsed.status === "string" ? parsed.status : "";
    revealHasUrl = typeof parsed.url === "string" && parsed.url.length > 0;
  } catch {
    revealStatus = "";
  }
  console.log(`reveal_status: ${reveal.status}`);
  console.log(`reveal_is_forbidden: ${revealStatus === "forbidden"}`);
  // `failed` is what an unreachable provisioner or a refused bearer produces,
  // so it must be DISTINCT from `forbidden` or the round trip proved nothing.
  console.log(`reveal_is_failed: ${revealStatus === "failed"}`);
  console.log(`reveal_has_url: ${revealHasUrl}`);
  console.log(
    `reveal_no_store: ${/no-store/i.test(reveal.headers.get("cache-control") ?? "")}`,
  );

  // 7. Nothing we hold came back to us, in a body OR a header. An exact-value
  //    scan is a diagnostic rather than a guarantee - it cannot see a fragment
  //    or a re-encoding - but a hit is conclusive, and each class is reported
  //    separately because "a secret leaked" and WHICH secret leaked lead to
  //    different actions.
  const joined = seen.join("\n");
  const absent = (value: string): boolean =>
    value.length === 0 || !joined.includes(value);
  const [authSecret, dsn, mintToken, oauthSecret] = input.secrets;
  console.log(
    `no_auth_secret_reflected: ${absent(authSecret) && absent(cookie)}`,
  );
  console.log(`no_dsn_reflected: ${absent(dsn)}`);
  console.log(`no_mint_token_reflected: ${absent(mintToken)}`);
  console.log(`no_oauth_secret_reflected: ${absent(oauthSecret)}`);
  console.log(
    `no_bypass_reflected: ${!/VERCEL_AUTOMATION_BYPASS_SECRET/i.test(joined)}`,
  );
}

await main();
