// The composer mic, for the full chat (LogView) and the widget's chat
// (WidgetChat, task 4e18b327). The member's choice in Integrations > Voice
// picks the source: the browser's recognizer writes words as they come, and
// OpenAI records a clip the office server transcribes on stop. A stand-alone
// spoken "send" sends the draft. Ctrl+Space holds the mic while pushToTalk is on.
//
// The composer owns its draft and its send; the hook reads and writes them
// through the options, which it keeps in a ref, so its handlers always see the
// latest ones.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  advanceDictationSession,
  joinSpoken,
  reconcileDictationEdit,
  splitSpokenSubmit,
  startDictationSession,
} from "../spoken-punctuation.ts";
import { micAvailable, pickRecorderMimeType } from "../voice-input.ts";
import { voiceInputErrorMessage } from "../voice-input-error.ts";
import { useI18n } from "../i18n.tsx";
import type { VoiceInput } from "../../shared/voice.ts";
import {
  useRecordedDictation,
  type RecordedDictation,
} from "./useRecordedDictation.ts";
import { useSelfUser } from "./useSelfUser.ts";
import { useSpeechLocale } from "./useSpeechLocale.ts";

export interface ComposerVoiceOptions {
  // Words the OpenAI transcriber should expect (the agents' names).
  keywords: string[];
  // The composer's text now.
  draft: () => string;
  // Writes dictated text to the composer.
  setDraft: (text: string) => void;
  // Sends text; true when the send went ahead. keepListening keeps the
  // browser recognizer open (a spoken "send" mid-dictation).
  send: (opts: { text: string; keepListening?: boolean }) => boolean;
  // After each dictated write, for the composer's size and scroll.
  onDictated?: () => void;
  // Whether Ctrl+Space dictates.
  pushToTalk: boolean;
}

export interface ComposerVoice {
  voiceInput: VoiceInput;
  // A working mic, and a mic this browser would have but for plain HTTP.
  micShown: boolean;
  micNeedsHttps: boolean;
  listening: boolean;
  transcribing: boolean;
  // The OpenAI path, for VoiceInputAlert.
  recorded: RecordedDictation;
  // The browser path's error line.
  error: string | null;
  // The mic button's click.
  toggle: () => void;
  start: () => void;
  // discard drops the recognizer's pending words (a send just cleared the
  // composer). A recording is transcribed either way.
  stop: (discard?: boolean) => void;
  // A composer edit that is not dictation: while the recognizer listens, it
  // joins the session, so the next result does not write over it.
  reconcileEdit: (text: string) => string;
}

export function useComposerVoice(opts: ComposerVoiceOptions): ComposerVoice {
  const i18n = useI18n();
  const optsRef = useRef(opts);
  const speechLocale = useSpeechLocale();
  const self = useSelfUser();
  const [isListening, setIsListening] = useState(false);
  const isListeningRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  // The draft text before voice started + every finalized speech segment since.
  const dictationRef = useRef(startDictationSession(""));

  const SpeechRecognition =
    window.SpeechRecognition ?? window.webkitSpeechRecognition;
  // OpenAI never falls back to the browser's recognizer, which would send the
  // audio to the browser vendor. Until the member's own record arrives the
  // choice is unknown, so there is no mic.
  const voiceInput = self?.voiceInput ?? "browser";
  const recorderMimeType =
    typeof MediaRecorder !== "undefined" && navigator.mediaDevices
      ? pickRecorderMimeType((type) => MediaRecorder.isTypeSupported(type))
      : null;
  const micShown =
    self !== null &&
    micAvailable({
      speechRecognition: Boolean(SpeechRecognition),
      voiceInput,
      secureContext: window.isSecureContext,
      recorderMimeType,
    });
  const micNeedsHttps =
    self !== null &&
    !window.isSecureContext &&
    (voiceInput === "openai"
      ? recorderMimeType !== null
      : Boolean(SpeechRecognition));
  const micShownRef = useRef(micShown);

  function showDictated(text: string) {
    optsRef.current.setDraft(text);
    const after = optsRef.current.onDictated;
    if (after) requestAnimationFrame(after);
  }

  const recorded = useRecordedDictation({
    locale: speechLocale,
    keywords: opts.keywords,
    onTranscript(text) {
      const spoken = splitSpokenSubmit(text, speechLocale);
      const session = advanceDictationSession(
        startDictationSession(optsRef.current.draft(), speechLocale),
        spoken.text ? [spoken.text] : [],
        "",
      );
      // A send that cannot go ahead (offline, an upload in flight) keeps the
      // words on the draft.
      if (spoken.submit && optsRef.current.send({ text: session.display }))
        return;
      showDictated(session.display);
    },
  });
  const listening =
    voiceInput === "openai" ? recorded.state === "recording" : isListening;

  function start() {
    if (voiceInput === "openai") {
      recorded.start();
      return;
    }
    if (isListeningRef.current || !SpeechRecognition) return;
    setError(null);
    dictationRef.current = startDictationSession(
      optsRef.current.draft(),
      speechLocale,
    );
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    // The Web Speech API has no auto-detect: it transcribes whatever locale it
    // is told and mangles anything else, so this has to come from somewhere.
    // The user's language preference if they have set one, otherwise whatever
    // the browser reports; it was pinned to en-US before.
    recognition.lang = speechLocale;
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interimRaw = "";
      let session = dictationRef.current;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          // A stand-alone submit only: a recognizer fragment ends at a pause.
          const spoken = splitSpokenSubmit(t, speechLocale);
          if (spoken.submit && !spoken.text) {
            const finalizedSession = advanceDictationSession(session, [], "");
            dictationRef.current = finalizedSession;
            const sent = optsRef.current.send({
              text: finalizedSession.display,
              keepListening: true,
            });
            if (sent) session = startDictationSession("", speechLocale);
          } else {
            session = advanceDictationSession(session, [t], "");
          }
        } else {
          interimRaw = joinSpoken(interimRaw, t);
        }
      }
      dictationRef.current = advanceDictationSession(session, [], interimRaw);
      showDictated(dictationRef.current.display);
    };
    recognition.onend = () => {
      isListeningRef.current = false;
      setIsListening(false);
    };
    recognition.onerror = (event) => {
      isListeningRef.current = false;
      setIsListening(false);
      const message = voiceInputErrorMessage(i18n, event.error);
      if (message) setError(message);
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      isListeningRef.current = false;
      setIsListening(false);
      const message = voiceInputErrorMessage(i18n, "start-failed");
      if (message) setError(message);
      return;
    }
    isListeningRef.current = true;
    setIsListening(true);
  }

  function stop(discard?: boolean) {
    // A recording is transcribed, never dropped: its words are not on the
    // draft yet.
    recorded.stop();
    const recognition = recognitionRef.current;
    if (!recognition) return;
    if (discard) {
      // Send path: the composer was just cleared, so drop any pending final
      // result. abort() discards it, and detaching onresult stops a trailing
      // event from repopulating the box. onend still resets the listening flag.
      recognition.onresult = null;
      recognition.abort();
    } else {
      recognition.stop();
    }
  }

  function toggle() {
    if (voiceInput === "openai") {
      if (recorded.state === "recording") recorded.stop();
      else if (recorded.state !== "transcribing") recorded.start();
    } else if (isListeningRef.current) stop();
    else start();
  }

  function reconcileEdit(text: string): string {
    if (!isListeningRef.current) return text;
    dictationRef.current = reconcileDictationEdit(dictationRef.current, text);
    return dictationRef.current.display;
  }

  // Ctrl+Space push-to-talk. Latest-ref the handlers so the listener started
  // with pushToTalk dispatches to the current composer.
  const startRef = useRef(start);
  const stopRef = useRef(stop);
  useLayoutEffect(() => {
    optsRef.current = opts;
    micShownRef.current = micShown;
    startRef.current = start;
    stopRef.current = stop;
  });
  const { pushToTalk } = opts;
  useEffect(() => {
    if (!pushToTalk || !window.isSecureContext) return;
    function onKeyDown(e: KeyboardEvent) {
      if (
        micShownRef.current &&
        e.code === "Space" &&
        e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        !e.repeat
      ) {
        e.preventDefault();
        startRef.current();
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space" && !e.repeat) {
        stopRef.current();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [pushToTalk]);
  // The recognizer ends with the composer.
  useEffect(() => () => recognitionRef.current?.stop(), []);

  return {
    voiceInput,
    micShown,
    micNeedsHttps,
    listening,
    transcribing: recorded.state === "transcribing",
    recorded,
    error,
    toggle,
    start,
    stop,
    reconcileEdit,
  };
}
