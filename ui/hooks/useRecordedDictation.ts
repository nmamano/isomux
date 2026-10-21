// The OpenAI mic path (task 4481e64b): record while the mic is on, upload the
// clip on stop, hand the text to the composer. A failed upload keeps the clip
// until the member retries or discards it, or leaves the page. The recorder
// stops itself at VOICE_MAX_RECORDING_MS and says so at once.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { VOICE_MAX_RECORDING_MS } from "../../shared/voice.ts";
import { audioExtensionFor, pickRecorderMimeType } from "../voice-input.ts";
import { voiceFailureOf, type VoiceFailureKind } from "../voice-errors.ts";

export type RecordedDictationState =
  | "idle"
  | "recording"
  | "transcribing"
  | "failed";

// What went wrong, for the error line. keyMissing and keyRejected link to the
// Variables tab; rejected means Retry cannot help.
export type RecordedDictationError =
  | { kind: VoiceFailureKind }
  | { kind: "micDenied" }
  | { kind: "limitReached" };

export interface RecordedDictation {
  state: RecordedDictationState;
  error: RecordedDictationError | null;
  // Whether a clip is kept for Retry.
  hasClip: boolean;
  start(): void;
  stop(): void;
  retry(): void;
  discard(): void;
}

interface Clip {
  blob: Blob;
  name: string;
}

export function useRecordedDictation(opts: {
  locale: string;
  keywords: readonly string[];
  onTranscript(text: string): void;
}): RecordedDictation {
  const [state, setState] = useState<RecordedDictationState>("idle");
  const [error, setError] = useState<RecordedDictationError | null>(null);
  const [hasClip, setHasClip] = useState(false);
  const optsRef = useRef(opts);
  useLayoutEffect(() => {
    optsRef.current = opts;
  });
  const stateRef = useRef<RecordedDictationState>("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const clipRef = useRef<Clip | null>(null);
  const limitRef = useRef<number | null>(null);
  // Set while getUserMedia is pending; a stop() meanwhile (a short Ctrl+Space)
  // ends the recording as soon as it starts.
  const startingRef = useRef(false);
  const stopSoonRef = useRef(false);
  const mountedRef = useRef(true);

  const move = useCallback((next: RecordedDictationState) => {
    stateRef.current = next;
    if (mountedRef.current) setState(next);
  }, []);

  const releaseMic = useCallback(() => {
    if (limitRef.current !== null) {
      window.clearTimeout(limitRef.current);
      limitRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const upload = useCallback(async () => {
    const clip = clipRef.current;
    if (!clip) return;
    move("transcribing");
    const form = new FormData();
    form.append(
      "audio",
      new File([clip.blob], clip.name, { type: clip.blob.type }),
    );
    form.append("language", optsRef.current.locale);
    for (const keyword of optsRef.current.keywords) {
      form.append("keywords", keyword);
    }
    let failure: VoiceFailureKind | null = null;
    let text = "";
    try {
      const res = await fetch("/api/voice/transcribe", {
        method: "POST",
        body: form,
        credentials: "same-origin",
      });
      if (res.ok) text = ((await res.json()) as { text: string }).text;
      else failure = await voiceFailureOf(res);
    } catch {
      failure = "failed";
    }
    if (!mountedRef.current) return;
    if (failure) {
      setError({ kind: failure });
      move("failed");
      return;
    }
    clipRef.current = null;
    setHasClip(false);
    // The limit notice stays until the next recording; any other error goes.
    setError((prev) => (prev?.kind === "limitReached" ? prev : null));
    move("idle");
    optsRef.current.onTranscript(text);
  }, [move]);

  const start = useCallback(() => {
    if (
      startingRef.current ||
      stateRef.current === "recording" ||
      stateRef.current === "transcribing"
    )
      return;
    // A clip kept from a failed upload waits for Retry or Discard: a new
    // recording would drop it with no undo.
    if (clipRef.current) return;
    setError(null);
    const mimeType = pickRecorderMimeType((type) =>
      MediaRecorder.isTypeSupported(type),
    );
    if (!mimeType) {
      setError({ kind: "failed" });
      return;
    }
    startingRef.current = true;
    stopSoonRef.current = false;
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        startingRef.current = false;
        if (!mountedRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const recorder = new MediaRecorder(stream, { mimeType });
        const parts: Blob[] = [];
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data && event.data.size > 0) parts.push(event.data);
        });
        let stopped = false;
        recorder.addEventListener("stop", () => {
          if (stopped || recorderRef.current !== recorder) return;
          stopped = true;
          recorderRef.current = null;
          releaseMic();
          const type = recorder.mimeType || mimeType;
          clipRef.current = {
            blob: new Blob(parts, { type }),
            name: `dictation.${audioExtensionFor(type)}`,
          };
          setHasClip(true);
          void upload();
        });
        recorderRef.current = recorder;
        recorder.start();
        move("recording");
        limitRef.current = window.setTimeout(() => {
          limitRef.current = null;
          setError({ kind: "limitReached" });
          recorderRef.current?.stop();
        }, VOICE_MAX_RECORDING_MS);
        if (stopSoonRef.current) recorder.stop();
      })
      .catch(() => {
        startingRef.current = false;
        if (mountedRef.current) setError({ kind: "micDenied" });
      });
  }, [move, releaseMic, upload]);

  const stop = useCallback(() => {
    if (startingRef.current) {
      stopSoonRef.current = true;
      return;
    }
    recorderRef.current?.stop();
  }, []);

  const retry = useCallback(() => {
    if (stateRef.current === "failed") void upload();
  }, [upload]);

  const discard = useCallback(() => {
    if (stateRef.current === "transcribing") return;
    clipRef.current = null;
    setHasClip(false);
    setError(null);
    move("idle");
  }, [move]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Clearing the ref first makes the stop listener drop the clip: the
      // page is gone.
      const recorder = recorderRef.current;
      recorderRef.current = null;
      recorder?.stop();
      releaseMic();
    };
  }, [releaseMic]);

  return { state, error, hasClip, start, stop, retry, discard };
}
