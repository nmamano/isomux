// The result of an action ask's Apply (task e3d1bc63, part 4): a sign-in link
// or an API token, in the shared copy box, and Close. The Inbox and the
// chat's ask stack draw one per entry of the store's askResults, where the
// ask was; the ask itself has closed. Close drops the entry; nothing else
// keeps it. A link for another member says to send it to them; only the
// member's own link says to open it on their device.

import { useDispatch, type AskResult } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { MintedSecretBox, MintedUrlBox } from "../components/access-shared.tsx";

export function AskResultCard({
  askId,
  result,
  isMobile,
}: {
  askId: string;
  result: AskResult;
  isMobile: boolean;
}) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const link = result.kind === "sign-in-link";
  return (
    <div
      data-ask-result={askId}
      {...(link && result.forSelf ? { "data-ask-result-for-self": "" } : {})}
      style={{
        marginBottom: 8,
        padding: isMobile ? "10px 12px" : "8px 12px",
        borderRadius: 10,
        border: "1px solid var(--border-subtle)",
        background: "var(--bg-elevated)",
        fontSize: isMobile ? 13 : 12,
        lineHeight: 1.5,
        color: "var(--text-primary)",
      }}
    >
      <div style={{ fontWeight: 600 }}>
        {link
          ? t("asks.result.signInLink", { member: result.target })
          : t("asks.result.apiToken", { name: result.target })}
      </div>
      {link ? (
        <MintedUrlBox url={result.value} forSelf={result.forSelf} />
      ) : (
        <MintedSecretBox
          value={result.value}
          label={t("settings.apiTokens.copyNow")}
          hint={t("settings.apiTokens.shownOnce")}
          blocked={t("settings.apiTokens.clipboardBlocked")}
        />
      )}
      <button
        type="button"
        data-ask-result-close=""
        onClick={() => dispatch({ type: "ask_result_closed", askId })}
        style={{
          marginTop: 8,
          padding: isMobile ? "7px 12px" : "4px 12px",
          borderRadius: 6,
          border: "1px solid var(--border-medium)",
          background: "var(--btn-surface)",
          color: "var(--text-primary)",
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        {t("common.close")}
      </button>
    </div>
  );
}
