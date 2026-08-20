import { redirect } from "next/navigation";
import { auth } from "../../auth";
import { plans, signupPageState } from "../../lib/services.server";
import { OFFICE_DOMAIN } from "../../../signup";
import { SignupForm } from "../../components/signup-form";

export const dynamic = "force-dynamic";

export default async function Signup({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.accountId) redirect("/signin");

  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : null;
  const name = typeof params.name === "string" ? params.name : "";
  const [options, state] = await Promise.all([
    plans(),
    signupPageState(session.accountId),
  ]);
  if (state.kind === "office") redirect(`/office/${state.officeName}`);

  return (
    <main>
      <h1>Set up your office</h1>
      {error && (
        <p className="callout callout-danger" data-testid="signup-error">
          {error}
        </p>
      )}
      {state.kind === "continue" ? (
        <form className="form card" method="post" action="/api/signup">
          <input type="hidden" name="officeName" value={state.officeName} />
          <button
            className="btn-primary"
            type="submit"
            data-testid="signup-submit"
          >
            Continue signup
          </button>
        </form>
      ) : (
        <SignupForm initialName={name} domain={OFFICE_DOMAIN} plans={options} />
      )}
    </main>
  );
}
