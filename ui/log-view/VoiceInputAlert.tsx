// The OpenAI mic's error line (task 4481e64b): what went wrong, the Variables
// link when the key is the problem, and Retry and Discard while a clip is
// kept.

import { useI18n } from "../i18n.tsx";
import type { PlainMessageKey } from "../../shared/i18n/translate.ts";
import { VOICE_MAX_RECORDING_MS } from "../../shared/voice.ts";
import type { RecordedDictation } from "../hooks/useRecordedDictation.ts";
import { VoiceVariablesLink } from "../components/VoiceVariablesLink.tsx";

const MESSAGE: Record<
  Exclude<NonNullable<RecordedDictation["error"]>["kind"], "limitReached">,
  PlainMessageKey
> = {
  keyMissing: "voice.mic.keyMissing",
  keyRejected: "voice.keyRejected",
  tooLarge: "voice.mic.tooLarge",
  rejected: "voice.mic.rejected",
  failed: "voice.mic.failed",
  micDenied: "logView.voice.blocked",
};

const actionStyle = {
  background: "none",
  border: "none",
  padding: 0,
  color: "inherit",
  font: "inherit",
  textDecoration: "underline",
  cursor: "pointer",
} as const;

export function VoiceInputAlert({
  dictation,
  isMobile,
}: {
  dictation: RecordedDictation;
  isMobile: boolean;
}) {
  const i18n = useI18n();
  const { error, hasClip } = dictation;
  if (!error) return null;
  const kind = error.kind;
  const keyProblem = kind === "keyMissing" || kind === "keyRejected";
  const failedUpload = dictation.state === "failed";
  // Retry cannot fix a clip OpenAI refused or one over the limit.
  const canRetry =
    failedUpload && hasClip && kind !== "rejected" && kind !== "tooLarge";
  return (
    <div
      role="alert"
      style={{
        marginBottom: 8,
        color: "var(--red-text)",
        fontSize: isMobile ? 12 : 11,
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
      }}
    >
      <span>
        {kind === "limitReached"
          ? i18n.t("voice.mic.limitReached", {
              minutes: VOICE_MAX_RECORDING_MS / 60_000,
            })
          : i18n.t(MESSAGE[kind])}
        {failedUpload && hasClip ? ` ${i18n.t("voice.mic.kept")}` : ""}
      </span>
      {keyProblem && <VoiceVariablesLink />}
      {canRetry && (
        <button
          type="button"
          data-voice-action="retry"
          onClick={() => dictation.retry()}
          style={actionStyle}
        >
          {i18n.t("voice.retry")}
        </button>
      )}
      {failedUpload && hasClip && (
        <button
          type="button"
          data-voice-action="discard"
          onClick={() => dictation.discard()}
          style={actionStyle}
        >
          {i18n.t("common.discard")}
        </button>
      )}
    </div>
  );
}
