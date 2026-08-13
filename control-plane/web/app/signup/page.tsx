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
            SSH administrator key (strongly recommended){" "}
            <textarea
              name="customerSshKey"
              data-testid="customer-ssh-key"
              rows={4}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <span className="note">
            {" "}
            This gives you root administrator access to the VPS that runs your
            office, so you can install system software, manage the server, and
            recover access to your Isomux office if your browser no longer has
            access. Isomux agents and the built-in terminal cannot use sudo;
            this protects the VPS from accidental or unsafe agent commands. If
            you skip this step, you cannot add administrator access later from
            inside Isomux. You will not be able to install system software or
            manage the VPS after setup without contacting support. You can ask a
            chatbot to help you create an SSH key and find the public key to
            paste here.
          </span>
        </p>
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
