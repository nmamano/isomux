// Read aloud through OpenAI (task 4481e64b): one playback at a time across
// the page. The reply goes to POST /api/voice/speak in pieces; piece n+1
// loads while piece n plays. Stop, a playback on another reply and unmount
// all end it: playback pauses, the loading piece is aborted, the rest is
// dropped.

import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceName } from "../../shared/voice.ts";
import { splitSpeechChunks } from "../voice-output.ts";
import { voiceFailureOf, type VoiceFailureKind } from "../voice-errors.ts";

// keyMissing and keyRejected link to the Variables tab; every error offers
// the browser voices.
export type OpenAISpeechError = {
  kind: Exclude<VoiceFailureKind, "tooLarge">;
};

export interface OpenAISpeech {
  speaking: boolean;
  error: OpenAISpeechError | null;
  // Call inside the click: iOS Safari plays only audio a tap started.
  speak(text: string, voice: VoiceName): void;
  stop(): void;
}

// A WAV file with no samples. Playing it inside the click is what lets the
// same element play the pieces later on iOS Safari.
const SILENCE =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

interface Playback {
  stop(): void;
}

let current: Playback | null = null;

export function useOpenAISpeech(): OpenAISpeech {
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<OpenAISpeechError | null>(null);
  const mineRef = useRef<Playback | null>(null);

  const stop = useCallback(() => {
    mineRef.current?.stop();
  }, []);

  const speak = useCallback((text: string, voice: VoiceName) => {
    current?.stop();
    const chunks = splitSpeechChunks(text);
    if (chunks.length === 0) return;

    const el = new Audio();
    el.src = SILENCE;
    void el.play().catch(() => {});
    const controller = new AbortController();
    const urls: (string | undefined)[] = [];
    const requested = new Set<number>();
    let playing: number | null = null;
    let next = 0;
    let ended = false;

    const finish = (failure: OpenAISpeechError | null) => {
      if (ended) return;
      ended = true;
      controller.abort();
      el.pause();
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("error", onError);
      for (const url of urls) if (url) URL.revokeObjectURL(url);
      if (current === playback) current = null;
      if (mineRef.current === playback) mineRef.current = null;
      setSpeaking(false);
      if (failure) setError(failure);
    };

    const load = (i: number) => {
      if (ended || i >= chunks.length || requested.has(i)) return;
      requested.add(i);
      void fetch("/api/voice/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: chunks[i], voice }),
        credentials: "same-origin",
        signal: controller.signal,
      })
        .then(async (res) => {
          if (ended) return;
          if (!res.ok) {
            const kind = await voiceFailureOf(res);
            finish({ kind: kind === "tooLarge" ? "rejected" : kind });
            return;
          }
          const blob = await res.blob();
          if (ended) return;
          urls[i] = URL.createObjectURL(blob);
          playNext();
        })
        .catch(() => {
          if (!ended) finish({ kind: "failed" });
        });
    };

    const playNext = () => {
      if (ended || playing !== null) return;
      const url = urls[next];
      if (!url) return;
      playing = next;
      el.src = url;
      // A piece the browser refuses to play must not leave Stop on screen
      // with no sound. AbortError only means a newer src or a pause won.
      el.play().catch((err: unknown) => {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          finish({ kind: "failed" });
        }
      });
      load(next + 1);
    };

    function onEnded() {
      if (ended || playing === null) return;
      const done = playing;
      const url = urls[done];
      if (url) URL.revokeObjectURL(url);
      urls[done] = undefined;
      playing = null;
      next = done + 1;
      if (next >= chunks.length) finish(null);
      else playNext();
    }
    // A piece the element cannot decode. The silent unlock's own failure is
    // not one: no piece is loaded yet.
    function onError() {
      if (!ended && playing !== null) finish({ kind: "failed" });
    }
    el.addEventListener("ended", onEnded);
    el.addEventListener("error", onError);

    const playback: Playback = { stop: () => finish(null) };
    current = playback;
    mineRef.current = playback;
    setError(null);
    setSpeaking(true);
    load(0);
  }, []);

  useEffect(() => () => mineRef.current?.stop(), []);

  return { speaking, error, speak, stop };
}
