/*
 * INKFIST procedural audio: generative music logic. Pure (no DOM): a track generator is driven
 * step by step by a scheduler and emits note events into a MusicOut sink. The Web Audio engine
 * (music.ts) and the offline checker (tools/audio-check.mjs) both implement MusicOut.
 */

import { clamp, pick, rr } from './dsp';
import type { Rng } from './dsp';
import { NOTE_COUNT } from './instruments';
import type { DroneName, DrumName, GongKind } from './instruments';

export type Bend = 'up' | 'fall' | 'vib';

export interface PluckOpts {
  /** damp the string after this many seconds (staccato); omit to let it ring */
  len?: number;
  bend?: Bend;
  pan?: number;
}

export interface FluteNote {
  /** scale index (see SCALE_MIDI) */
  idx: number;
  /** seconds */
  dur: number;
}

export interface MusicOut {
  pluck(t: number, idx: number, vel: number, o?: PluckOpts): void;
  drum(t: number, d: DrumName, vel: number): void;
  flute(t: number, notes: readonly FluteNote[], vel: number): void;
  gong(t: number, kind: GongKind, vel: number): void;
  /** brightness (low-pass cutoff, Hz) of the string section */
  tone(t: number, cutoff: number): void;
}

export type TrackName = 'menu' | 'battle' | 'tension';

export interface TrackGen {
  readonly name: TrackName;
  readonly bpm: number;
  readonly stepsPerBeat: number;
  readonly drone: DroneName | null;
  readonly droneGain: number;
  /** overall track level (balances calm vs driving tracks) */
  readonly level: number;
  /** called once per grid step; t = step start time (s), sd = step duration (s) */
  step(o: MusicOut, s: number, t: number, sd: number): void;
}

/** Mix levels shared by the Web Audio engine and the offline check. */
export const MIX: {
  pluck: number;
  drum: Readonly<Record<DrumName, number>>;
  gong: number;
  flute: number;
  track: number;
} = {
  pluck: 0.55,
  drum: { taikoBig: 0.95, taikoLo: 0.75, buk: 0.55, ka: 0.32, wbHi: 0.22, wbLo: 0.28, kkwaeng: 0.25 },
  gong: 0.55,
  flute: 0.16,
  track: 1,
};

const DRUM_CHARS: Readonly<Record<string, DrumName>> = {
  B: 'taikoBig',
  L: 'taikoLo',
  H: 'buk',
  k: 'ka',
  w: 'wbHi',
  o: 'wbLo',
  x: 'kkwaeng',
};

type Ev = (o: MusicOut, t: number, sd: number) => void;

/** Events keyed by absolute step index, emitted when the scheduler reaches that step. */
class StepQueue {
  private readonly m = new Map<number, Ev[]>();

  at(step: number, ev: Ev): void {
    const l = this.m.get(step);
    if (l) l.push(ev);
    else this.m.set(step, [ev]);
  }

  run(step: number, o: MusicOut, t: number, sd: number): void {
    const l = this.m.get(step);
    if (!l) return;
    this.m.delete(step);
    for (const ev of l) ev(o, t, sd);
  }
}

const deg = (idx: number) => ((idx % 5) + 5) % 5;
const ci = (idx: number, lo = 0, hi = NOTE_COUNT - 1) => clamp(Math.round(idx), lo, hi);

/** Nearest scale index on a stable degree (D or A). */
function stable(idx: number): number {
  for (let d = 0; d < 3; d++) {
    const a = deg(idx - d);
    if (a === 0 || a === 3) return ci(idx - d);
    const b = deg(idx + d);
    if (b === 0 || b === 3) return ci(idx + d);
  }
  return ci(idx);
}

function playPattern(o: MusicOut, r: Rng, pat: string, p: number, t: number, accent: (ch: string, p: number) => number): void {
  const ch = pat.charAt(p);
  if (ch === '.' || ch === '') return;
  const d = DRUM_CHARS[ch];
  if (!d) return;
  o.drum(t, d, accent(ch, p) * rr(r, 0.9, 1.05));
}

// ---------------------------------------------------------------------------------------------
// menu: ~70 BPM, 8th-note grid. Drone, sparse zither phrases, occasional flute and gong swell.

function menuTrack(r: Rng): TrackGen {
  const q = new StepQueue();
  const SPB = 8;
  let last = 12;
  let lastFluteBar = -8;

  function pluckPhrase(s0: number, span: number): void {
    const n = 3 + Math.floor(r() * 5);
    let st = s0 + pick(r, [0, 0, 1, 2]);
    let idx = ci(last + pick(r, [-2, -1, 0, 1, 2]), 10, 17);
    const dir = r() < 0.5 ? 1 : -1;
    const pan = rr(r, -0.5, 0.5);
    for (let k = 0; k < n && st < s0 + span - 1; k++) {
      const isLast = k === n - 1 || st >= s0 + span - 4;
      const len = pick(r, [1, 1, 2, 2, 2, 3, 4]);
      const note = isLast ? stable(idx) : idx;
      const vel = (k === 0 ? 0.62 : 0.42) + 0.22 * r();
      const bend: Bend | undefined = isLast
        ? r() < 0.45
          ? 'vib'
          : r() < 0.2
            ? 'fall'
            : undefined
        : len >= 3 && r() < 0.25
          ? 'up'
          : undefined;
      const hum = rr(r, 0, 0.012);
      q.at(st, (o, t) => o.pluck(t + hum, note, vel, { bend, pan }));
      if (r() < 0.12 && note >= 10) q.at(st, (o, t) => o.pluck(t + hum + 0.02, note - 5, vel * 0.5, { pan: -pan }));
      last = note;
      if (isLast) {
        st += len;
        break;
      }
      st += len;
      idx = ci(idx + (r() < 0.7 ? dir : -dir) * pick(r, [1, 1, 1, 2]), 9, 18);
    }
    if (r() < 0.3) {
      const e = ci(last + 5);
      q.at(st + 1, (o, t) => o.pluck(t, e, 0.22, { pan: -pan }));
    }
  }

  function flutePhrase(s0: number): void {
    const n = 3 + Math.floor(r() * 3);
    let idx = pick(r, [11, 12, 13, 14]);
    const notes: { idx: number; steps: number }[] = [];
    for (let k = 0; k < n; k++) {
      const isLast = k === n - 1;
      notes.push({ idx: isLast ? stable(idx) : idx, steps: isLast ? pick(r, [4, 6]) : pick(r, [1, 2, 2, 3, 4]) });
      idx = ci(idx + pick(r, [-2, -1, 1, 1, 2]), 10, 17);
    }
    const vel = 0.5 + 0.2 * r();
    q.at(s0 + pick(r, [0, 1]), (o, t, sd) => o.flute(t, notes.map((x) => ({ idx: x.idx, dur: x.steps * sd })), vel));
  }

  function rolled(s: number, vel: number): void {
    const chord = pick(r, [[5, 8, 10], [5, 8, 10, 13], [3, 5, 8], [4, 8, 9]]);
    q.at(s, (o, t) => chord.forEach((idx, k) => o.pluck(t + k * 0.045, idx, vel - k * 0.05, { pan: -0.3 + 0.2 * k })));
  }

  return {
    name: 'menu',
    bpm: 70,
    stepsPerBeat: 2,
    drone: 'menu',
    droneGain: 0.3,
    level: 2.1,
    step(o, s, t, sd) {
      q.run(s, o, t, sd);
      if (s % SPB !== 0) return;
      const bar = s / SPB;
      if (bar === 0) {
        o.tone(t, 3200);
        rolled(s, 0.5);
      }
      if (bar % 16 === 0) o.gong(t + (bar === 0 ? sd * 2 : 0), 'swell', bar === 0 ? 0.3 : 0.42);
      if (bar % 8 === 4) o.drum(t, 'taikoLo', 0.3);
      if (bar % 4 === 2 && r() < 0.5) {
        const lo = pick(r, [0, 3, 5]);
        q.at(s + pick(r, [0, 4]), (o2, t2) => o2.pluck(t2, lo, 0.32, { pan: 0 }));
      }
      if (bar % 2 === 0 && bar > 0) {
        const x = r();
        if (x < 0.25 && bar - lastFluteBar >= 4) {
          flutePhrase(s);
          lastFluteBar = bar;
        } else if (x < 0.8) pluckPhrase(s, 16);
        else if (x < 0.92) rolled(s, 0.45);
        // else: breathe (rest)
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// battle: ~126 BPM, 16th grid. Taiko groove, zither ostinato over a pentatonic progression,
// bass strings, lead phrases. Sections: intro, A (8 bars), B (8), break (4); motif mutates
// every 4 bars and is regenerated across sections.

const DRUMS_A = ['L.k.H.k.L.kLH.k.', 'L..kH.kkL.L.H.kk', 'L.kLH.k.LLk.H.kH', 'L..kH..kL.k.H.kk'];
const DRUMS_B = ['L.kHL.kHL.kHLHkH', 'LkHkLkHkLLHkLkHk', 'L.HkL.HkLLHkL.Hk', 'L.kHLkH.L.kHLLHk'];
const DRUMS_BREAK = ['L.......H.......', 'k..k..k.k..k..k.', 'L.....k.L.....k.'];
const FILLS = ['L.H.L.HHLHLHHHHH', 'HHHkHHHkLLLLHHHH', 'L..L..L.HHHHLLLL', 'LkLkHkHkLLHHLLHH'];
const BASS = ['R.....R...R.....', 'R..R..R...R..R..', 'R.......R.R.....', 'R.....F...R...F.'];
// chord roots in scale steps relative to D: 0 = D, -1 = C, -2 = A (below), 1 = F, 2 = G
const PROGS: readonly (readonly number[])[] = [
  [0, 0, -1, -2],
  [0, 1, 2, -2],
  [0, -1, 1, -2],
  [0, -2, -1, 0],
  [0, 2, 1, -1],
];

function battleTrack(r: Rng): TrackGen {
  const q = new StepQueue();
  const SPB = 16;
  type Sec = 'intro' | 'A' | 'B' | 'break';
  let sec: Sec = 'intro';
  let secBar = 0;
  let secLen = 2;
  let cycle = 0;
  let prog = pick(r, PROGS);
  let drums = 'L...L...L...L.k.';
  let bass = pick(r, BASS);
  let fill: string | null = null;
  let fillHalf = false;

  function genMotif(): (number | null)[] {
    const a = [0, pick(r, [1, 2]), pick(r, [2, 3, 4]), pick(r, [1, 2, 3])];
    const b = a.map((x, i) => (i === 0 ? x : x + pick(r, [0, 0, 1, -1])));
    const shift = [0, pick(r, [1, 2, -1]), 0, pick(r, [2, 3, 1])];
    const dens = rr(r, 0.65, 0.95);
    const m: (number | null)[] = [];
    for (let k = 0; k < 4; k++) {
      const cell = k % 2 === 0 ? a : b;
      for (let j = 0; j < 4; j++) m.push(j === 0 || r() < dens ? cell[j] + shift[k] : null);
    }
    return m;
  }

  function mutate(m: (number | null)[], k: number): (number | null)[] {
    const out = m.slice();
    for (let i = 0; i < k; i++) {
      const p = 1 + Math.floor(r() * 15);
      if (p % 4 === 0) continue;
      const cur = out[p];
      out[p] = cur === null ? pick(r, [0, 1, 2, 3]) : r() < 0.25 ? null : cur + pick(r, [-1, 1]);
    }
    return out;
  }

  /** B-section variant: octave leaps on the third 16th of each beat. */
  function lift(m: (number | null)[]): (number | null)[] {
    return m.map((x, i) => (x === null ? (i % 4 === 3 ? 4 : null) : i % 4 === 2 ? x + 5 : x));
  }

  let motifA = genMotif();
  let motif = motifA.slice();

  function nextSection(o: MusicOut, t: number): void {
    const prev = sec;
    if (sec === 'intro') sec = 'A';
    else if (sec === 'A') sec = cycle > 0 && r() < 0.25 ? 'break' : 'B';
    else if (sec === 'B') {
      sec = r() < 0.6 ? 'A' : 'break';
      cycle++;
    } else sec = r() < 0.6 ? 'B' : 'A';
    secBar = 0;
    secLen = sec === 'break' ? 4 : 8;
    if (prev === 'intro' || r() < 0.5) prog = pick(r, PROGS);
    bass = pick(r, BASS);
    if (sec === 'A') {
      motifA = prev === 'break' || prev === 'intro' || r() < 0.5 ? genMotif() : mutate(motifA, 3);
      motif = motifA.slice();
      drums = pick(r, DRUMS_A);
      o.tone(t, 3000);
      o.drum(t, 'kkwaeng', 0.55);
    } else if (sec === 'B') {
      motif = lift(motifA);
      drums = pick(r, DRUMS_B);
      o.tone(t, 6500);
      o.gong(t, 'hit', 0.4);
    } else {
      drums = pick(r, DRUMS_BREAK);
      o.tone(t, 1400);
    }
  }

  function leadPhrase(s0: number, root: number): void {
    const useFlute = r() < 0.45;
    let idx = ci(15 + root + pick(r, [0, 1, 2]), 13, 19);
    const notes: { idx: number; steps: number }[] = [];
    const start = pick(r, [0, 2, 4]);
    let used = start;
    while (used < 28) {
      const steps = Math.min(pick(r, [2, 2, 4, 4, 6, 8]), 32 - used);
      notes.push({ idx, steps });
      used += steps;
      idx = ci(idx + pick(r, [-2, -1, -1, 1, 1, 2]), 13, 19);
    }
    if (!notes.length) return;
    notes[notes.length - 1].idx = stable(notes[notes.length - 1].idx);
    if (useFlute) {
      q.at(s0 + start, (o, t, sd) => o.flute(t, notes.map((n) => ({ idx: n.idx, dur: n.steps * sd })), 0.55));
    } else {
      let st = s0 + start;
      for (const n of notes) {
        const vel = 0.5 + 0.15 * r();
        const bend: Bend | undefined = n.steps >= 6 ? 'vib' : undefined;
        q.at(st, (o, t) => o.pluck(t, n.idx, vel, { bend, pan: 0.35 }));
        st += n.steps;
      }
    }
  }

  return {
    name: 'battle',
    bpm: 126,
    stepsPerBeat: 4,
    drone: 'menu',
    droneGain: 0.1,
    level: 0.9,
    step(o, s, t, sd) {
      q.run(s, o, t, sd);
      const p = s % SPB;
      if (p === 0) {
        if (s === 0) {
          o.gong(t, 'hit', 0.5);
          o.tone(t, 2000);
        } else {
          secBar++;
          if (secBar >= secLen) nextSection(o, t);
        }
        if (sec !== 'intro' && secBar > 0 && secBar % 4 === 0) motif = mutate(motif, 2);
        fill = secBar === secLen - 1 ? pick(r, FILLS) : null;
        fillHalf = fill !== null && r() < 0.5;
        if (sec === 'B' && secBar % 2 === 0) leadPhrase(s, prog[secBar % 4]);
      }
      const root = prog[secBar % 4];
      const inFill = fill !== null && (!fillHalf || p >= 8);
      const pat = inFill && fill ? fill : drums;
      playPattern(o, r, pat, p, t, (_ch, pp) => {
        let v = pp % 4 === 0 ? 1 : pp % 2 === 0 ? 0.8 : 0.62;
        if (inFill) v *= 0.55 + (0.45 * pp) / 15;
        return v;
      });
      if (sec === 'B' && p % 4 === 2) o.drum(t, 'wbHi', 0.35);
      if (sec === 'intro') return;
      if (sec !== 'break' || (secBar >= 2 && p % 2 === 0)) {
        const m = motif[p];
        if (m !== null && m !== undefined) {
          const v = (p % 4 === 0 ? 0.8 : 0.58) * rr(r, 0.88, 1.08) * (sec === 'break' ? 0.6 : 1);
          o.pluck(t, ci(10 + root + m, 5, 19), v, { len: sd * 1.8, pan: p % 8 < 4 ? -0.35 : 0.35 });
        }
      }
      if (sec !== 'break' || secBar >= 2) {
        const b = bass.charAt(p);
        if (b === 'R' || b === 'F') {
          const bi = ci(deg(root) + (b === 'F' ? 3 : 0), 0, 9);
          o.pluck(t, bi, 0.8 * rr(r, 0.9, 1.05), { len: sd * 3, pan: 0 });
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// tension: ~84 BPM, 8th grid. Dark drone, sparse heavy odaiko, low bent strings, tremolo
// builds, a ticking woodblock clock and the odd low flute.

const T_DRUMS = ['B.......', 'B.....L.', 'B..B....', 'B.....BL', 'B...L...', 'B.B.....'];
const T_BUILD = ['B...LLLL', 'B..LL.LL', 'L.L.LLLL'];

function tensionTrack(r: Rng): TrackGen {
  const q = new StepQueue();
  const SPB = 8;
  let pat = T_DRUMS[0];
  let clock = 0;

  return {
    name: 'tension',
    bpm: 84,
    stepsPerBeat: 2,
    drone: 'tension',
    droneGain: 0.42,
    level: 1,
    step(o, s, t, sd) {
      q.run(s, o, t, sd);
      const p = s % SPB;
      if (p === 0) {
        const bar = s / SPB;
        if (bar === 0) o.tone(t, 1800);
        if (bar % 8 === 0) o.gong(t, 'swell', 0.32);
        if (bar % 4 === 3) pat = pick(r, T_BUILD);
        else if (bar % 4 === 0 || r() < 0.3) pat = pick(r, T_DRUMS);
        if (clock > 0) clock--;
        else if (bar % 4 === 0 && r() < 0.3) clock = 4;
        if (bar % 2 === 1 && bar % 16 !== 13) {
          const idx = pick(r, [0, 3, 4, 5, 8]);
          const st = s + pick(r, [0, 2, 3, 4]);
          const bend = pick(r, ['fall', 'up', 'vib', undefined] as const);
          const vel = 0.5 + 0.15 * r();
          const pan = rr(r, -0.3, 0.3);
          q.at(st, (o2, t2) => o2.pluck(t2, idx, vel, { bend, pan }));
        }
        if (bar % 16 === 12) {
          // two-bar gayageum-style tremolo crescendo, resolved with a falling bend
          const idx = pick(r, [5, 8]);
          for (let k = 0; k < 16; k++) {
            const v = 0.15 + (0.45 * k) / 15;
            q.at(s + k, (o2, t2, sd2) => {
              o2.pluck(t2, idx, v, { len: sd2 * 0.45 });
              o2.pluck(t2 + sd2 / 2, idx, v + 0.02, { len: sd2 * 0.45 });
            });
          }
          q.at(s + 16, (o2, t2) => o2.pluck(t2, idx, 0.7, { bend: 'fall' }));
        }
        if (bar % 16 === 6 && r() < 0.7) {
          const n = 3 + Math.floor(r() * 2);
          let idx = pick(r, [8, 9, 10]);
          const notes: { idx: number; steps: number }[] = [];
          for (let k = 0; k < n; k++) {
            notes.push({ idx, steps: pick(r, [4, 6, 8]) });
            idx = ci(idx + pick(r, [-1, 1, 1, -2]), 6, 12);
          }
          q.at(s, (o2, t2, sd2) => o2.flute(t2, notes.map((x) => ({ idx: x.idx, dur: x.steps * sd2 })), 0.45));
        }
      }
      const build = pat.indexOf('LLL') >= 0;
      playPattern(o, r, pat, p, t, (ch, pp) => (ch === 'B' ? 0.95 : build ? 0.45 + (0.4 * pp) / 7 : 0.7));
      if (clock > 0) o.drum(t, 'wbLo', p % 2 === 0 ? 0.3 : 0.18);
    },
  };
}

export function createTrack(name: TrackName, r: Rng): TrackGen {
  if (name === 'battle') return battleTrack(r);
  if (name === 'tension') return tensionTrack(r);
  return menuTrack(r);
}
