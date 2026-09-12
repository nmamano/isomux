import { useEffect, useLayoutEffect, useState } from "react";
import { apiFetch } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { dialogCancelBtn, dialogSaveBtn } from "./dialog-styles.ts";
import { useClipboardCopy } from "./CopyButton.tsx";
import { claimExpandedEditor } from "./ExpandableTextarea.tsx";
import { Portal } from "./Portal.tsx";

export function SystemPromptButton({ agentId }: { agentId: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const { copied, copy } = useClipboardCopy();

  async function showPrompt() {
    setOpen(true);
    setPrompt(null);
    setError(false);
    try {
      const result = await apiFetch<{ prompt: string }>(
        "GET",
        `/api/agents/${agentId}/system-prompt`,
      );
      setPrompt(result.prompt);
    } catch {
      setError(true);
    }
  }

  return (
    <>
      <button type="button" onClick={() => void showPrompt()} style={dialogCancelBtn}>
        {t("dialogs.agent.showSystemPrompt")}
      </button>
      {open && <SystemPromptModal
        prompt={prompt}
        error={error}
        copied={copied}
        onCopy={() => prompt !== null && void copy(prompt)}
        onClose={() => setOpen(false)}
      />}
    </>
  );
}

function SystemPromptModal({
  prompt,
  error,
  copied,
  onCopy,
  onClose,
}: {
  prompt: string | null;
  error: boolean;
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  useLayoutEffect(claimExpandedEditor, []);
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onClose]);

  return (
    <Portal>
        <div
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1100,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            background: "rgba(0,0,0,0.62)",
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label={t("dialogs.agent.systemPromptTitle")}
            style={{
              width: "min(900px, 100%)",
              maxHeight: "min(760px, calc(100dvh - 40px))",
              display: "flex",
              flexDirection: "column",
              gap: 14,
              padding: 20,
              border: "1px solid var(--border-light)",
              borderRadius: 12,
              background: "var(--bg-overlay)",
              boxShadow: "0 20px 60px var(--shadow-heavy)",
            }}
          >
            <h3 style={{ margin: 0, fontSize: 17 }}>
              {t("dialogs.agent.systemPromptTitle")}
            </h3>
            <pre
              aria-readonly="true"
              style={{
                minHeight: 220,
                margin: 0,
                padding: 14,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                border: "1px solid var(--border)",
                borderRadius: 8,
                background: "var(--bg-code)",
                color: error ? "var(--red)" : "var(--text-primary)",
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              {error
                ? t("dialogs.agent.systemPromptLoadFailed")
                : (prompt ?? t("common.loading"))}
            </pre>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                disabled={prompt === null || error}
                onClick={onCopy}
                style={{ ...dialogSaveBtn, opacity: prompt === null || error ? 0.5 : 1 }}
              >
                {copied ? t("common.copiedNotice") : t("common.copy")}
              </button>
              <button type="button" onClick={onClose} style={dialogCancelBtn}>
                {t("common.close")}
              </button>
            </div>
          </section>
        </div>
    </Portal>
  );
}
