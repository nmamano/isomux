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
import type { SupportedLanguageCode } from "../lib/i18n/languages";
import { webTranslatorFor } from "../lib/i18n/rich";

type SignupResponse = {
  ok: boolean;
  checkoutUrl?: string;
  reason?: string;
};

/**
 * What is on screen when something failed, and WHY IT IS NOT A STRING.
 *
 * Two kinds of failure reach this box. One is ours, and it belongs to a catalog
 * key: state that outlives a render must hold the key rather than finished text,
 * or a language change would leave the sentence behind. The other arrived from
 * the server already worded for this request, and there is nothing left to look
 * up.
 */
type FormErrorKey =
  | "signup.cryptoError"
  | "signup.clipboardError"
  | "signup.checkoutError"
  | "signup.refusedError";

type FormError =
  | { kind: "key"; key: FormErrorKey }
  | { kind: "text"; text: string };

const asError = (key: FormErrorKey): FormError => ({ kind: "key", key });

export function SignupForm({
  language,
  domain,
  initialName,
  initialError = null,
  plans,
}: {
  language: SupportedLanguageCode;
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
  const [error, setError] = useState<FormError | null>(
    initialError ? { kind: "text", text: initialError } : null,
  );
  const [submitting, setSubmitting] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorRef = useRef<HTMLParagraphElement | null>(null);
  const { t, rich } = webTranslatorFor(language);

  useEffect(() => {
    void Promise.resolve().then(async () => {
      if (!window.isSecureContext || !globalThis.crypto?.subtle) {
        setError(asError("signup.cryptoError"));
        return;
      }
      try {
        setKey(await generateServerAdministratorKey());
      } catch {
        setError(asError("signup.cryptoError"));
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
      setError(asError("signup.clipboardError"));
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
        // A refusal the server worded for this request is used as delivered;
        // only our own two fallbacks are catalog keys.
        const relayed =
          result?.reason ??
          (response.status >= 400 && response.status < 500
            ? (responseType === "text/plain" && responseText.trim()) || null
            : null);
        setError(
          relayed
            ? { kind: "text", text: relayed }
            : asError(
                response.status >= 400 && response.status < 500
                  ? "signup.refusedError"
                  : "signup.checkoutError",
              ),
        );
        return;
      }
      window.location.assign(result.checkoutUrl);
    } catch {
      setError(asError("signup.checkoutError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="form card" onSubmit={(event) => void submit(event)}>
      <OfficeAddressPreview
        language={language}
        initialName={initialName}
        domain={domain}
      />
      <fieldset>
        <legend>{t("signup.choosePlan")}</legend>
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
            {customerPriceLine(language, plan.customerPrice) && (
              <span className="note">
                {customerPriceLine(language, plan.customerPrice)}
              </span>
            )}
          </label>
        ))}
        <span className="note">{t("signup.planChangeNote")}</span>
      </fieldset>
      <p>
        <label>
          {t("signup.couponLabel")}{" "}
          <input name="couponId" data-testid="coupon" autoComplete="off" />
        </label>
        <span className="note">{t("signup.couponHint")}</span>
      </p>
      <p>
        <label>{t("signup.keyLabel")}</label>
        <span className="note">{t("signup.keyNote")}</span>
        <span className="note">
          {rich("signup.keyHowTo", {
            label: (chunk) => <strong>{chunk}</strong>,
          })}
        </span>
        <span className="key-field">
          <textarea
            data-testid="server-administrator-private-key"
            rows={8}
            readOnly
            value={revealed ? (key?.privateKey ?? "") : ""}
            placeholder={t("signup.keyHidden")}
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
            {revealed ? t("signup.keyHide") : t("signup.keyReveal")}
          </button>
          <button
            className="key-copy"
            type="button"
            onClick={() => void copyPrivateKey()}
            disabled={!key}
          >
            {t("signup.keyCopy")}
          </button>
          <span className="copy-status" aria-live="polite">
            {copied ? t("signup.keyCopied") : ""}
          </span>
          <button
            className="key-download"
            type="button"
            onClick={downloadPrivateKey}
            disabled={!key}
          >
            {t("signup.keyDownload")}
          </button>
        </span>
        <label className="key-confirm">
          <input
            type="checkbox"
            checked={saved}
            onChange={(event) => setSaved(event.target.checked)}
            disabled={!key}
          />{" "}
          {t("signup.keySaved")}
        </label>
      </p>
      <PolicyNotice language={language} />
      {error && (
        <p
          ref={errorRef}
          className="callout callout-danger"
          data-testid="signup-error"
          role="alert"
        >
          {error.kind === "key" ? t(error.key) : error.text}
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
          {t("common.continueToPayment")}
        </button>
        {key && !saved && (
          <span id="signup-save-key-reason">{t("signup.saveKeyReason")}</span>
        )}
      </div>
    </form>
  );
}
