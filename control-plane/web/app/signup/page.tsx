import { redirect } from "next/navigation";
import { auth } from "../../auth";
import { plans } from "../../lib/services.server";

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
  const options = await plans();

  return (
    <main>
      <h1>Set up your office</h1>
      {error && (
        <p className="callout callout-danger" data-testid="signup-error">
          {error}
        </p>
      )}
      <form className="form card" method="post" action="/api/signup">
        <p>
          <label>
            Office name{" "}
            <input
              name="officeName"
              data-testid="office-name"
              defaultValue={name}
              autoComplete="off"
            />
          </label>
        </p>
        <p>
          <label>
            Plan{" "}
            <select name="plan" data-testid="plan">
              {options.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.label}
                </option>
              ))}
            </select>
          </label>
        </p>
        <p>
          <label>
            Code (optional){" "}
            <input name="couponId" data-testid="coupon" autoComplete="off" />
          </label>
        </p>
        <button
          className="btn-primary"
          type="submit"
          data-testid="signup-submit"
        >
          Continue to payment
        </button>
      </form>
      <p className="note">
        Your office is reached at your name plus our domain, and the name cannot
        be changed after setup.
      </p>
    </main>
  );
}
