"use client";

import { useState } from "react";
import type { SupportedLanguageCode } from "../lib/i18n/languages";
import { translatorFor } from "../lib/i18n/translate";

/**
 * The /unsubscribe page body: one button that posts the token to
 * /api/unsubscribe. Opening the page changes nothing, because mail scanners
 * and link previews open every link in a mail.
 */
export function UnsubscribeView({
  token,
  language,
}: {
  token: string | null;
  language: SupportedLanguageCode;
}): React.ReactNode {
  const { t } = translatorFor(language);
  const [state, setState] = useState<"idle" | "sending" | "done" | "failed">(
    "idle",
  );

  async function unsubscribe(): Promise<void> {
    if (!token) return;
    setState("sending");
    try {
      const response = await fetch(
        `/api/unsubscribe?t=${encodeURIComponent(token)}`,
        { method: "POST" },
      );
      setState(response.ok ? "done" : "failed");
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="card">
      <h1>{t("unsubscribe.heading")}</h1>
      {!token ? (
        <p>{t("unsubscribe.noToken")}</p>
      ) : state === "done" ? (
        <p role="status">{t("unsubscribe.done")}</p>
      ) : (
        <>
          <p>{t("unsubscribe.lead")}</p>
          {state === "failed" && (
            <p className="callout callout-danger" role="alert">
              {t("unsubscribe.failed")}
            </p>
          )}
          <button
            type="button"
            className="btn-primary"
            disabled={state === "sending"}
            onClick={() => void unsubscribe()}
          >
            {t("unsubscribe.button")}
          </button>
        </>
      )}
    </div>
  );
}
