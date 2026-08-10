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
        <p>
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
      <p data-testid="signed-in-as">Signed in as {email}</p>
      {office ? (
        <p>
          <Link href={`/office/${office.instanceId}`}>{office.hostname}</Link> -{" "}
          {office.ready ? "ready" : "being set up"}
        </p>
      ) : (
        <p>
          You have no office yet. <Link href="/signup">Set one up</Link>.
        </p>
      )}
    </main>
  );
}
