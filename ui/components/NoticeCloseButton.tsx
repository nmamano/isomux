// The × that closes a notice chip (OfficeInstallNotice, UiBuildNotice). The
// glyph carries the contrast: a dim × on a faint fill was not seen in the
// Dark theme.

import type { ButtonHTMLAttributes } from "react";
import { useI18n } from "../i18n.tsx";

export function NoticeCloseButton(
  props: ButtonHTMLAttributes<HTMLButtonElement>,
): React.ReactElement {
  const { t } = useI18n();
  return (
    <button
      aria-label={t("common.dismiss")}
      title={t("common.dismiss")}
      {...props}
      style={{
        width: 24,
        height: 24,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        borderRadius: "50%",
        border: "none",
        background: "color-mix(in srgb, var(--text-primary) 14%, transparent)",
        color: "var(--text-primary)",
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
        <path
          d="M2 2l8 8M10 2l-8 8"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
