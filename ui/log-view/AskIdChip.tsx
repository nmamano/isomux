// The ask's id on its card (task 03f5c534): a member gives it to another
// agent, which reads the ask with GET /api/asks/:askId. A tap copies the bare
// id, as the task view's #<id> header does.

import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";
import { useClipboardCopy } from "../components/CopyButton.tsx";

export function AskIdChip({ id, isMobile }: { id: string; isMobile: boolean }) {
  const { t } = useI18n();
  const { copied, copy } = useClipboardCopy();
  return (
    <button
      type="button"
      data-ask-id={id}
      {...noTranslate()}
      onClick={() => void copy(id)}
      title={t(copied ? "asks.idCopied" : "asks.copyId")}
      style={{
        background: "none",
        border: "none",
        padding: 0,
        color: copied ? "var(--green-text)" : "var(--text-ghost)",
        fontFamily: "'JetBrains Mono',monospace",
        fontSize: isMobile ? 12 : 11,
        cursor: "pointer",
      }}
    >
      #{id}
    </button>
  );
}
