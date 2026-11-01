// The OpenAI mic path (task 4481e64b): record while the mic is on, upload the
// clip on stop, hand the text to the composer. A failed upload keeps the clip
// until the member retries or discards it, or leaves the page. The recorder
// stops itself at VOICE_MAX_RECORDING_MS and says so at once.
//
// Each press also asks GET /api/voice whether the member has a key OpenAI can
// use, in parallel with the mic, so recording starts no later (task
// 69a9b325). Without one, the press ends at once with no clip, instead of
// after the member has talked. The answer is never cached: a key added in
// Variables counts at the next press. A failed check lets the recording run,
// and the upload reports as before.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  VOICE_KEY_NAME,
  VOICE_MAX_RECORDING_MS,
  voiceKeySourceUsable,
  type VoiceKeyName,
  type VoiceStatusRes,
} from "../../shared/voice.ts";
import { apiFetch } from "../api.ts";
import { audioExtensionFor, pickRecorderMimeType } from "../voice-input.ts";
import { voiceFailureOf, type VoiceFailureKind } from "../voice-errors.ts";

export type RecordedDictationState =
  | "idle"
  | "recording"
  | "transcribing"
  | "failed";

// What went wrong, for the error line. keyMissing, keySecret and keyRejected
// link to the Variables tab; rejected means Retry cannot help.
export type RecordedDictationError =
  | { kind: VoiceFailureKind }
  | { kind: "keySecret"; name: VoiceKeyName }
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
  // The press whose key check can still end it: set at the press, cleared
  // when its clip goes to upload. blockedRef is the press the check ended.
  const attemptRef = useRef(0);
  const liveAttemptRef = useRef<number | null>(null);
  const blockedRef = useRef<number | null>(null);

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

  const checkKey = useCallback(
    async (attempt: number) => {
      let status: VoiceStatusRes | undefined;
      try {
        status = await apiFetch<VoiceStatusRes | undefined>(
          "GET",
          "/api/voice",
        );
      } catch {
        return;
      }
      // A page that is not JSON (a sign-in proxy) gives no status: fail open.
      if (!status || voiceKeySourceUsable(status.keySource)) return;
      if (!mountedRef.current || liveAttemptRef.current !== attempt) return;
      liveAttemptRef.current = null;
      blockedRef.current = attempt;
      // Clearing the ref first makes the stop listener drop the clip.
      const recorder = recorderRef.current;
      recorderRef.current = null;
      recorder?.stop();
      releaseMic();
      setError(
        status.keySource
          ? { kind: "keySecret", name: status.keyName ?? VOICE_KEY_NAME }
          : { kind: "keyMissing" },
      );
      move("idle");
    },
    [move, releaseMic],
  );

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
    const attempt = ++attemptRef.current;
    liveAttemptRef.current = attempt;
    void checkKey(attempt);
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        startingRef.current = false;
        if (!mountedRef.current || blockedRef.current === attempt) {
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
          liveAttemptRef.current = null;
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
        // A missing key wins: a mic grant cannot help without one.
        if (mountedRef.current && blockedRef.current !== attempt)
          setError({ kind: "micDenied" });
      });
  }, [checkKey, move, releaseMic, upload]);

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
