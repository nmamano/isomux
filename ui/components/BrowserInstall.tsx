import { useState, type CSSProperties } from "react";
import { useI18n } from "../i18n.tsx";
import { safariHref, type SafariEnv } from "../safari-link.ts";
import { dialogSaveBtn, filledSecondaryBtn } from "./dialog-styles.ts";

// "Install as app" in an installed office's window: no page installs from
// there, so the member opens the app's page in a browser, where it installs.
// The browser must hold a session: Safari may not, so the link can also be
// copied into another one. Used by the app page and the Apps page.

// The office's dialog buttons (Nil, 2026-10-30): Copy link is the primary
// action, Open in Safari the secondary one. The link is drawn as a button.
const PRIMARY: CSSProperties = { ...dialogSaveBtn, fontFamily: "inherit" };
const SECONDARY: CSSProperties = {
  ...filledSecondaryBtn,
  fontFamily: "inherit",
  textDecoration: "none",
  display: "inline-block",
};

export function BrowserInstall({
  text,
  href,
  safari,
}: {
  text: string;
  // The app's page with the install hash: the browser opens its steps.
  href: string;
  safari: SafariEnv;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const inSafari = safariHref(href, safari);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p style={{ margin: 0 }}>{text}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button
          type="button"
          style={PRIMARY}
          onClick={() => {
            void navigator.clipboard
              ?.writeText(href)
              .then(() => setCopied(true))
              .catch(() => {});
          }}
        >
          {copied ? t("common.copied") : t("appWidget.copyLink")}
        </button>
        {inSafari !== href && (
          <a
            href={inSafari}
            target="_blank"
            rel="noopener noreferrer"
            style={SECONDARY}
          >
            {t("appWidget.openInSafari")}
          </a>
        )}
      </div>
    </div>
  );
}
