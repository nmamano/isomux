// The chime at a turn end. On iOS a running AudioContext pauses audio from
// other apps, so the context runs only while a chime plays.

export interface NotificationSound {
  // From a click: unlocks the chime for later, with nothing playing.
  prime(): void;
  play(): void;
}

export function createNotificationSound(): NotificationSound {
  let ctx: AudioContext | null = null;
  // Chimes that started and have not ended yet.
  let live = 0;

  // A context made in a click stays unlocked: Safari lets it resume later
  // without one, when the page is hidden.
  function ensure(): AudioContext | null {
    if (!ctx && typeof AudioContext !== "undefined") {
      ctx = new AudioContext();
    }
    return ctx;
  }

  return {
    prime() {
      if (ctx) return;
      try {
        void ensure()?.suspend();
      } catch {}
    },
    play() {
      try {
        const audio = ensure();
        if (!audio) return;
        // Always: a suspend still pending leaves state "running", and the
        // last request wins.
        void audio.resume();
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.connect(gain);
        gain.connect(audio.destination);
        osc.frequency.setValueAtTime(800, audio.currentTime);
        osc.frequency.setValueAtTime(600, audio.currentTime + 0.1);
        gain.gain.setValueAtTime(0.15, audio.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.3);
        osc.onended = () => {
          live -= 1;
          if (live === 0) void audio.suspend();
        };
        osc.start(audio.currentTime);
        live += 1;
        osc.stop(audio.currentTime + 0.3);
      } catch {}
    },
  };
}
