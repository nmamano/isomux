import { useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "../i18n.tsx";
import { dialogSaveBtn } from "./dialog-styles.ts";

// "Install as app" where no page installs: an installed window, or another
// app's browser. The member copies the page's link into their browser, where
// it installs. No link opens a browser: none can open the member's default
// one (task 5765f58e). Used by the app page, the Apps page and the office.

// The office's primary dialog button (Nil, 2026-10-30).
const PRIMARY: CSSProperties = { ...dialogSaveBtn, fontFamily: "inherit" };

export function BrowserInstall({
  text,
  href,
}: {
  text: ReactNode;
  // The page to install: an app's page with the install hash (the browser
  // opens its steps), or the office.
  href: string;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
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
      </div>
    </div>
  );
}
