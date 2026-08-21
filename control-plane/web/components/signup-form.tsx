"use client";

import { useEffect, useState } from "react";
import { OfficeAddressPreview } from "./office-address-preview";
import type { CustomerPrice } from "../../plans";
import { customerPriceLine } from "./plan-copy";
import { PolicyNotice } from "./policy-notice";
import {
  generateServerAdministratorKey,
  type ServerAdministratorKey,
} from "./server-administrator-key";

const CRYPTO_ERROR =
  "Your browser cannot create or copy the server administrator key on this page. Open the signup page over HTTPS in a current browser and try again.";
const CLIPBOARD_ERROR =
  "Your browser could not copy the server administrator key. Copy it from the field instead.";
const CHECKOUT_ERROR =
  "we could not open a payment page just now - your name is reserved, so try again in a moment";

export function SignupForm({
  domain,
  initialName,
  plans,
}: {
  domain: string;
  initialName: string;
  plans: Array<{
    id: string;
    label: string;
    specification: string;
    customerPrice: CustomerPrice | null;
  }>;
}) {
  const [key, setKey] = useState<ServerAdministratorKey | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void Promise.resolve().then(async () => {
      if (!window.isSecureContext || !globalThis.crypto?.subtle) {
        setError(CRYPTO_ERROR);
        return;
      }
      try {
        setKey(await generateServerAdministratorKey());
      } catch {
        setError(CRYPTO_ERROR);
      }
    });
  }, []);

  async function copyPrivateKey(): Promise<void> {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key.privateKey);
    } catch {
      setError(CLIPBOARD_ERROR);
    }
  }

  async function submit(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!key || !saved) return;
    setSubmitting(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    form.set("customerSshKey", key.publicKey);
    try {
      const response = await fetch("/api/signup", {
        method: "POST",
        body: form,
        headers: { Accept: "application/json" },
      });
      const result = (await response.json()) as {
        ok: boolean;
        checkoutUrl?: string;
        reason?: string;
      };
      if (!response.ok || !result.ok || !result.checkoutUrl) {
        setError(result.reason ?? CHECKOUT_ERROR);
        return;
      }
      window.location.assign(result.checkoutUrl);
    } catch {
      setError(CHECKOUT_ERROR);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="form card" onSubmit={(event) => void submit(event)}>
      {error && (
        <p className="callout callout-danger" data-testid="signup-error">
          {error}
        </p>
      )}
      <OfficeAddressPreview initialName={initialName} domain={domain} />
      <fieldset>
        <legend>Choose your office</legend>
        {plans.map((plan, index) => (
          <label key={plan.id} className="plan-option">
            <input
              type="radio"
              name="plan"
              value={plan.id}
              defaultChecked={index === 0}
            />
            <strong>{plan.label}</strong>
            <span className="note">{plan.specification}</span>
            {customerPriceLine(plan.customerPrice) && (
              <span className="note">
                {customerPriceLine(plan.customerPrice)}
              </span>
            )}
          </label>
        ))}
        <span className="note">
          Changing plans after signup is not available yet.
        </span>
      </fieldset>
      <p>
        <label>Save your server administrator key</label>
        <span className="note">
          This key is for accessing your entire server, not just the Isomux
          office. You need it to install software as an administrator and manage
          or repair your server.
        </span>
        <span className="note">
          It was generated locally in your browser and is shown only to you.
          Save it somewhere only you can access. We cannot create a new one
          after the fact because we lock ourselves out of your server after
          setup.
        </span>
        <span className="note">
          How to use it: This is an SSH private key. A chatbot can walk you
          through how to use it to access your server through a terminal, or an
          agent running locally on your computer can use it to access the server
          for you.
        </span>
        <textarea
          data-testid="server-administrator-private-key"
          rows={8}
          readOnly
          value={key?.privateKey ?? ""}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={() => void copyPrivateKey()}
          disabled={!key}
        >
          Copy private key
        </button>
        <label className="key-confirm">
          <input
            type="checkbox"
            checked={saved}
            onChange={(event) => setSaved(event.target.checked)}
            disabled={!key}
          />{" "}
          I saved it
        </label>
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
      <PolicyNotice />
      <button
        className="btn-primary"
        type="submit"
        data-testid="signup-submit"
        disabled={!key || !saved || submitting}
      >
        Continue to payment
      </button>
    </form>
  );
}
