// The Re-enable button of a sign-in-links page (task 1492af52): a guest asked
// to re-enable an expired sign-in link, and one click gives the same link
// another 3 days (POST /api/invites/:prefix/extend). The server closes the
// page once the link is extended, so the card goes away on success.

import { useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";

export function AskRenewLinkBlock({
  tokenPrefix,
  isMobile,
}: {
  tokenPrefix: string;
  isMobile: boolean;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reEnable() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await apiFetch(
        "POST",
        `/api/invites/${encodeURIComponent(tokenPrefix)}/extend`,
      );
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : t("asks.renewLink.failed"),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        data-ask-renew-link=""
        disabled={pending}
        onClick={() => void reEnable()}
        style={{
          marginTop: 6,
          padding: isMobile ? "8px 14px" : "5px 14px",
          borderRadius: 8,
          border: "none",
          background: "var(--accent-text)",
          color: "var(--bg-base)",
          fontSize: 12,
          fontWeight: 600,
          cursor: pending ? "default" : "pointer",
          opacity: pending ? 0.6 : 1,
        }}
      >
        {t("asks.renewLink.button")}
      </button>
      {error && (
        <div
          role="alert"
          style={{
            marginTop: 6,
            color: "var(--red-text)",
            fontSize: isMobile ? 13 : 12,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
