import Link from "next/link";
import { auth } from "../auth";
import { officeForAccount } from "../lib/services.server";

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

  // One office per account, so this is one link and not a list.
  const office = await officeForAccount(accountId);
  return (
    <main>
      <h1>Your office</h1>
      <p className="note" data-testid="signed-in-as">
        Signed in as {email}
      </p>
      {office ? (
        <div className="card">
          <p className="lead">
            <Link className="address" href={`/office/${office.instanceId}`}>
              {office.hostname}
            </Link>{" "}
            -{" "}
            {/* The same chip the provisioning ladder uses, so "ready" reads the
                same here as it does inside the office. */}
            <span data-state={office.ready ? "done" : "active"}>
              {office.ready ? "ready" : "being set up"}
            </span>
          </p>
        </div>
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
