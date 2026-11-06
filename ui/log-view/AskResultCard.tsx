// The result of an action ask's Apply (task e3d1bc63, part 4): a sign-in link
// or an API token, in the shared copy box, and Close. The Inbox and the
// chat's ask stack draw one per entry of the store's askResults, where the
// ask was; the ask itself has closed. Close drops the entry; nothing else
// keeps it. A link for another member says to send it to them, by name (Nil,
// 2026-11-05: a member, not an invitee); the member's own link does not. Part 5: what a storage
// prune or compress did, in the page's words: the member's only receipt.
// Task c3b91695: the output of the commands whose Run closed the ask.

import { useDispatch, type AskResult } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { MintedSecretBox, MintedUrlBox } from "../components/access-shared.tsx";
import { categoryLabel, sizeText } from "../components/StoragePane.tsx";
import { formatNumber } from "../../shared/i18n/number.ts";
import { AskRunResult } from "./AskRunResult.tsx";
import { noTranslate } from "../no-translate.ts";

export function AskResultCard({
  askId,
  result,
  isMobile,
}: {
  askId: string;
  result: AskResult;
  isMobile: boolean;
}) {
  const { t, tn, rich, language } = useI18n();
  const dispatch = useDispatch();
  const size = (bytes: number) => sizeText(language, t, bytes);
  const muted = { color: "var(--text-muted)", fontSize: isMobile ? 12 : 11 };

  function body() {
    switch (result.kind) {
      case "sign-in-link":
        return (
          <>
            <div style={{ fontWeight: 600 }}>{t("asks.result.signInLink")}</div>
            <MintedUrlBox
              url={result.value}
              forSelf={result.forSelf}
              sendTo={result.target}
            />
          </>
        );
      case "api-token":
        return (
          <>
            <div style={{ fontWeight: 600 }}>
              {t("asks.result.apiToken", { name: result.target })}
            </div>
            <MintedSecretBox
              value={result.value}
              label={t("settings.apiTokens.copyNow")}
              hint={t("settings.apiTokens.shownOnce")}
              blocked={t("settings.apiTokens.clipboardBlocked")}
            />
          </>
        );
      case "storage-prune": {
        const { applied } = result;
        return (
          <>
            <div style={{ fontWeight: 600 }}>
              {categoryLabel(t, result.target)}
            </div>
            <div>
              {applied.aborted
                ? t("settings.storage.aborted", { reason: applied.aborted })
                : t("settings.storage.deletedResult", {
                    count: formatNumber(language, applied.deleted),
                    size: size(applied.bytes),
                  })}
            </div>
            {applied.refused.length > 0 && (
              <div style={muted}>
                {t("settings.storage.refused", {
                  count: formatNumber(language, applied.refused.length),
                })}
              </div>
            )}
          </>
        );
      }
      case "answered-first":
        return (
          <div data-ask-closed-by={result.by}>
            {rich("asks.result.answeredFirst", {
              member: <span {...noTranslate()}>{result.by}</span>,
            })}
          </div>
        );
      case "command-run":
        return (
          <>
            <div style={{ fontWeight: 600 }}>{t("asks.result.commandRun")}</div>
            {result.runs.map((run) => (
              <div
                key={run.command}
                style={{
                  margin: "6px 0",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--bg-subtle)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    padding: "6px 12px",
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: 12,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                  }}
                >
                  {run.command}
                </div>
                <AskRunResult run={run} isMobile={isMobile} />
              </div>
            ))}
          </>
        );
      case "storage-compress": {
        const { applied } = result;
        return (
          <>
            <div style={{ fontWeight: 600 }}>
              {t("settings.storage.compressSection")}
            </div>
            <div>
              {applied.compressed === 0
                ? t("settings.storage.compressNothing")
                : tn("settings.storage.compressedResult", applied.compressed, {
                    before: size(applied.bytesBefore),
                    after: size(applied.bytesAfter),
                  })}
              {applied.refused.length > 0 &&
                " " +
                  tn(
                    "settings.storage.compressRefused",
                    applied.refused.length,
                  )}
            </div>
          </>
        );
      }
    }
  }

  return (
    <div
      data-ask-result={askId}
      {...(result.kind === "sign-in-link" && result.forSelf
        ? { "data-ask-result-for-self": "" }
        : {})}
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
      {body()}
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
