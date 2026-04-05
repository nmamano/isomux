import { useState, useCallback } from "react";

const SPEAK_ICON = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="2,5.5 5,5.5 8,2.5 8,13.5 5,10.5 2,10.5" fill="currentColor" stroke="none" />
    <path d="M10.5 5.5a3.5 3.5 0 0 1 0 5" />
    <path d="M12.5 3.5a6.5 6.5 0 0 1 0 9" />
  </svg>
);

const STOP_ICON = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none" />
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

function pickVoice(): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices();
  const en = voices.filter(v => v.lang.startsWith("en"));
  return en.find(v => v.name === "Google US English")
    ?? en.find(v => /google/i.test(v.name))
    ?? en.find(v => v.default)
    ?? en[0];
}

export function SpeakButton({ getText, size = 24 }: { getText: () => string; size?: number }) {
  const [speaking, setSpeaking] = useState(false);

  const handleClick = useCallback(() => {
    if (speaking) {
      speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }

    const text = stripMarkdown(getText());
    if (!text) return;

    const utterance = new SpeechSynthesisUtterance(text);
    const voice = pickVoice();
    if (voice) utterance.voice = voice;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);

    setSpeaking(true);
    speechSynthesis.speak(utterance);
  }, [getText, speaking]);

  if (typeof speechSynthesis === "undefined") return null;

  return (
    <button
      onClick={(e) => { handleClick(); (e.target as HTMLElement).blur(); }}
      className="copy-btn"
      title={speaking ? "Stop" : "Speak"}
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "1px solid var(--border-medium)",
        borderRadius: 6,
        background: speaking ? "var(--accent-bg, var(--green-bg))" : "var(--btn-surface)",
        color: speaking ? "var(--accent)" : "var(--text-dim)",
        cursor: "pointer",
        padding: 0,
        flexShrink: 0,
        transition: "color 0.15s, background 0.15s, border-color 0.15s",
      }}
    >
      {speaking ? STOP_ICON : SPEAK_ICON}
    </button>
  );
}
