// The replay of a terminal recording (task 749cb7fd), opened from the audit
// log. A recording holds bytes any member could print, and an owner plays it
// in their own browser, so the terminal is inert: no input, no clipboard
// addon (OSC 52), and a link handler that opens nothing (OSC 8).

import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n.tsx";
import { useTheme } from "../store.tsx";
import {
  isTerminalSize,
  parseTerminalRecording,
  type ParsedTerminalRecording,
} from "../../shared/terminal-recording.ts";
import { DARK_THEME, LIGHT_THEME } from "../log-view/terminal-themes.ts";
import { dialogCancelBtn, dialogInput } from "./dialog-styles.ts";
import { Portal } from "./Portal.tsx";

const SPEEDS = [1, 2, 4, 8] as const;

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function TerminalReplay({
  recordingId,
  title,
  onClose,
}: {
  recordingId: string;
  title: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { mode } = useTheme();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const [recording, setRecording] = useState<ParsedTerminalRecording | null>(
    null,
  );
  const [error, setError] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<number>(1);
  const [position, setPosition] = useState(0);
  const [typist, setTypist] = useState<string | null>(null);
  // The playback runs on refs, outside React renders: the next event, the
  // recording time, and the timer.
  const loaded = useRef<ParsedTerminalRecording | null>(null);
  const next = useRef(0);
  const at = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speedRef = useRef(1);

  // Writes every event up to the recording time `to`.
  const advance = useCallback((to: number) => {
    const term = termRef.current;
    const events = loaded.current?.events ?? [];
    while (next.current < events.length && events[next.current][0] <= to) {
      const event = events[next.current++];
      if (event[1] === "o") term?.write(event[2]);
      else if (event[1] === "r") {
        const [cols, rows] = event[2].split("x").map(Number);
        if (isTerminalSize(cols, rows)) term?.resize(cols, rows);
      } else if (event[1] === "u") setTypist(event[2].name);
    }
    at.current = to;
    setPosition(to);
  }, []);

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const start = useCallback(() => {
    stop();
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      advance(at.current + ((now - last) / 1000) * speedRef.current);
      last = now;
      const upcoming = loaded.current?.events[next.current];
      if (!upcoming) {
        timer.current = null;
        setPlaying(false);
        return;
      }
      const wait = ((upcoming[0] - at.current) / speedRef.current) * 1000;
      timer.current = setTimeout(tick, Math.max(0, Math.min(wait, 250)));
    };
    tick();
  }, [advance, stop]);

  // Playback starts once both the recording and the terminal are there: the
  // fetch starts at mount, the terminal when the portal renders its host.
  const begun = useRef(false);
  const begin = useCallback(() => {
    const parsed = loaded.current;
    const term = termRef.current;
    if (!parsed || !term || begun.current) return;
    begun.current = true;
    term.resize(parsed.header.width, parsed.header.height);
    // The view opens playing.
    start();
  }, [start]);

  useEffect(() => {
    let live = true;
    // Global fetch: apiFetch parses JSON, and the file is text.
    fetch(`/api/terminal-recordings/${encodeURIComponent(recordingId)}`, {
      credentials: "same-origin",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const parsed = parseTerminalRecording(await response.text());
        if (!live) return;
        loaded.current = parsed;
        setRecording(parsed);
        begin();
      })
      .catch(() => {
        if (live) setError(true);
      });
    return () => {
      live = false;
      stop();
    };
  }, [recordingId, begin, stop]);

  useEffect(() => {
    if (!host) return;
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      disableStdin: true,
      cursorBlink: false,
      theme: mode === "dark" ? DARK_THEME : LIGHT_THEME,
      minimumContrastRatio: 4.5,
      linkHandler: { activate: () => {} },
    });
    term.open(host);
    termRef.current = term;
    begin();
    return () => {
      stop();
      term.dispose();
      termRef.current = null;
    };
    // One terminal per host; the theme is read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  const duration = recording?.events.at(-1)?.[0] ?? 0;

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onClose]);

  const togglePlay = () => {
    const parsed = loaded.current;
    if (!parsed) return;
    if (playing) {
      stop();
      setPlaying(false);
      return;
    }
    if (next.current >= parsed.events.length) {
      // From the end, play again from the start.
      termRef.current?.reset();
      termRef.current?.resize(parsed.header.width, parsed.header.height);
      next.current = 0;
      at.current = 0;
      setPosition(0);
      setTypist(null);
    }
    setPlaying(true);
    start();
  };

  const changeSpeed = (value: number) => {
    speedRef.current = value;
    setSpeed(value);
    // The next wait is timed at the new speed.
    if (playing) start();
  };

  return (
    <Portal>
      <div
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 1100,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 20,
          background: "rgba(0,0,0,0.62)",
        }}
      >
        <section
          role="dialog"
          aria-modal="true"
          aria-label={t("audit.replay.title")}
          style={{
            width: "min(1000px, 100%)",
            maxHeight: "calc(100dvh - 40px)",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            padding: 20,
            border: "1px solid var(--border-light)",
            borderRadius: 12,
            background: "var(--bg-overlay)",
            boxShadow: "0 20px 60px var(--shadow-heavy)",
          }}
        >
          <h3 style={{ margin: 0, fontSize: 17 }}>
            {t("audit.replay.title")} · {title}
          </h3>
          {error ? (
            <p role="alert">{t("audit.replay.failed")}</p>
          ) : !recording ? (
            <p>{t("common.loading")}</p>
          ) : null}
          <div
            ref={setHost}
            style={{
              overflow: "auto",
              minHeight: 0,
              background:
                mode === "dark"
                  ? DARK_THEME.background
                  : LIGHT_THEME.background,
              padding: 8,
              borderRadius: 6,
            }}
          />
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              style={dialogCancelBtn}
              aria-pressed={playing}
              disabled={!recording}
              onClick={togglePlay}
            >
              {playing ? t("audit.replay.pause") : t("audit.replay.play")}
            </button>
            <select
              aria-label={t("audit.replay.speed")}
              value={speed}
              onChange={(event) => changeSpeed(Number(event.target.value))}
              style={{ ...dialogInput, width: "auto" }}
            >
              {SPEEDS.map((value) => (
                <option key={value} value={value}>
                  {value}×
                </option>
              ))}
            </select>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>
              {clock(position)} / {clock(duration)}
            </span>
            {typist && (
              <span style={{ color: "var(--text-muted)" }}>
                {t("audit.replay.typing", { name: typist })}
              </span>
            )}
            <button
              type="button"
              style={{ ...dialogCancelBtn, marginLeft: "auto" }}
              onClick={onClose}
            >
              {t("common.close")}
            </button>
          </div>
        </section>
      </div>
    </Portal>
  );
}
