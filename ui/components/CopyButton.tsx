import { useState, useCallback, useEffect, useRef } from "react";
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

export const CROSS_ICON = (
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
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
  </svg>
);

// The textarea/execCommand path for older or insecure contexts. True only
// when the browser reports that the copy happened.
function legacyCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  try {
    ta.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
  }
}

async function writeText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return legacyCopy(text);
  }
}

// Text that is still being fetched. Safari accepts a clipboard write only
// inside the click, so on a secure page the write starts now with the text as
// a promise (a promise-valued ClipboardItem). Elsewhere, and when that write
// fails, the text is awaited and written the ordinary way; an insecure page
// has no navigator.clipboard, and its execCommand fallback can still be
// refused once the click is over.
async function writePending(text: Promise<string>): Promise<boolean> {
  if (
    window.isSecureContext &&
    navigator.clipboard?.write &&
    typeof ClipboardItem !== "undefined"
  ) {
    const blob = text.then((s) => new Blob([s], { type: "text/plain" }));
    // Construction can throw; the rejection must not go unhandled then.
    blob.catch(() => {});
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "text/plain": blob }),
      ]);
      return true;
    } catch {
      // Fall through to the awaited write.
    }
  }
  let resolved: string;
  try {
    resolved = await text;
  } catch {
    return false;
  }
  return writeText(resolved);
}

// Copy-to-clipboard with the modern API plus a textarea/execCommand fallback
// for older / insecure contexts, and a transient outcome flag. Shared by the
// icon-only CopyButton and any labeled copy control (e.g. the task-id header),
// so both get the same proven behavior. `copied` flips only after a write the
// browser accepted, `failed` after a refused one or a fail() call; the newest
// outcome replaces the other at once, and one timer clears it. copy()
// resolves to whether the write happened, and never rejects.
export function useClipboardCopy(resetMs = 1500) {
  const [outcome, setOutcome] = useState<"copied" | "failed" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const show = useCallback(
    (next: "copied" | "failed") => {
      if (timer.current) clearTimeout(timer.current);
      setOutcome(next);
      timer.current = setTimeout(() => {
        timer.current = null;
        setOutcome(null);
      }, resetMs);
    },
    [resetMs],
  );
  // For a copy that fails before any write, e.g. when there is no text.
  const fail = useCallback(() => show("failed"), [show]);
  const copy = useCallback(
    async (text: string | Promise<string>): Promise<boolean> => {
      const ok =
        typeof text === "string"
          ? await writeText(text)
          : await writePending(text);
      show(ok ? "copied" : "failed");
      return ok;
    },
    [show],
  );
  return {
    copied: outcome === "copied",
    failed: outcome === "failed",
    copy,
    fail,
  };
}

export function CopyButton({
  getText,
  onCopyFailed,
  size = 24,
}: {
  // A promise is text still being fetched; see writePending.
  getText: () => string | Promise<string>;
  onCopyFailed?: () => void;
  size?: number;
}) {
  const { copied, failed, copy, fail } = useClipboardCopy();
  const { t } = useI18n();
  const onClick = async () => {
    let text: string | Promise<string>;
    try {
      text = getText();
    } catch {
      text = "";
    }
    // An empty text is nothing to copy: no write, and not shown as copied.
    // (Text still being fetched is written before it is known.)
    if (text === "") {
      fail();
      onCopyFailed?.();
      return;
    }
    if (!(await copy(text))) onCopyFailed?.();
  };

  return (
    <button
      onClick={() => void onClick()}
      className="copy-btn"
      // Not in the chat's HTML file (chat-export.ts).
      data-chat-export="omit"
      data-copy-outcome={copied ? "copied" : failed ? "failed" : undefined}
      title={
        copied
          ? t("common.copiedNotice")
          : failed
            ? t("common.copyFailed")
            : t("common.copy")
      }
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "1px solid var(--border-medium)",
        borderRadius: 6,
        background: copied
          ? "var(--green-bg)"
          : failed
            ? "var(--red-bg)"
            : "var(--btn-surface)",
        color: copied
          ? "var(--green-text)"
          : failed
            ? "var(--red-text)"
            : "var(--text-dim)",
        cursor: "pointer",
        padding: 0,
        flexShrink: 0,
        transition: "color 0.15s, background 0.15s, border-color 0.15s",
      }}
    >
      {copied ? CHECK_ICON : failed ? CROSS_ICON : COPY_ICON}
    </button>
  );
}
