"use client";

import Link from "next/link";
import { signOut } from "next-auth/react";
import { useSessionProbe } from "../lib/use-session";
import type { OfficeCard } from "../lib/session-view";

/**
 * The landing page's body, on the client, so that `page.tsx` can be prerendered.
 *
 * WHAT PAINTS FIRST IS THE SIGNED-OUT PAGE, and that is deliberate rather than a
 * placeholder: it is the marketing shell a CDN can hold, and it has to carry the
 * real copy and the real link or there is nothing worth caching. A signed-in
 * visitor therefore reads it for the length of one same-origin fetch before the
 * dashboard replaces it. That flash is the price of the page being cacheable at
 * all; cookie-varying HTML cannot be held by a shared cache under any flag.
 *
 * `loading` and `unavailable` draw the same shell, because neither knows the
 * visitor is signed in. The hook keeps asking; see `lib/use-session.ts`.
 */
export function HomeView() {
  const probe = useSessionProbe({ offices: true });
  if (probe.state !== "signed-in") return <SignedOut />;
  return <Dashboard email={probe.email} offices={probe.offices ?? []} />;
}

function SignedOut() {
  return (
    <main>
      <h1>Hosted Isomux</h1>
      <p className="lead">
        <Link href="/signin">Sign in</Link> to set up an office.
      </p>
    </main>
  );
}

function Dashboard({
  email,
  offices,
}: {
  email: string | null;
  offices: OfficeCard[];
}) {
  return (
    <main>
      <div className="account-line">
        <p className="note" data-testid="signed-in-as">
          Signed in as {email}
        </p>
        {/* Still a form around the button, so the flex row and the click target
            are the ones the page has always had. What changed is who handles the
            submit: a server action cannot live in a client component, so this
            calls Auth.js from the browser. `redirectTo` is the option this
            version of next-auth declares; `callbackUrl` is deprecated. */}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void signOut({ redirectTo: "/" });
          }}
        >
          <button type="submit" data-testid="sign-out">
            Sign out
          </button>
        </form>
      </div>
      <h1>{offices.length > 1 ? "Your offices" : "Your office"}</h1>
      {offices.length > 0 ? (
        <>
          {offices.map((office) => (
            <Link
              className="card office-card-link"
              href={`/office/${office.officeName}`}
              key={office.instanceId}
            >
              <p className="lead">
                <span className="address">{office.hostname}</span> -{" "}
                {/* The same chip the provisioning ladder uses, so "ready" reads
                    the same here as it does inside the office. */}
                <span data-state={office.ready ? "done" : "active"}>
                  {office.ready ? "ready" : "not ready yet"}
                </span>
              </p>
              <span className="office-card-action">View office &rarr;</span>
            </Link>
          ))}
          <p>
            <Link href="/signup?another=1">Set up another office</Link>.
          </p>
        </>
      ) : (
        <div className="card">
          <p>
            You have no office yet. <Link href="/signup">Set one up</Link>.
          </p>
        </div>
      )}
    </main>
  );
}
