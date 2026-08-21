import Link from "next/link";
import { auth, signOut } from "../auth";
import { officesForAccount } from "../lib/services.server";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await auth();
  const accountId = session?.accountId;
  const email = session?.user?.email;
  if (!accountId) {
    return (
      <main>
        <h1>Hosted Isomux</h1>
        <p className="lead">
          <Link href="/signin">Sign in</Link> to set up an office.
        </p>
      </main>
    );
  }

  const offices = await officesForAccount(accountId);
  return (
    <main>
      <h1>{offices.length > 1 ? "Your offices" : "Your office"}</h1>
      <div className="account-line">
        <p className="note" data-testid="signed-in-as">
          Signed in as {email}
        </p>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/" });
          }}
        >
          <button type="submit" data-testid="sign-out">
            Sign out
          </button>
        </form>
      </div>
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
            <Link href="/signup">Set up another office</Link>.
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
