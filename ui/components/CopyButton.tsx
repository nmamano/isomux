import { useState, useCallback } from "react";
import { useI18n } from "../i18n.tsx";

export const COPY_ICON = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5V3.5a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2" />
  </svg>
);

export const CHECK_ICON = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="3.5 8.5 6.5 11.5 12.5 4.5" />
  </svg>
);

// Copy-to-clipboard with the modern API plus a textarea/execCommand fallback
// for older / insecure contexts, and a transient "copied" flag. Shared by the
// icon-only CopyButton and any labeled copy control (e.g. the task-id header),
// so both get the same proven behavior. The write is ATTEMPTED before `copied`
// flips - an unavailable modern API throws into the fallback rather than
// reporting a false success.
export function useClipboardCopy(resetMs = 1500) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Fallback for older browsers / insecure contexts.
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), resetMs);
    },
    [resetMs],
  );
  return { copied, copy };
}

export function CopyButton({
  getText,
  size = 24,
}: {
  getText: () => string;
  size?: number;
}) {
  const { copied, copy } = useClipboardCopy();
  const { t } = useI18n();

  return (
    <button
      onClick={() => void copy(getText())}
      className="copy-btn"
      title={copied ? t("common.copiedNotice") : t("common.copy")}
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "1px solid var(--border-medium)",
        borderRadius: 6,
        background: copied ? "var(--green-bg)" : "var(--btn-surface)",
        color: copied ? "var(--green)" : "var(--text-dim)",
        cursor: "pointer",
        padding: 0,
        flexShrink: 0,
        transition: "color 0.15s, background 0.15s, border-color 0.15s",
      }}
    >
      {copied ? CHECK_ICON : COPY_ICON}
    </button>
  );
}
