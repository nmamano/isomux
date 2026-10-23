// The lobby record player: every press mints a fresh take from one of six
// style composers (task 099b0327). Composition is rule-based and seeded, so
// no two plays are alike and nothing is licensed. All synthesis is WebAudio;
// the only payload is the note grammar below.
import { useSyncExternalStore } from "react";

export type StyleId =
  | "classical"
  | "jazz"
  | "lofi"
  | "house"
  | "chip"
  | "bossa";

export const STYLES: StyleId[] = [
  "classical",
  "jazz",
  "lofi",
  "house",
  "chip",
  "bossa",
];

export interface ToneEvent {
  kind: "tone";
  midi: number;
  at: number;
  dur: number;
  amp: number;
  attack?: number;
}

export type DrumKind = "kick" | "snare" | "hat" | "ohat";

export interface DrumEvent {
  kind: DrumKind;
  at: number;
  amp: number;
}

export type MintEvent = ToneEvent | DrumEvent;

export interface MintedPiece {
  style: StyleId;
  tempo: number;
  loopEnd: number;
  events: MintEvent[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)];
}

const beat2sec = (bpm: number, beats: number) => (beats * 60) / bpm;

// ---------------------------------------------------------------- classical

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const CLASSICAL_PLANS = [
  ["I", "V", "IV", "I", "vi", "IV", "V", "I"],
  ["I", "vi", "IV", "V", "I", "IV", "V", "I"],
  ["I", "IV", "V", "I", "vi", "ii", "V", "I"],
];
const PLAN_TO_ROOT: Record<string, number> = {
  I: 0,
  ii: 2,
  iii: 4,
  IV: 5,
  V: 7,
  vi: 9,
};
const CLASSICAL_RHYTHMS = [
  [1, 1, 1],
  [1.5, 0.5, 1],
  [1, 1.5, 0.5],
  [2, 1],
  [1, 0.5, 0.5, 1],
  [0.5, 0.5, 1, 1],
];

function composeClassical(rng: () => number): MintedPiece {
  const tempo = 88 + Math.floor(rng() * 14);
  const b = (beats: number) => beat2sec(tempo, beats);
  const rootMidi = 57 + 5 * Math.floor(rng() * 2); // A3 or D4 diatonic family
  const plan = pick(rng, CLASSICAL_PLANS);
  const events: MintEvent[] = [];
  let degree = 4;
  // The eight-bar plan plays twice.
  for (let half = 0; half < 2; half += 1) {
    for (let bar = 0; bar < 8; bar += 1) {
      const chord = plan[bar];
      const chordRoot = (rootMidi + PLAN_TO_ROOT[chord]) % 12;
      // Bass: oom on beat 1, pah a fifth or third on beats 2-3.
      events.push({
        kind: "tone",
        midi: chordRoot + 36,
        at: b((half * 8 + bar) * 3),
        dur: b(0.95),
        amp: 0.4,
      });
      events.push({
        kind: "tone",
        midi: chordRoot + (rng() < 0.5 ? 43 : 48),
        at: b((half * 8 + bar) * 3 + 1),
        dur: b(0.95),
        amp: 0.3,
      });
      events.push({
        kind: "tone",
        midi: chordRoot + (rng() < 0.5 ? 43 : 45),
        at: b((half * 8 + bar) * 3 + 2),
        dur: b(0.95),
        amp: 0.28,
      });
      // Melody: a rhythm pattern whose last note lands near the chord root.
      const rhythm = bar === 7 ? [2.5] : pick(rng, CLASSICAL_RHYTHMS);
      let at0 = (half * 8 + bar) * 3;
      for (let i = 0; i < rhythm.length; i += 1) {
        if (i < rhythm.length - 1) {
          degree = Math.min(6, Math.max(0, degree + Math.floor(rng() * 5) - 2));
        } else {
          const chordDegree = MAJOR.indexOf((chordRoot - rootMidi + 12) % 12);
          if (chordDegree >= 0) {
            degree = chordDegree;
          }
        }
        events.push({
          kind: "tone",
          midi: rootMidi + 24 + MAJOR[degree],
          at: b(at0),
          dur: b(rhythm[i] * 0.92),
          amp: 0.72,
        });
        at0 += rhythm[i];
      }
    }
  }
  return { style: "classical", tempo, loopEnd: b(48), events };
}

// --------------------------------------------------------------------- jazz

function composeJazz(rng: () => number): MintedPiece {
  const tempo = 124 + Math.floor(rng() * 16);
  const b = (beats: number) => beat2sec(tempo, beats);
  const events: MintEvent[] = [];
  const chain = pick(rng, [
    [50, 55, 48, 57],
    [45, 50, 40, 55],
  ]);
  const loopBeats = chain.length * 4;
  chain.forEach((root, i) => {
    const barAt = i * 4;
    // Walking bass: chord tone on the downbeat, small steps across the bar.
    const walk = [
      [root, root + 9, root + 5, root + 7],
      [root, root + 7, root + 10, root + 9],
      [root, root + 3, root + 5, root + 7],
      [root, root + 5, root + 4, root + 2],
    ][Math.floor(rng() * 4)];
    for (let q = 0; q < 4; q += 1) {
      events.push({
        kind: "tone",
        midi: 36 + (walk[q] % 12),
        at: b(barAt + q),
        dur: b(0.85),
        amp: 0.34,
      });
      events.push({ kind: "hat", at: b(barAt + q), amp: 0.16 });
      if (q === 1 || q === 3) {
        events.push({ kind: "snare", at: b(barAt + q), amp: 0.3 });
      }
    }
    // Laid-back four-note riff on top (eighth pairs).
    const riffRoot = root + 24;
    const shapes = [
      [0, 3, 7, 10],
      [7, 5, 3, 0],
      [10, 7, 5, 3],
    ];
    const shape = pick(rng, shapes);
    shape.forEach((iv, j) => {
      events.push({
        kind: "tone",
        midi: riffRoot + iv,
        at: b(barAt + j * 1.02 + (j % 2 === 1 ? 0.12 : 0)),
        dur: b(0.7),
        amp: 0.5,
      });
    });
  });
  return { style: "jazz", tempo, loopEnd: b(loopBeats), events };
}

// --------------------------------------------------------------------- lofi

const LOFI_PROGS = [
  [45, 50, 41, 48],
  [48, 45, 53, 50],
  [45, 48, 43, 45],
];

function composeLofi(rng: () => number): MintedPiece {
  const tempo = 68 + Math.floor(rng() * 8);
  const b = (beats: number) => beat2sec(tempo, beats);
  const events: MintEvent[] = [];
  const prog = pick(rng, LOFI_PROGS);
  const loopBeats = prog.length * 4;
  prog.forEach((root, i) => {
    const barAt = i * 4;
    // Lush m9 pad: root, m3, p5, octave 9 in the middle register.
    [root, root + 3, root + 7, root + 14].forEach((iv, j) => {
      events.push({
        kind: "tone",
        midi: iv + 12,
        at: b(barAt) + j * 0.02,
        dur: b(3.9),
        amp: 0.16,
        attack: 0.35,
      });
    });
    events.push({ kind: "kick", at: b(barAt), amp: 0.7 });
    events.push({ kind: "kick", at: b(barAt + 2.5), amp: 0.4 });
    events.push({ kind: "snare", at: b(barAt + 1), amp: 0.24 });
    events.push({ kind: "snare", at: b(barAt + 3), amp: 0.22 });
    for (let e = 0; e < 8; e += 1) {
      if (rng() < 0.25) {
        continue;
      }
      events.push({
        kind: "hat",
        at: b(barAt + e * 0.5),
        amp: e % 2 === 0 ? 0.1 : 0.05 + rng() * 0.05,
      });
    }
    // Lazy pentatonic melody, two or three notes per bar.
    const pent = [0, 3, 5, 7, 10];
    const n = 2 + Math.floor(rng() * 2);
    for (let k = 0; k < n; k += 1) {
      const at0 = 0.5 + Math.floor(rng() * 3);
      events.push({
        kind: "tone",
        midi: root + 24 + pick(rng, pent),
        at: b(barAt + at0 + (rng() < 0.3 ? 0.4 : 0)),
        dur: b(1.2 + rng()),
        amp: 0.34,
      });
    }
  });
  events.sort((x, y) => x.at - y.at);
  return { style: "lofi", tempo, loopEnd: b(loopBeats), events };
}

// -------------------------------------------------------------------- house

function composeHouse(rng: () => number): MintedPiece {
  const tempo = 122 + Math.floor(rng() * 6);
  const b = (beats: number) => beat2sec(tempo, beats);
  const events: MintEvent[] = [];
  const roots = pick(rng, [
    [45, 45, 50, 50],
    [43, 43, 48, 45],
    [41, 41, 48, 50],
  ]);
  roots.forEach((root, i) => {
    const barAt = i * 4;
    for (let q = 0; q < 4; q += 1) {
      events.push({ kind: "kick", at: b(barAt + q), amp: 0.85 });
      events.push({ kind: "ohat", at: b(barAt + q + 0.5), amp: 0.3 });
      events.push({ kind: "hat", at: b(barAt + q + 0.25), amp: 0.08 });
      events.push({ kind: "hat", at: b(barAt + q + 0.75), amp: 0.08 });
      if (q === 1 || q === 3) {
        events.push({ kind: "snare", at: b(barAt + q), amp: 0.35 });
      }
      // Rolling off-beat bass between the kicks.
      events.push({
        kind: "tone",
        midi: root + 12,
        at: b(barAt + q + 0.5),
        dur: b(0.45),
        amp: 0.4,
      });
      if (q % 2 === 0) {
        events.push({
          kind: "tone",
          midi: root,
          at: b(barAt + q),
          dur: b(0.4),
          amp: 0.3,
        });
      }
    }
    // Minor-9 stabs on the up-beats of 2 and 4.
    [1.5, 3.5].forEach((pos) => {
      [root + 12, root + 15, root + 19, root + 22].forEach((iv, k) => {
        events.push({
          kind: "tone",
          midi: iv,
          at: b(barAt + pos),
          dur: b(0.35),
          amp: 0.2 + k * 0.012,
          attack: 0.003,
        });
      });
    });
  });
  return { style: "house", tempo, loopEnd: b(16), events };
}

// --------------------------------------------------------------- bossa nova

const BOSSA_QUALITIES: Record<string, number[]> = {
  m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  dom7: [0, 4, 7, 10],
};
const BOSSA_PROGS = [
  [
    { r: 57, q: "m7" },
    { r: 50, q: "dom7" },
    { r: 48, q: "maj7" },
    { r: 55, q: "maj7" },
  ],
  [
    { r: 57, q: "m7" },
    { r: 53, q: "m7" },
    { r: 48, q: "maj7" },
    { r: 53, q: "dom7" },
  ],
];
const BOSSA_COLORS = [7, 10, 11, 14];

function composeBossa(rng: () => number): MintedPiece {
  const tempo = 76 + Math.floor(rng() * 10);
  const b = (beats: number) => beat2sec(tempo, beats);
  const events: MintEvent[] = [];
  const prog = pick(rng, BOSSA_PROGS);
  prog.forEach((c, i) => {
    const ivs = BOSSA_QUALITIES[c.q];
    for (let bar = 0; bar < 2; bar += 1) {
      const at0 = i * 8 + bar * 4;
      // Surdo pulse plus the brushed backbeat.
      events.push({ kind: "kick", at: b(at0), amp: 0.5 });
      events.push({ kind: "kick", at: b(at0 + 1.5), amp: 0.38 });
      events.push({ kind: "kick", at: b(at0 + 3), amp: 0.44 });
      events.push({ kind: "snare", at: b(at0 + 1), amp: 0.12 });
      events.push({ kind: "snare", at: b(at0 + 3), amp: 0.1 });
      for (let h = 0; h < 8; h += 1) {
        if (rng() < 0.2) {
          continue;
        }
        events.push({
          kind: "hat",
          at: b(at0 + h * 0.5),
          amp: h % 2 === 0 ? 0.075 : 0.04,
        });
      }
      // Bass: root on 1, fifth on 3, anticipated octave on the last eighth.
      events.push({
        kind: "tone",
        midi: c.r - 12,
        at: b(at0),
        dur: b(1.1),
        amp: 0.38,
      });
      events.push({
        kind: "tone",
        midi: c.r - 5,
        at: b(at0 + 2),
        dur: b(0.9),
        amp: 0.3,
      });
      events.push({
        kind: "tone",
        midi: c.r,
        at: b(at0 + 3.5),
        dur: b(0.4),
        amp: 0.34,
      });
      // Nylon comp: the full voicing, short and pushed.
      [
        c.r + 12,
        c.r + 12 + ivs[1],
        c.r + 12 + ivs[2],
        c.r + 12 + ivs[3],
      ].forEach((midi, j) => {
        [1.5, 3.5].forEach((pos, k) => {
          events.push({
            kind: "tone",
            midi,
            at: b(at0 + pos),
            dur: b(0.7),
            amp: (k === 0 ? 0.19 : 0.15) + j * 0.004,
            attack: 0.004,
          });
        });
      });
      // A wide, unhurried melody line singing chord colors.
      if (bar === 0) {
        events.push({
          kind: "tone",
          midi: c.r + 12 + pick(rng, BOSSA_COLORS),
          at: b(at0 + 0.5),
          dur: b(1.9),
          amp: 0.42,
        });
      } else if (rng() < 0.75) {
        events.push({
          kind: "tone",
          midi: c.r + 12 + pick(rng, BOSSA_COLORS),
          at: b(at0 + 0.5),
          dur: b(1.4),
          amp: 0.38,
        });
      }
    }
  });
  return { style: "bossa", tempo, loopEnd: b(32), events };
}

// --------------------------------------------------------------------- chip

const CHIP_PROGS = [
  [45, 45, 41, 44],
  [45, 41, 38, 40],
  [38, 45, 41, 44],
];
const CHIP_LEAD = [0, 3, 5, 7, 10, 12, 15, 19];

function composeChip(rng: () => number): MintedPiece {
  const tempo = 132 + Math.floor(rng() * 14);
  const b = (beats: number) => beat2sec(tempo, beats);
  const events: MintEvent[] = [];
  const prog = pick(rng, CHIP_PROGS);
  const arpShape = pick(rng, [
    [0, 7, 12, 7],
    [0, 7, 15, 7],
    [0, 12, 19, 12],
  ]);
  prog.forEach((root, i) => {
    const barAt = i * 4;
    for (let six = 0; six < 16; six += 1) {
      events.push({
        kind: "tone",
        midi: root + 24 + arpShape[six % 4],
        at: b(barAt + six * 0.25),
        dur: b(0.2),
        amp: six % 4 === 0 ? 0.28 : 0.16,
      });
    }
    events.push({ kind: "kick", at: b(barAt), amp: 0.55 });
    events.push({ kind: "kick", at: b(barAt + 1.5), amp: 0.4 });
    events.push({ kind: "kick", at: b(barAt + 2), amp: 0.5 });
    events.push({ kind: "snare", at: b(barAt + 1), amp: 0.3 });
    events.push({ kind: "snare", at: b(barAt + 3), amp: 0.32 });
    for (let e = 0; e < 8; e += 1) {
      events.push({
        kind: "hat",
        at: b(barAt + e * 0.5),
        amp: e % 2 === 0 ? 0.08 : 0.06,
      });
    }
    // Square lead: a lively run in the upper pentatonic.
    let at0 = barAt;
    while (at0 < barAt + 3.5) {
      const step = 0.5 * (1 + Math.floor(rng() * 3));
      events.push({
        kind: "tone",
        midi: root + 36 + pick(rng, CHIP_LEAD),
        at: b(at0),
        dur: b(step * 0.85),
        amp: 0.3,
      });
      at0 += step;
    }
  });
  return { style: "chip", tempo, loopEnd: b(16), events };
}

const COMPOSERS: Record<StyleId, (rng: () => number) => MintedPiece> = {
  classical: composeClassical,
  jazz: composeJazz,
  lofi: composeLofi,
  house: composeHouse,
  chip: composeChip,
  bossa: composeBossa,
};

export function composeStyle(style: StyleId, seed: number): MintedPiece {
  const piece = COMPOSERS[style](mulberry32(seed));
  piece.events.sort((x, y) => x.at - y.at);
  return piece;
}

// ---------------------------------------------------------------- audio

const TIMBRE: Record<
  StyleId,
  { partials: number[]; cutoff: number; out: number }
> = {
  classical: { partials: [0, 1, 0.42, 0.2, 0.1], cutoff: 4200, out: 0.55 },
  jazz: { partials: [0, 1, 0.35, 0.15, 0.06], cutoff: 3000, out: 0.6 },
  lofi: { partials: [0, 1, 0.5, 0.25, 0.12, 0.06], cutoff: 1600, out: 0.75 },
  house: { partials: [0, 1, 0, 0.45, 0, 0.25], cutoff: 3800, out: 0.5 },
  chip: { partials: [0, 1, 0, 0.35, 0, 0.2, 0, 0.12], cutoff: 6000, out: 0.4 },
  bossa: {
    partials: [0, 1, 0.5, 0.3, 0.18, 0.09],
    cutoff: 3200,
    out: 0.55,
  },
};

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;
let master: GainNode | null = null;
let tone: BiquadFilterNode | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let index = 0;
let loopOrigin = 0;
let mint: MintedPiece | null = null;
// Bumped by every press and stop, so a resume that settles late can tell it
// belongs to a take that is no longer wanted.
let generation = 0;
let waveFor: StyleId | null = null;
let wave: PeriodicWave | null = null;
const live = new Set<AudioScheduledSourceNode>();

export interface JukeboxState {
  playing: boolean;
  // The style of the take that plays; null while stopped.
  style: StyleId | null;
}

const STOPPED: JukeboxState = { playing: false, style: null };
let state = STOPPED;

const listeners = new Set<() => void>();

function setState(next: JukeboxState) {
  state = next;
  for (const l of listeners) {
    l();
  }
}

function subscribeJukebox(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useJukebox(): JukeboxState {
  return useSyncExternalStore(
    subscribeJukebox,
    () => state,
    () => STOPPED,
  );
}

function freshSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

// Press while playing stops; the next press mints the next style's take.
export function toggleJukebox(): void {
  if (state.playing) {
    stopJukebox();
    return;
  }
  const style = mint
    ? STYLES[(STYLES.indexOf(mint.style) + 1) % STYLES.length]
    : STYLES[0];
  mint = composeStyle(style, freshSeed());
  generation += 1;
  const mine = generation;
  if (!ctx) {
    ctx = new AudioContext();
    noise = makeNoise(ctx);
    tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    master = ctx.createGain();
    master.connect(tone).connect(ctx.destination);
  }
  const audio = ctx;
  applyTimbre(style);
  setState({ playing: true, style });
  audio.resume().then(
    () => {
      if (mine !== generation) {
        // Stopped while the context woke up: put it back to sleep.
        if (!state.playing) {
          void audio.suspend();
        }
        return;
      }
      index = 0;
      loopOrigin = audio.currentTime + 0.08;
      pump();
      timer ??= setInterval(pump, 2000);
    },
    () => {
      if (mine === generation) {
        stopJukebox();
      }
    },
  );
}

// Silences every queued note at once, so nothing of this take plays later.
export function stopJukebox(): void {
  generation += 1;
  clearLive();
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (!state.playing) {
    return;
  }
  setState(STOPPED);
  void ctx?.suspend();
}

function clearLive() {
  for (const node of live) {
    try {
      node.stop(0);
    } catch {
      // already ended
    }
    try {
      node.disconnect();
    } catch {
      // not connected
    }
  }
  live.clear();
}

function applyTimbre(style: StyleId) {
  if (!ctx || !master || !tone) {
    return;
  }
  const t = TIMBRE[style];
  if (waveFor !== style) {
    wave = ctx.createPeriodicWave(
      new Float32Array(t.partials.length),
      new Float32Array(t.partials),
    );
    waveFor = style;
  }
  tone.frequency.value = t.cutoff;
  master.gain.value = t.out;
}

function makeNoise(audio: AudioContext): AudioBuffer {
  const buf = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.random() * 2 - 1;
  }
  return buf;
}

function track(node: AudioScheduledSourceNode) {
  live.add(node);
  node.onended = () => live.delete(node);
}

function pump() {
  const audio = ctx;
  if (!audio || !mint || !state.playing || audio.state !== "running") {
    return;
  }
  const horizon = audio.currentTime + 6;
  for (;;) {
    const ev = mint.events[index];
    const at = loopOrigin + ev.at;
    if (at > horizon) {
      break;
    }
    scheduleEvent(audio, ev, at);
    index += 1;
    if (index >= mint.events.length) {
      index = 0;
      loopOrigin += mint.loopEnd;
    }
  }
}

function scheduleEvent(audio: AudioContext, ev: MintEvent, at: number) {
  if (ev.kind === "tone") {
    scheduleTone(audio, ev, at);
    return;
  }
  switch (ev.kind) {
    case "kick":
      scheduleKick(audio, ev, at);
      break;
    case "snare":
      scheduleNoise(audio, ev, at, 0.09, 2400, "bandpass");
      break;
    case "hat":
      scheduleNoise(audio, ev, at, 0.035, 8000, "highpass");
      break;
    case "ohat":
      scheduleNoise(audio, ev, at, 0.16, 7000, "highpass");
      break;
  }
}

function scheduleTone(audio: AudioContext, ev: ToneEvent, at: number) {
  const freq = 440 * Math.pow(2, (ev.midi - 69) / 12);
  const osc = audio.createOscillator();
  osc.setPeriodicWave(wave!);
  osc.frequency.value = freq;
  const g = audio.createGain();
  const v = Math.max(ev.amp * 0.22, 0.001);
  const attack = ev.attack ?? 0.006;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.linearRampToValueAtTime(v, at + attack);
  g.gain.exponentialRampToValueAtTime(
    v * 0.14,
    at + Math.max(ev.dur * 0.8, 0.08),
  );
  g.gain.exponentialRampToValueAtTime(0.0001, at + ev.dur + 0.2);
  osc.connect(g).connect(master!);
  osc.start(at);
  osc.stop(at + ev.dur + 0.25);
  track(osc);
}

function scheduleKick(audio: AudioContext, ev: DrumEvent, at: number) {
  const osc = audio.createOscillator();
  osc.frequency.setValueAtTime(150, at);
  osc.frequency.exponentialRampToValueAtTime(42, at + 0.09);
  const g = audio.createGain();
  g.gain.setValueAtTime(ev.amp * 0.6, at);
  g.gain.exponentialRampToValueAtTime(0.001, at + 0.13);
  osc.connect(g).connect(master!);
  osc.start(at);
  osc.stop(at + 0.15);
  track(osc);
}

function scheduleNoise(
  audio: AudioContext,
  ev: DrumEvent,
  at: number,
  dur: number,
  freq: number,
  type: BiquadFilterType,
) {
  const src = audio.createBufferSource();
  src.buffer = noise!;
  src.loop = true;
  const f = audio.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  const g = audio.createGain();
  g.gain.setValueAtTime(ev.amp * 0.3, at);
  g.gain.exponentialRampToValueAtTime(0.001, at + dur);
  src.connect(f).connect(g).connect(master!);
  src.start(at);
  src.stop(at + dur + 0.02);
  track(src);
}
