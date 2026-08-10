# Voice conversation mode

**Status: direction only, no commitment (Nil, 2026-08-09).** This doc records a landscape scan and a recommended shape. Nothing is approved for build.

Goal, in Nil's words: have a back and forth with an isomux agent by voice, without a click on Send after each utterance, and with a response voice that does not sound like a 2010 screen reader.

## 1. What isomux does today

Both directions use the browser Web Speech API, and nothing connects them.

- **Speech in:** `ui/log-view/LogView.tsx` (`startListening`, around line 1350). `SpeechRecognition` with `continuous` and `interimResults`, driven by a mic button or Ctrl+Space push-to-talk. It writes into the composer draft. The user then presses Send.
- **Speech out:** `ui/components/SpeakButton.tsx`. A per-message button that calls `speechSynthesis.speak()` with a voice picked from the device (`pickVoice` prefers Google voices, then the default). Quality is whatever the operating system supplies. There is no auto-speak.
- **Language:** `ui/hooks/useSpeechLocale.ts` gives both sides an explicit locale, because `SpeechRecognition` has no auto-detect.

So there are two independent problems: **turn-taking** (no Send) and **voice quality**. They can be solved separately and in either order.

## 2. Problem 1: turn-taking

This is a state machine in the browser. It does not need a new service.

```
Listening --(silence for ~1.5s)--> Sending --> Thinking --(first sentence streams in)--> Speaking --> Listening
Speaking --(user speaks)--> Listening        # barge-in: stop the audio
Thinking --(user speaks)--> Listening        # isomux already queues or steers mid-turn messages
```

Endpointing options:

- **Cheap:** a timer over the existing `SpeechRecognition` results. If no new result arrives for ~1.5s, send. No new dependency.
- **Correct:** [Silero VAD](https://github.com/snakers4/silero-vad) in the browser through `vad-web` or `@ricky0123/vad-web`. An ONNX model of about 2MB that runs in a web worker on CPU. It gives reliable end-of-speech and, more importantly, **barge-in**, which the timer approach cannot give.

A real VAD is also the answer if Web Speech continuous mode proves unreliable on iOS, which is likely on Nil's phone.

Product questions that the state machine forces (see §6): what happens during a long "Thinking" gap, and whether voice mode is per agent.

## 3. Problem 2: voice quality

Ordered by integration cost.

### 3a. Server-proxied cloud TTS (recommended)

A `POST /api/tts` endpoint that streams audio from a provider. Keys stay on the server. The client speaks each sentence as the reply streams, so audio starts in about 200ms instead of after the full turn.

Provider landscape, as reported by vendor comparisons read on 2026-08-09 (vendor-published numbers, not measured by us):

| Provider | Note |
| --- | --- |
| Cartesia Sonic 3.5 | About 40ms time to first byte. Built for voice agents. |
| Inworld Realtime TTS-2 | Top of the Artificial Analysis realtime TTS arena, 130-250ms P90. |
| Speechmatics | About $0.011 per 1000 characters. Claims 11-27x cheaper than ElevenLabs. |
| OpenAI TTS | Adequate quality, cheap, one more key we may already have. |
| ElevenLabs | Best narration quality, highest price. |
| Deepgram Aura-2 | Bundles STT and TTS plus a voice-agent API. |

Order of magnitude: about one cent per agent reply. Below 130ms, the difference between providers is not perceptible in a conversation.

### 3b. Self-hosted TTS

[Kokoro-82M](https://localaimaster.com/blog/kokoro-tts-local-setup), Apache 2.0, 54 voices, no GPU needed. Vendor write-ups claim about 10x realtime on CPU (read 2026-08-09, not measured on our box). Piper is faster and lower quality.

A large quality gain over `speechSynthesis` with no API key, which is attractive for self-hosters. But it competes with agent processes for the office box CPU, and the office box has no GPU. Do not start here.

### 3c. Cloud STT

Streaming STT providers cost $0.30 to $0.50 per hour for voice-agent traffic (Deepgram Flux, AssemblyAI Universal-3, ElevenLabs Scribe v2). Groq-hosted Whisper is far cheaper for batch. Figures read 2026-08-09.

Web Speech recognition is free and already works. Only move to a paid STT if accuracy or iOS behavior becomes the blocker. If we do move, the browser must send raw audio over a websocket, which is much more machinery than the TTS proxy.

## 4. Codex already has a realtime voice session

The vendored Codex app-server types include an experimental thread-scoped realtime API: `server/backends/codex/_generated/v2/ThreadRealtime*.ts`.

It carries audio in (`ThreadRealtimeAppendAudioParams`), audio out (`ThreadRealtimeOutputAudioDeltaNotification`), live transcripts (`ThreadRealtimeTranscriptDelta/Done`), WebRTC or websocket transport (`ThreadRealtimeStartTransport`), 19 voices (`RealtimeVoice`), and handoff of Codex responses into the realtime conversation (`codexResponsesAsItems`, `codexResponseHandoffPrefix`).

That is the full hands-free loop, already built, for Codex agents only. Claude Code has no equivalent. A short spike to find out whether it works would inform the build-versus-adopt decision, but a Codex-only voice mode does not serve the whole office.

## 5. Recommendation

Build the loop ourselves in the browser, because it must work for both engines:

1. Auto-speak the streaming reply, sentence by sentence, through a server TTS proxy. This alone fixes the complaint about voice quality and removes most of the clicking.
2. Add VAD endpointing and auto-send.
3. Add barge-in.

Each step is useful on its own, so this can ship in slices.

## 6. Open questions for Nil

- **Per agent or global?** Voice fits a brainstormer. It does not fit a worker in the middle of a refactor. Probably an agent-level or room-level setting.
- **What happens during "Thinking"?** Agent turns run from ten seconds to several minutes. Silence, a sound, or an agent that narrates its work?
- **Who pays for TTS?** A hosted-isomux customer, the self-hoster with their own key, or a mixture. This decides whether 3b becomes necessary as a no-key default.

## Sources

Read 2026-08-09. All figures are vendor-published.

- [Best TTS API 2026 (Inworld)](https://inworld.ai/resources/best-tts-api-2026)
- [Best TTS APIs for real-time voice agents, 2026 benchmarks (Inworld)](https://inworld.ai/resources/best-voice-ai-tts-apis-for-real-time-voice-agents-2026-benchmarks)
- [Best TTS APIs in 2026 (Speechmatics)](https://www.speechmatics.com/company/articles-and-news/best-tts-apis-in-2025-top-12-text-to-speech-services-for-developers)
- [Speech-to-text APIs in 2026 (Future AGI)](https://futureagi.com/blog/speech-to-text-apis-in-2026-benchmarks-pricing-developer-s-decision-guide/)
- [Self-hosted TTS comparison](https://gigagpu.com/self-hosted-tts-comparison/)
- [Silero VAD](https://github.com/snakers4/silero-vad)
