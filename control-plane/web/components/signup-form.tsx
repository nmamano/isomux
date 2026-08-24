"use client";

import { useEffect, useRef, useState } from "react";
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
  "Your browser could not copy the server administrator key. Reveal the key and select it from the field instead.";
const CHECKOUT_ERROR =
  "We could not open a payment page just now. Try again in a moment.";
const SIGNUP_REFUSED_ERROR =
  "We could not continue signup. Reload the page and try again.";
const SAVE_KEY_REASON = "Save your server administrator key before continuing.";

type SignupResponse = {
  ok: boolean;
  checkoutUrl?: string;
  reason?: string;
};

export function SignupForm({
  domain,
  initialName,
  initialError = null,
  plans,
}: {
  domain: string;
  initialName: string;
  initialError?: string | null;
  plans: Array<{
    id: string;
    label: string;
    specification: string;
    customerPrice: CustomerPrice | null;
  }>;
}) {
  const [key, setKey] = useState<ServerAdministratorKey | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [submitting, setSubmitting] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorRef = useRef<HTMLParagraphElement | null>(null);

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

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  async function copyPrivateKey(): Promise<void> {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key.privateKey);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => {
        setCopied(false);
        copiedTimer.current = null;
      }, 2_000);
    } catch {
      setCopied(false);
      setError(CLIPBOARD_ERROR);
    }
  }

  function downloadPrivateKey(): void {
    if (!key) return;
    const url = URL.createObjectURL(
      new Blob([key.privateKey], { type: "application/octet-stream" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "isomux-server-administrator-key";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
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
      if (response.redirected && new URL(response.url).pathname === "/signin") {
        window.location.assign(response.url);
        return;
      }
      const responseText = await response.text();
      const responseType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        .trim()
        .toLowerCase();
      let result: SignupResponse | null = null;
      try {
        result = JSON.parse(responseText) as SignupResponse;
      } catch {
        // A refusal can be plain text or empty, including at the trust boundary.
      }
      if (!response.ok || !result?.ok || !result.checkoutUrl) {
        const refusal =
          result?.reason ??
          (response.status >= 400 && response.status < 500
            ? (responseType === "text/plain" && responseText.trim()) ||
              SIGNUP_REFUSED_ERROR
            : CHECKOUT_ERROR);
        setError(refusal);
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
        <label>
          Promotional code (optional){" "}
          <input name="couponId" data-testid="coupon" autoComplete="off" />
        </label>
        <span className="note">
          If you received a promotional code, enter it here.
        </span>
      </p>
      <p>
        <label>Save your server administrator key</label>
        <span className="note">
          This key is for accessing your entire server, not just the Isomux
          office. You need it to install software as an administrator and manage
          or repair your server. It was generated locally in your browser and is
          shown only to you. Save it somewhere only you can access. We cannot
          create a new one after the fact because we lock ourselves out of your
          server after setup.
        </span>
        <span className="note">
          <strong>How to use it:</strong> This is an SSH private key. A chatbot
          can walk you through how to use it to access your server through a
          terminal, or an agent running locally on your computer can use it to
          access the server for you.
        </span>
        <span className="key-field">
          <textarea
            data-testid="server-administrator-private-key"
            rows={8}
            readOnly
            value={revealed ? (key?.privateKey ?? "") : ""}
            placeholder="Private key hidden"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            className="key-reveal"
            type="button"
            onClick={() => setRevealed((current) => !current)}
            disabled={!key}
            aria-pressed={revealed}
          >
            {revealed ? "Hide private key" : "Reveal private key"}
          </button>
          <button
            className="key-copy"
            type="button"
            onClick={() => void copyPrivateKey()}
            disabled={!key}
          >
            Copy private key
          </button>
          <span className="copy-status" aria-live="polite">
            {copied ? "Copied" : ""}
          </span>
          <button
            className="key-download"
            type="button"
            onClick={downloadPrivateKey}
            disabled={!key}
          >
            Download private key
          </button>
        </span>
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
      <PolicyNotice />
      {error && (
        <p
          ref={errorRef}
          className="callout callout-danger"
          data-testid="signup-error"
          role="alert"
        >
          {error}
        </p>
      )}
      <div className="action">
        <button
          className="btn-primary"
          type="submit"
          data-testid="signup-submit"
          disabled={!key || !saved || submitting}
          aria-describedby={
            key && !saved ? "signup-save-key-reason" : undefined
          }
        >
          Continue to payment
        </button>
        {key && !saved && (
          <span id="signup-save-key-reason">{SAVE_KEY_REASON}</span>
        )}
      </div>
    </form>
  );
}
