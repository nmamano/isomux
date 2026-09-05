import { useState, useCallback, useEffect } from "react";
import { useSpeechLocale } from "../hooks/useSpeechLocale.ts";
import { languageLabelFor } from "../../shared/languages.ts";
import { useI18n } from "../i18n.tsx";
import type {
  PlainMessageKey,
  Translator,
} from "../../shared/i18n/translate.ts";

// The name of the language the voice would speak, in the reader's own
// language. An unsupported locale has no catalog entry, so it keeps the raw
// tag languageLabelFor already falls back to.
const LANGUAGE_NAME_KEYS: Record<string, PlainMessageKey> = {
  en: "logView.voice.language.en",
  es: "logView.voice.language.es",
  ca: "logView.voice.language.ca",
};

function spokenLanguageName(i18n: Translator, locale: string): string {
  const key = LANGUAGE_NAME_KEYS[locale.split("-")[0]?.toLowerCase() ?? ""];
  return key ? i18n.t(key) : languageLabelFor(locale);
}

const SPEAK_ICON = (
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
    <polygon
      points="2,5.5 5,5.5 8,2.5 8,13.5 5,10.5 2,10.5"
      fill="currentColor"
      stroke="none"
    />
    <path d="M10.5 5.5a3.5 3.5 0 0 1 0 5" />
    <path d="M12.5 3.5a6.5 6.5 0 0 1 0 9" />
  </svg>
);

const STOP_ICON = (
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
    <rect
      x="3.5"
      y="3.5"
      width="9"
      height="9"
      rx="1.5"
      fill="currentColor"
      stroke="none"
    />
  </svg>
);

/** Strip markdown syntax to get plain text for speech */
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[.*?\]\(.*?\)/g, "")
    .replace(/\[([^\]]*)\]\(.*?\)/g, "$1")
    .replace(/(\*{1,3}|_{1,3})(.*?)\1/g, "$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .replace(/^[\s]*[-*+]\s+/gm, "")
    .replace(/^[\s]*\d+\.\s+/gm, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .trim();
}

/** "es-ES" -> "es". Voices are matched on the language, not the region: a
 *  Mexican Spanish voice reading Spanish is fine; an English one is not. */
function baseLanguage(locale: string): string {
  return locale.split("-")[0].toLowerCase();
}

// Best voice for a locale, or undefined when the device has none for that
// LANGUAGE. Exact-region matches are preferred, then any voice of the same
// language; within each, Google voices first (they're the good ones on Chrome)
// and then the browser's own default.
function pickVoice(
  voices: SpeechSynthesisVoice[],
  locale: string,
): SpeechSynthesisVoice | undefined {
  const base = baseLanguage(locale);
  const sameLanguage = voices.filter((v) => baseLanguage(v.lang) === base);
  if (sameLanguage.length === 0) return undefined;
  const exact = sameLanguage.filter(
    (v) => v.lang.replace("_", "-").toLowerCase() === locale.toLowerCase(),
  );
  const best = (pool: SpeechSynthesisVoice[]) =>
    pool.find((v) => /google/i.test(v.name)) ??
    pool.find((v) => v.default) ??
    pool[0];
  return best(exact) ?? best(sameLanguage);
}

// getVoices() is populated ASYNCHRONOUSLY on Chrome: the first call after page
// load usually returns []. Subscribing to voiceschanged is what lets the button
// know, before it is clicked, whether a voice for the user's language exists.
function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() =>
    typeof speechSynthesis === "undefined" ? [] : speechSynthesis.getVoices(),
  );
  useEffect(() => {
    if (typeof speechSynthesis === "undefined") return;
    const read = () => setVoices(speechSynthesis.getVoices());
    read();
    speechSynthesis.addEventListener("voiceschanged", read);
    return () => speechSynthesis.removeEventListener("voiceschanged", read);
  }, []);
  return voices;
}

export function SpeakButton({
  getText,
  size = 24,
}: {
  getText: () => string;
  size?: number;
}) {
  const [speaking, setSpeaking] = useState(false);
  const i18n = useI18n();
  const locale = useSpeechLocale();
  const voices = useVoices();
  const voice = pickVoice(voices, locale);
  // Only a real "we looked and there is nothing" counts as missing. An empty
  // list means the voices have not loaded yet (or this browser doesn't expose
  // them), in which case we still speak and let the browser choose from
  // utterance.lang - what we must never do is read Spanish text aloud in an
  // English voice, which is what the old unconditional en-only filter did.
  const noVoiceForLanguage = voices.length > 0 && !voice;
  const languageName = spokenLanguageName(i18n, locale);

  const handleClick = useCallback(() => {
    if (speaking) {
      speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    if (noVoiceForLanguage) return;

    const text = stripMarkdown(getText());
    if (!text) return;

    const utterance = new SpeechSynthesisUtterance(text);
    // Set the language even when we picked a voice: it is what the browser
    // falls back on if the voice is unavailable by the time it speaks.
    utterance.lang = locale;
    if (voice) utterance.voice = voice;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);

    setSpeaking(true);
    speechSynthesis.speak(utterance);
  }, [getText, speaking, locale, voice, noVoiceForLanguage]);

  if (typeof speechSynthesis === "undefined") return null;

  // Never take Stop away from someone mid-utterance: the voice list can change
  // (voiceschanged), or the language preference can, WHILE audio is playing,
  // and a disabled button would leave them with no way to shut it up.
  const disabled = !speaking && noVoiceForLanguage;
  const label = disabled
    ? i18n.t("logView.voice.noVoice", { language: languageName })
    : i18n.t(speaking ? "logView.voice.stop" : "logView.voice.speak");

  // The title lives on a wrapper, not the button: browsers do not reliably show
  // a tooltip for a DISABLED button, which is the one case where the
  // explanation actually matters.
  return (
    <span title={label} style={{ display: "inline-flex", flexShrink: 0 }}>
      <button
        onClick={(e) => {
          handleClick();
          (e.target as HTMLElement).blur();
        }}
        className="copy-btn"
        disabled={disabled}
        aria-label={label}
        style={{
          opacity: disabled ? 0.4 : 1,
          width: size,
          height: size,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "1px solid var(--border-medium)",
          borderRadius: 6,
          background: speaking
            ? "var(--accent-bg, var(--green-bg))"
            : "var(--btn-surface)",
          color: speaking ? "var(--accent)" : "var(--text-dim)",
          cursor: disabled ? "not-allowed" : "pointer",
          padding: 0,
          flexShrink: 0,
          transition: "color 0.15s, background 0.15s, border-color 0.15s",
        }}
      >
        {speaking ? STOP_ICON : SPEAK_ICON}
      </button>
    </span>
  );
}
