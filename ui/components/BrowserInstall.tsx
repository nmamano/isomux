import { useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "../i18n.tsx";
import { dialogSaveBtn } from "./dialog-styles.ts";
import { readInstallEnv } from "../app-install.ts";
import { useAppState } from "../store.tsx";

// "Install as app" where no page installs: an installed window, or another
// app's browser. The member copies the page's link into their browser, where
// it installs. No link opens a browser: none can open the member's default
// one (task 5765f58e). Used by the app page, the Apps page and the office.
// In another app's browser of an office with sign-in, the member's browser is
// not signed in, so the page's link would land on sign-in: the button gets a
// one-time sign-in link instead (Settings > New device, with no QR code;
// tasks 260686c9, 149f9eac).

// The office's primary dialog button (Nil, 2026-10-30).
const PRIMARY: CSSProperties = { ...dialogSaveBtn, fontFamily: "inherit" };

export function BrowserInstall({
  text,
  href,
  onSignInLink,
}: {
  text: ReactNode;
  // The page to install: an app's page with the install hash (the browser
  // opens its steps), or the office.
  href: string;
  // Set (useSignInLinkInstall): the button gets a sign-in link in place of
  // Copy link.
  onSignInLink?: () => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p style={{ margin: 0 }}>{text}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {onSignInLink ? (
          <button
            type="button"
            data-browser-install="sign-in"
            style={PRIMARY}
            onClick={onSignInLink}
          >
            {t("appWidget.getSignInLink")}
          </button>
        ) : (
          <button
            type="button"
            data-browser-install="copy"
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
        )}
      </div>
    </div>
  );
}

// Whether "Install as app" here gets a sign-in link: another app's browser of
// an office with sign-in. Without sign-in, the page's link opens as is.
export function useSignInLinkInstall(): boolean {
  const { sessionContext } = useAppState();
  return sessionContext !== null && readInstallEnv().iosBrowser === "in-app";
}
