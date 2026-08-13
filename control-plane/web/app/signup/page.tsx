import { redirect } from "next/navigation";
import { auth } from "../../auth";
import { plans } from "../../lib/services.server";
import { OFFICE_DOMAIN } from "../../../signup";
import { OfficeAddressPreview } from "../../components/office-address-preview";

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
        <OfficeAddressPreview initialName={name} domain={OFFICE_DOMAIN} />
        <input type="hidden" name="plan" value={options[0]?.id ?? ""} />
        <p>
          <label>
            Promotional code (optional){" "}
            <input name="couponId" data-testid="coupon" autoComplete="off" />
          </label>
          <span className="note">
            {" "}
            If you received a promotional code, enter it here.
          </span>
        </p>
        <button
          className="btn-primary"
          type="submit"
          data-testid="signup-submit"
        >
          Continue to payment
        </button>
      </form>
    </main>
  );
}
