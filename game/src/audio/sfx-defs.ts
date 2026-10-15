/*
 * INKFIST procedural audio: SFX recipes. Pure (no DOM), so tools/audio-check.mjs can render and
 * measure every sound in Node. Each recipe layers transient + body + tail and optionally renders a
 * separate "heavy" layer that the engine fades in with PlayOpts.intensity.
 */

import type { SfxId } from './audio';
import {
  addBell,
  addFM,
  addGong,
  addGrains,
  addKick,
  addNoise,
  addPartials,
  addPluck,
  addReversed,
  addTaiko,
  addTone,
  addWoodblock,
  addKa,
  alloc,
  dbToGain,
  dcBlock,
  fastTanh,
  hashString,
  loudnessDb,
  midiToHz,
  mulberry32,
  peakAbs,
  renderRate,
  rr,
  scale,
  trimTail,
} from './dsp';
import type { Partial, Rng } from './dsp';

export interface SfxCtx {
  sr: number;
  r: Rng;
  main: Float32Array;
  heavy: Float32Array | null;
  v: number;
}

export interface SfxDef {
  /** number of pre-rendered variations (picked at random, never the same twice in a row) */
  variants: number;
  /** render length (s); silence is trimmed afterwards */
  dur: number;
  /** if set, a heavy layer of this length is rendered and faded in with intensity */
  heavyDur?: number;
  /** loudness target: max 50 ms RMS in dBFS (see loudnessDb) */
  db: number;
  /** ± random detune per play, in cents */
  jitter: number;
  /** responds to PlayOpts.intensity (loudness, brightness, length, heavy layer) */
  dyn: boolean;
  /** low-pass cutoff at intensity 0 (Hz) for dyn sounds */
  brightMin: number;
  /** reverb send level */
  reverb: number;
  /** follows setSlowmo (presentation / UI sounds do not) */
  slowmo: boolean;
  /** render at sampleRate / div (see renderRate) for long, dark sounds to save init time */
  div: 1 | 2;
  /** soft-knee saturate peaks (up to 6 dB) instead of only turning the sound down: punch + crunch */
  sat: boolean;
  render(c: SfxCtx): void;
}

export interface SfxRender {
  main: Float32Array;
  heavy: Float32Array | null;
  /** sample rate the buffers were rendered at */
  rate: number;
}

type DefIn = Partial0<SfxDef, 'variants' | 'jitter' | 'dyn' | 'brightMin' | 'reverb' | 'slowmo' | 'div' | 'sat'>;
type Partial0<T, K extends keyof T> = Omit<T, K> & { [P in K]?: T[P] };

function def(d: DefIn): SfxDef {
  return {
    ...d,
    variants: d.variants ?? 3,
    jitter: d.jitter ?? 40,
    dyn: d.dyn ?? false,
    brightMin: d.brightMin ?? 2500,
    reverb: d.reverb ?? 0,
    slowmo: d.slowmo ?? true,
    div: d.div ?? 1,
    sat: d.sat ?? false,
  };
}

const hz = midiToHz;
// D minor pentatonic note helpers (MIDI)
const D3 = 50, A3 = 57, D4 = 62, F4 = 65, G4 = 67, A4 = 69, C5 = 72, D5 = 74, A5 = 81, C6 = 84, D6 = 86, A6 = 93;
const D2 = 38, A2 = 45;

function crack(c: SfxCtx, buf: Float32Array, t0: number, fc: number, d: number, gain: number, drive = 3): void {
  addNoise(buf, c.sr, c.r, { t0, env: { a: 0.0002, d }, mode: 'hp', fc, gain, drive });
}

export const SFX_DEFS: Record<SfxId, SfxDef> = {
  // ------------------------------------------------------------------ attack swings
  whoosh_light: def({
    variants: 4,
    dur: 0.36,
    db: -21,
    jitter: 80,
    dyn: true,
    brightMin: 4000,
    render(c) {
      const { sr, r, main } = c;
      const d = rr(r, 0.2, 0.28);
      const pk = d * rr(r, 0.3, 0.45);
      const fp = rr(r, 1900, 2900);
      addNoise(main, sr, r, {
        env: [[0, 0], [pk, 1], [d, 0]],
        mode: 'bp',
        fc: [[0, fp * 0.35], [pk, fp], [d, fp * 0.45]],
        q: 1.1,
        gain: 1,
        flutter: 0.35,
        flutterRate: rr(r, 22, 34),
      });
      addNoise(main, sr, r, { env: [[0, 0], [pk * 0.9, 1], [d * 0.8, 0]], mode: 'hp', fc: 5000, gain: 0.25 });
    },
  }),
  whoosh_heavy: def({
    div: 2,
    variants: 3,
    dur: 0.6,
    heavyDur: 0.75,
    db: -17,
    jitter: 70,
    dyn: true,
    brightMin: 3000,
    render(c) {
      const { sr, r, main } = c;
      const d = rr(r, 0.4, 0.52);
      const pk = d * rr(r, 0.38, 0.5);
      const env: [number, number][] = [[0, 0], [pk, 1], [d, 0]];
      addNoise(main, sr, r, { env, mode: 'bp', fc: [[0, 280], [pk, rr(r, 1100, 1500)], [d, 380]], q: 0.8, gain: 1, flutter: 0.5, flutterRate: rr(r, 14, 20) });
      addNoise(main, sr, r, { env: [[0, 0], [pk * 0.95, 1], [d * 0.9, 0]], mode: 'lp', fc: 320, poles: 2, gain: 0.7 });
      addNoise(main, sr, r, { env, mode: 'bp', fc: [[0, 420], [pk, 760], [d, 360]], q: 5, gain: 0.3 });
      if (c.heavy) {
        addNoise(c.heavy, sr, r, { env: [[0, 0], [pk, 1], [d * 1.3, 0]], mode: 'lp', fc: 180, brown: true, gain: 1 });
        addNoise(c.heavy, sr, r, { env: [[0, 0], [pk * 1.1, 1], [d * 1.4, 0]], mode: 'bp', fc: [[0, 300], [pk, 700], [d * 1.4, 250]], q: 0.7, gain: 0.5, flutter: 0.6, flutterRate: 11 });
      }
    },
  }),

  // ------------------------------------------------------------------ impacts
  hit_light: def({
    variants: 4,
    dur: 0.4,
    heavyDur: 0.5,
    db: -13,
    jitter: 60,
    dyn: true,
    reverb: 0.05,
    render(c) {
      const { sr, r, main } = c;
      const j = rr(r, 0.92, 1.08);
      // presence first (reads on laptop speakers), then the body thump
      crack(c, main, 0, 2600 * j, 0.006, 1.3, 3);
      addNoise(main, sr, r, { env: { a: 0.0005, d: 0.018 }, mode: 'bp', fc: 1700 * j, q: 1.2, gain: 1 });
      addNoise(main, sr, r, { env: { a: 0.0006, d: 0.022 }, mode: 'bp', fc: 1150 * j, q: 0.9, gain: 0.8, drive: 1.5 });
      addKick(main, sr, { f0: 240 * j, f1: 95 * j, pd: 0.014, d: 0.045, drive: 3.5, gain: 0.65 });
      addNoise(main, sr, r, { env: { a: 0.001, d: 0.03 }, mode: 'bp', fc: 850 * j, q: 0.8, gain: 0.7 });
      addNoise(main, sr, r, { env: { a: 0.002, d: 0.06 }, mode: 'lp', fc: 420, poles: 2, gain: 0.2 });
      if (c.heavy) {
        addKick(c.heavy, sr, { f0: 140, f1: 48, pd: 0.03, d: 0.13, drive: 3, gain: 0.85 });
        addNoise(c.heavy, sr, r, { env: { a: 0.0005, d: 0.035 }, mode: 'bp', fc: 1300, q: 0.7, gain: 0.45, drive: 4 });
        addNoise(c.heavy, sr, r, { t0: 0.004, env: { a: 0.002, d: 0.12 }, mode: 'lp', fc: 260, poles: 2, gain: 0.35 });
      }
    },
  }),
  hit_heavy: def({
    sat: true,
    variants: 3,
    dur: 0.8,
    heavyDur: 1.1,
    db: -9,
    jitter: 50,
    dyn: true,
    reverb: 0.08,
    render(c) {
      const { sr, r, main } = c;
      const j = rr(r, 0.93, 1.07);
      crack(c, main, 0, 2200 * j, 0.012, 1.3, 3.5);
      const clicks = 2 + Math.floor(r() * 2);
      for (let k = 0; k < clicks; k++) {
        addNoise(main, sr, r, { t0: rr(r, 0.002, 0.013), env: { a: 0.0002, d: 0.0015 }, mode: 'bp', fc: rr(r, 2500, 4200), q: 3, gain: 0.6 });
      }
      addNoise(main, sr, r, { env: { a: 0.0006, d: 0.03 }, mode: 'bp', fc: 950 * j, q: 0.8, gain: 0.9, drive: 2 });
      addKick(main, sr, { f0: 190 * j, f1: 52 * j, pd: 0.02, d: 0.13, drive: 4, gain: 0.9 });
      addKick(main, sr, { f0: 75, f1: 38, pd: 0.04, d: 0.2, drive: 1.2, gain: 0.4 });
      addNoise(main, sr, r, { env: { a: 0.0008, d: 0.05 }, mode: 'bp', fc: 1100 * j, q: 0.7, gain: 0.8, drive: 5 });
      addNoise(main, sr, r, { env: { a: 0.003, d: 0.16 }, mode: 'lp', fc: 300, poles: 2, brown: true, gain: 0.3 });
      if (c.heavy) {
        addKick(c.heavy, sr, { f0: 62, f1: 29, pd: 0.05, d: 0.35, drive: 2, gain: 0.9 });
        addNoise(c.heavy, sr, r, { env: { a: 0.005, d: 0.3 }, mode: 'lp', fc: 200, brown: true, gain: 0.55 });
        crack(c, c.heavy, 0.011, 1800, 0.012, 0.5, 3);
      }
    },
  }),
  hit_focus: def({
    sat: true,
    div: 2,
    variants: 2,
    dur: 2.1,
    heavyDur: 1.9,
    db: -7,
    jitter: 30,
    dyn: true,
    reverb: 0.22,
    render(c) {
      const { sr, r, main } = c;
      const j = rr(r, 0.95, 1.05);
      crack(c, main, 0, 1500, 0.02, 1.3, 5);
      addNoise(main, sr, r, { env: { a: 0.0002, d: 0.004 }, mode: 'bp', fc: 5200, q: 2, gain: 0.7 });
      addNoise(main, sr, r, { env: { a: 0.0006, d: 0.04 }, mode: 'bp', fc: 900 * j, q: 0.8, gain: 0.9, drive: 3 });
      addKick(main, sr, { f0: 150 * j, f1: 34, pd: 0.045, d: 0.4, drive: 3.5, gain: 0.9 });
      addKick(main, sr, { f0: 58, f1: 27, pd: 0.08, d: 0.7, drive: 1.2, gain: 0.5 });
      addNoise(main, sr, r, { env: { a: 0.002, d: 0.28 }, mode: 'lp', fc: [[0, 4000], [0.35, 160]], poles: 2, gain: 0.55, drive: 2 });
      const f = 620 * j;
      addPartials(main, sr, {
        t0: 0.004,
        gain: 0.22,
        attack: 0.002,
        parts: [
          { f, a: 1, d: 0.9 },
          { f: f * 1.006, a: 0.7, d: 1.1 },
          { f: f * 2.32, a: 0.5, d: 0.6 },
          { f: f * 2.335, a: 0.35, d: 0.5 },
          { f: f * 4.25, a: 0.3, d: 0.35 },
          { f: f * 6.63, a: 0.15, d: 0.25 },
        ],
      });
      addNoise(main, sr, r, { env: { a: 0.01, d: 0.35 }, mode: 'hp', fc: 3000, gain: 0.12 });
      if (c.heavy) {
        addNoise(c.heavy, sr, r, { env: { a: 0.01, d: 0.8 }, mode: 'lp', fc: 110, brown: true, poles: 2, gain: 0.7 });
        addKick(c.heavy, sr, { f0: 46, f1: 24, pd: 0.1, d: 1.0, drive: 1.5, gain: 0.7 });
      }
    },
  }),
  block: def({
    variants: 3,
    dur: 0.45,
    heavyDur: 0.5,
    db: -14,
    jitter: 60,
    dyn: true,
    brightMin: 1800,
    reverb: 0.05,
    render(c) {
      const { sr, r, main } = c;
      const j = rr(r, 0.92, 1.08);
      addKick(main, sr, { f0: 270 * j, f1: 125 * j, pd: 0.01, d: 0.045, drive: 1.6, gain: 0.9 });
      addPartials(main, sr, {
        gain: 0.45,
        attack: 0.0008,
        parts: [
          { f: 360 * j, a: 1, d: 0.045 },
          { f: 870 * j, a: 0.45, d: 0.03 },
          { f: 1580 * j, a: 0.2, d: 0.018 },
        ],
      });
      addNoise(main, sr, r, { env: { a: 0.0008, d: 0.028 }, mode: 'bp', fc: 620 * j, q: 0.9, gain: 0.5 });
      addNoise(main, sr, r, { env: { a: 0.002, d: 0.06 }, mode: 'lp', fc: 260, poles: 2, gain: 0.35 });
      addNoise(main, sr, r, { env: { a: 0.0002, d: 0.0015 }, mode: 'hp', fc: 3000, gain: 0.15 });
      if (c.heavy) {
        addKick(c.heavy, sr, { f0: 160, f1: 72, pd: 0.02, d: 0.09, drive: 2, gain: 0.8 });
        addNoise(c.heavy, sr, r, { env: { a: 0.002, d: 0.08 }, mode: 'lp', fc: 500, brown: true, gain: 0.4 });
      }
    },
  }),
  deflect: def({
    variants: 3,
    dur: 1.5,
    db: -12,
    jitter: 50,
    dyn: true,
    brightMin: 7000,
    reverb: 0.35,
    render(c) {
      const { sr, r, main } = c;
      const j = rr(r, 0.96, 1.04);
      const f0 = 1880 * j;
      crack(c, main, 0, 5500, 0.0018, 0.7, 0);
      addFM(main, sr, { fc: 2350 * j, ratio: 1.414, i0: 6, id: 0.025, d: 0.09, gain: 0.45 });
      addPartials(main, sr, {
        gain: 0.35,
        attack: 0.0004,
        parts: [
          { f: f0, a: 1, d: 0.95 },
          { f: f0 + rr(r, 1.8, 3), a: 0.7, d: 1.05 },
          { f: f0 * 2.756, a: 0.55, d: 0.55 },
          { f: f0 * 2.756 + rr(r, 3, 5), a: 0.35, d: 0.5 },
          { f: f0 * 3.9, a: 0.2, d: 0.7 },
          { f: f0 * 5.404, a: 0.3, d: 0.3 },
          { f: f0 * 8.933, a: 0.15, d: 0.16 },
        ],
      });
      addNoise(main, sr, r, { env: { a: 0.001, d: 0.2 }, mode: 'hp', fc: 7000, gain: 0.1, flutter: 0.6, flutterRate: 28 });
      addKick(main, sr, { f0: 420, f1: 210, pd: 0.006, d: 0.018, gain: 0.35 });
    },
  }),
  guard_crush: def({
    sat: true,
    variants: 2,
    dur: 1.4,
    heavyDur: 1.3,
    db: -9,
    jitter: 40,
    dyn: true,
    reverb: 0.15,
    render(c) {
      const { sr, r, main } = c;
      // the splintering crackle is the signature: keep it on top of the low hit
      crack(c, main, 0, 1800, 0.016, 1.3, 4.5);
      addGrains(main, sr, r, { t0: 0.002, t1: 0.22, count: 30, shape: 'decay', fLo: 1400, fHi: 5200, dLo: 0.003, dHi: 0.012, gain: 1.4, q: 2.5, drive: 2 });
      addKick(main, sr, { f0: 135, f1: 40, pd: 0.028, d: 0.26, drive: 3, gain: 0.75 });
      addNoise(main, sr, r, { t0: 0.003, env: { a: 0.004, d: 0.2 }, mode: 'hp', fc: [[0, 2500], [0.4, 5000]], gain: 0.6 });
      const glass: Partial[] = [];
      for (let k = 0; k < 5; k++) glass.push({ f: rr(r, 2800, 6500), a: rr(r, 0.2, 0.5), d: rr(r, 0.08, 0.25) });
      addPartials(main, sr, { t0: 0.006, parts: glass, gain: 0.4 });
      addPartials(main, sr, {
        t0: 0.01,
        gain: 0.2,
        parts: [
          { f: 880, a: 1, d: 0.3 },
          { f: 1320, a: 0.5, d: 0.2 },
        ],
        glide: 0.5,
        glideTau: 0.15,
      });
      if (c.heavy) {
        addKick(c.heavy, sr, { f0: 60, f1: 28, pd: 0.06, d: 0.45, drive: 1.5, gain: 0.8 });
        addNoise(c.heavy, sr, r, { env: { a: 0.01, d: 0.4 }, mode: 'lp', fc: 150, brown: true, gain: 0.5 });
      }
    },
  }),

  // ------------------------------------------------------------------ movement
  dash: def({
    div: 2,
    variants: 2,
    dur: 0.45,
    db: -20,
    jitter: 70,
    render(c) {
      const { sr, r, main } = c;
      const d = rr(r, 0.32, 0.4);
      const pk = rr(r, 0.08, 0.12);
      addNoise(main, sr, r, { env: [[0, 0], [pk, 1], [d, 0]], mode: 'bp', fc: [[0, 520], [pk, rr(r, 2000, 2600)], [d, 850]], q: 1, gain: 1, flutter: 0.45, flutterRate: 30 });
      addNoise(main, sr, r, { env: { a: 0.002, d: 0.04 }, mode: 'lp', fc: 1000, poles: 2, gain: 0.5 });
      addKick(main, sr, { f0: 170, f1: 80, pd: 0.01, d: 0.03, gain: 0.4 });
    },
  }),
  jump: def({
    div: 2,
    variants: 2,
    dur: 0.38,
    db: -22,
    jitter: 70,
    render(c) {
      const { sr, r, main } = c;
      addKick(main, sr, { f0: 150, f1: 68, pd: 0.012, d: 0.04, gain: 0.6 });
      addNoise(main, sr, r, { env: { a: 0.001, d: 0.03 }, mode: 'lp', fc: 1100, poles: 2, gain: 0.45 });
      const d = rr(r, 0.26, 0.32);
      addNoise(main, sr, r, { t0: 0.01, env: [[0, 0], [0.06, 1], [d, 0]], mode: 'bp', fc: [[0, 650], [0.12, 2600], [d, 3200]], q: 1.1, gain: 0.7, flutter: 0.35, flutterRate: 26 });
    },
  }),
  land: def({
    div: 2,
    variants: 2,
    dur: 0.4,
    heavyDur: 0.5,
    db: -19,
    jitter: 60,
    dyn: true,
    brightMin: 2000,
    render(c) {
      const { sr, r, main } = c;
      const j = rr(r, 0.92, 1.08);
      addKick(main, sr, { f0: 135 * j, f1: 54 * j, pd: 0.015, d: 0.07, drive: 2, gain: 1 });
      addNoise(main, sr, r, { env: { a: 0.003, d: 0.08 }, mode: 'lp', fc: 1600, poles: 2, gain: 0.6 });
      addNoise(main, sr, r, { env: { a: 0.001, d: 0.03 }, mode: 'bp', fc: 3200, q: 1, gain: 0.3 });
      addNoise(main, sr, r, { env: { a: 0.004, d: 0.05 }, mode: 'bp', fc: 700, q: 0.8, gain: 0.3 });
      if (c.heavy) {
        addKick(c.heavy, sr, { f0: 80, f1: 35, pd: 0.03, d: 0.15, drive: 1.5, gain: 0.8 });
        addNoise(c.heavy, sr, r, { t0: 0.01, env: { a: 0.01, d: 0.15 }, mode: 'lp', fc: 900, gain: 0.35 });
      }
    },
  }),
  slam: def({
    sat: true,
    div: 2,
    variants: 2,
    dur: 1.6,
    heavyDur: 1.6,
    db: -9,
    jitter: 40,
    dyn: true,
    reverb: 0.12,
    render(c) {
      const { sr, r, main } = c;
      addNoise(main, sr, r, { env: { a: 0.0003, d: 0.028 }, mode: 'bp', fc: 1500, q: 0.5, gain: 0.85, drive: 4 });
      addKick(main, sr, { f0: 115, f1: 34, pd: 0.035, d: 0.3, drive: 3, gain: 1 });
      addNoise(main, sr, r, { env: { a: 0.001, d: 0.07 }, mode: 'lp', fc: 2200, poles: 2, gain: 0.6, drive: 3 });
      addNoise(main, sr, r, { env: { a: 0.01, d: 0.45 }, mode: 'lp', fc: 140, poles: 2, brown: true, gain: 0.8 });
      addGrains(main, sr, r, { t0: 0.04, t1: 1.0, count: 16, shape: 'decay', fLo: 1800, fHi: 5000, dLo: 0.003, dHi: 0.014, gain: 0.35, fall: 0.35, q: 2 });
      if (c.heavy) {
        addKick(c.heavy, sr, { f0: 55, f1: 26, pd: 0.07, d: 0.55, drive: 1.5, gain: 0.85 });
        addNoise(c.heavy, sr, r, { env: { a: 0.02, d: 0.7 }, mode: 'lp', fc: 100, brown: true, gain: 0.6 });
      }
    },
  }),
  crater: def({
    sat: true,
    div: 2,
    variants: 2,
    dur: 3.0,
    heavyDur: 2.6,
    db: -7,
    jitter: 30,
    dyn: true,
    reverb: 0.15,
    render(c) {
      const { sr, r, main } = c;
      addNoise(main, sr, r, { env: { a: 0.0015, d: 0.14 }, mode: 'lp', fc: [[0, 9000], [0.3, 600]], poles: 2, gain: 1, drive: 4 });
      crack(c, main, 0, 2000, 0.02, 0.7, 5);
      addKick(main, sr, { f0: 95, f1: 26, pd: 0.06, d: 0.7, drive: 2.5, gain: 1 });
      addNoise(main, sr, r, { env: [[0, 0], [0.03, 1], [0.6, 0.6], [2.6, 0]], mode: 'lp', fc: 110, poles: 2, brown: true, gain: 0.9, flutter: 0.35, flutterRate: 4 });
      addGrains(main, sr, r, { t0: 0.08, t1: 2.4, count: 45, shape: 'decay', fLo: 2500, fHi: 6500, dLo: 0.002, dHi: 0.007, gain: 0.4, fall: 0.9, q: 2.5 });
      addGrains(main, sr, r, { t0: 0.1, t1: 1.8, count: 14, shape: 'decay', fLo: 500, fHi: 1400, dLo: 0.012, dHi: 0.03, gain: 0.5, fall: 0.7, q: 1.5, drive: 2 });
      if (c.heavy) {
        addKick(c.heavy, sr, { f0: 50, f1: 22, pd: 0.1, d: 1.1, drive: 1.5, gain: 0.8 });
        addNoise(c.heavy, sr, r, { env: { a: 0.05, d: 1.2 }, mode: 'lp', fc: 90, brown: true, gain: 0.6 });
      }
    },
  }),

  // ------------------------------------------------------------------ qi and techniques
  qi_charge: def({
    div: 2,
    variants: 2,
    dur: 1.0,
    db: -17,
    jitter: 15,
    reverb: 0.2,
    render(c) {
      const { sr, r, main } = c;
      const env: [number, number][] = [[0, 0], [0.15, 0.25], [0.78, 1], [0.9, 0]];
      addNoise(main, sr, r, { env, mode: 'bp', fc: [[0, 300], [0.8, 3200]], q: [[0, 0.9], [0.8, 4]], gain: 0.7, flutter: 0.25, flutterRate: 9 });
      addTone(main, sr, { f: [[0, 110], [0.8, 220]], harm: [1, 0.5, 0.33, 0.25, 0.2], env, gain: 0.35, trem: 0.4, tremRate: [[0, 6], [0.8, 22]] });
      addTone(main, sr, { f: [[0, 220.8], [0.8, 441.5]], harm: [1, 0.3], env, gain: 0.12, vib: 15, vibRate: 7 });
      addGrains(main, sr, r, { t0: 0.45, t1: 0.85, count: 14, shape: 'rise', fLo: 6000, fHi: 11000, dLo: 0.002, dHi: 0.006, gain: 0.2, q: 4 });
    },
  }),
  qi_ready: def({
    variants: 1,
    dur: 1.2,
    db: -17,
    jitter: 0,
    reverb: 0.3,
    slowmo: false,
    render(c) {
      const { sr, r, main } = c;
      const notes = [A5, C6, D6, A6];
      notes.forEach((m, k) => {
        const f = hz(m);
        const last = k === notes.length - 1;
        addPartials(main, sr, {
          t0: [0, 0.05, 0.1, 0.16][k],
          gain: last ? 0.6 : 0.5 - k * 0.04,
          attack: 0.0008,
          parts: [
            { f, a: 1, d: last ? 0.7 : 0.45 },
            { f: f * 2 + 1.3, a: 0.28, d: 0.25 },
            { f: f * 3.01, a: 0.12, d: 0.15 },
            { f: f * 4.17, a: 0.07, d: 0.09 },
          ],
        });
      });
      addGrains(main, sr, r, { t0: 0, t1: 0.35, count: 16, fLo: 7000, fHi: 12000, dLo: 0.0015, dHi: 0.004, gain: 0.18, q: 3 });
    },
  }),
  qi_burst: def({
    div: 2,
    variants: 2,
    dur: 1.6,
    heavyDur: 1.2,
    db: -10,
    jitter: 40,
    dyn: true,
    reverb: 0.15,
    render(c) {
      const { sr, r, main } = c;
      addNoise(main, sr, r, { env: { a: 0.004, d: 0.32 }, mode: 'lp', fc: [[0, 10000], [0.45, 600], [1.3, 220]], poles: 2, gain: 1, drive: 2 });
      addNoise(main, sr, r, { env: { a: 0.01, d: 0.45 }, mode: 'bp', fc: [[0, 900], [0.6, 420]], q: 0.9, gain: 0.6, flutter: 0.5, flutterRate: 12 });
      addKick(main, sr, { f0: 95, f1: 34, pd: 0.03, d: 0.24, drive: 2, gain: 0.8 });
      crack(c, main, 0, 2500, 0.008, 0.45, 2);
      addNoise(main, sr, r, { env: { a: 0.02, d: 0.25 }, mode: 'hp', fc: 3500, gain: 0.2 });
      if (c.heavy) {
        addNoise(c.heavy, sr, r, { env: { a: 0.01, d: 0.5 }, mode: 'lp', fc: 120, brown: true, gain: 0.6 });
        addKick(c.heavy, sr, { f0: 60, f1: 28, pd: 0.05, d: 0.35, drive: 1.5, gain: 0.6 });
      }
    },
  }),
  art_cast: def({
    div: 2,
    variants: 2,
    dur: 1.45,
    db: -14,
    jitter: 10,
    reverb: 0.3,
    render(c) {
      const { sr, r, main } = c;
      addNoise(main, sr, r, { env: [[0, 0], [0.75, 1], [1.3, 0]], mode: 'bp', fc: [[0, 380], [0.75, 2000], [1.3, 1100]], q: 1.2, gain: 0.55, flutter: 0.3, flutterRate: 11 });
      const swellEnv: [number, number][] = [[0, 0], [0.82, 1], [0.86, 0.9], [1.35, 0]];
      for (const m of [D4, A4, D5]) {
        const f = hz(m);
        addTone(main, sr, { f: [[0, f], [0.85, f * 1.017]], harm: [1, 0, 0.11, 0, 0.04], env: swellEnv, gain: 0.22, vib: 12, vibRate: 5.5 });
        addTone(main, sr, { f: [[0, f * 1.004], [0.85, f * 1.021]], harm: [1, 0, 0.11], env: swellEnv, gain: 0.14, vib: 10, vibRate: 4.7 });
      }
      addPartials(main, sr, {
        t0: 0.84,
        gain: 0.2,
        parts: [
          { f: 1760, a: 1, d: 0.35 },
          { f: 2640, a: 0.5, d: 0.2 },
        ],
      });
      addNoise(main, sr, r, { t0: 0.84, env: { a: 0.002, d: 0.05 }, mode: 'bp', fc: 1500, q: 1, gain: 0.25 });
    },
  }),
  projectile: def({
    variants: 2,
    dur: 1.0,
    db: -15,
    jitter: 40,
    dyn: true,
    brightMin: 3500,
    reverb: 0.1,
    render(c) {
      const { sr, r, main } = c;
      crack(c, main, 0, 3200, 0.004, 0.8, 3);
      addNoise(main, sr, r, { env: { a: 0.0003, d: 0.012 }, mode: 'bp', fc: 3500, q: 2, gain: 0.5 });
      const f0 = rr(r, 1500, 1900);
      addNoise(main, sr, r, {
        env: [[0, 0], [0.05, 1], [0.3, 0.75], [0.9, 0]],
        mode: 'bp',
        fc: [[0, f0], [0.85, f0 * 0.4]],
        q: 3,
        gain: 0.75,
        flutter: 0.35,
        flutterRate: 26,
      });
      addTone(main, sr, { f: [[0, 340], [0.9, 250]], harm: [1, 0.3], env: [[0, 0], [0.06, 1], [0.9, 0]], gain: 0.12, vib: 25, vibRate: 9 });
      addNoise(main, sr, r, { env: [[0, 0], [0.04, 1], [0.5, 0]], mode: 'hp', fc: 5000, gain: 0.12 });
    },
  }),

  // ------------------------------------------------------------------ cinematic
  secret_start: def({
    div: 2,
    variants: 1,
    dur: 4.4,
    db: -9,
    jitter: 0,
    reverb: 0.35,
    render(c) {
      const { sr, r, main } = c;
      addTaiko(main, sr, r, { f: 54, size: 1, gain: 1, rim: 0.2 });
      // reverse gong rising into a gong strike + second taiko at ~2.05 s
      const hit = 2.05;
      const rev = alloc(sr, 2.4);
      addGong(rev, sr, r, { f: 98, dur: 2.4, gain: 0.8, bright: 0.85, mallet: 0 });
      addReversed(main, rev, Math.round(hit * sr), 1.4);
      // rising air into the strike
      addNoise(main, sr, r, { t0: 0.5, env: [[0, 0], [1.5, 1], [1.55, 0]], mode: 'bp', fc: [[0, 250], [1.55, 3800]], q: 1.4, gain: 0.3 });
      addGong(main, sr, r, { t0: hit, f: 98, dur: 2.3, gain: 0.8, bright: 0.7 });
      addTaiko(main, sr, r, { t0: hit, f: 60, size: 0.9, gain: 0.85, rim: 0.3 });
      addTone(main, sr, { f: 73.4, harm: [1, 0.5, 0.25], env: [[0, 0], [2.0, 1], [4.3, 0]], gain: 0.15 });
    },
  }),
  secret_hit: def({
    sat: true,
    div: 2,
    variants: 1,
    dur: 3.4,
    db: -6,
    jitter: 0,
    reverb: 0.2,
    render(c) {
      const { sr, r, main } = c;
      addNoise(main, sr, r, { env: { a: 0.001, d: 0.12 }, mode: 'lp', fc: [[0, 12000], [0.25, 800]], poles: 2, gain: 1, drive: 6 });
      crack(c, main, 0, 1600, 0.025, 0.8, 5);
      addKick(main, sr, { f0: 125, f1: 24, pd: 0.07, d: 0.9, drive: 4, gain: 1 });
      addKick(main, sr, { f0: 46, f1: 21, pd: 0.12, d: 1.3, drive: 1.3, gain: 0.7 });
      addNoise(main, sr, r, { env: [[0, 0], [0.05, 1], [3.2, 0]], mode: 'lp', fc: 100, poles: 2, brown: true, gain: 0.7, flutter: 0.3, flutterRate: 3 });
      addGong(main, sr, r, { t0: 0.005, f: 62, dur: 3, gain: 0.3, bright: 0.3, mallet: 0 });
      addGrains(main, sr, r, { t0: 0.1, t1: 2.5, count: 35, shape: 'decay', fLo: 1500, fHi: 6000, dLo: 0.003, dHi: 0.015, gain: 0.4, fall: 0.9, q: 2 });
    },
  }),
  ko: def({
    div: 2,
    variants: 1,
    dur: 5.0,
    db: -8,
    jitter: 0,
    reverb: 0.4,
    slowmo: false,
    render(c) {
      const { sr, r, main } = c;
      addGong(main, sr, r, { f: 82, dur: 4.9, gain: 0.85, bright: 0.6, glide: 0.985 });
      addKick(main, sr, { f0: 85, f1: 20, pd: 0.35, d: 1.3, a: 0.006, drive: 2.5, gain: 0.9 });
      addNoise(main, sr, r, { env: { a: 0.006, d: 0.3 }, mode: 'lp', fc: 1300, poles: 2, gain: 0.45, drive: 2 });
      addNoise(main, sr, r, { env: { a: 0.03, d: 1.4 }, mode: 'lp', fc: 80, brown: true, gain: 0.5 });
    },
  }),
  round_call: def({
    div: 2,
    variants: 1,
    dur: 4.6,
    db: -12,
    jitter: 0,
    reverb: 0.4,
    slowmo: false,
    render(c) {
      const { sr, r, main } = c;
      addBell(main, sr, r, { f: 220, dur: 4.5, gain: 1, strike: 1 });
    },
  }),
  fight_call: def({
    variants: 1,
    dur: 1.4,
    db: -10,
    jitter: 0,
    reverb: 0.2,
    slowmo: false,
    render(c) {
      const { sr, r, main } = c;
      addTaiko(main, sr, r, { f: 78, size: 0.65, gain: 0.9, rim: 0.7 });
      addNoise(main, sr, r, { env: { a: 0.0003, d: 0.008 }, mode: 'bp', fc: 2200, q: 1.2, gain: 0.5 });
      const t2 = 0.19;
      addTaiko(main, sr, r, { t0: t2, f: 84, size: 0.8, gain: 1, rim: 0.9 });
      addNoise(main, sr, r, { t0: t2, env: { a: 0.0003, d: 0.01 }, mode: 'bp', fc: 2400, q: 1.2, gain: 0.55 });
      addNoise(main, sr, r, { t0: t2, env: { a: 0.001, d: 0.35 }, mode: 'hp', fc: 4000, gain: 0.2 });
    },
  }),

  // ------------------------------------------------------------------ UI
  ui_move: def({
    variants: 2,
    dur: 0.12,
    db: -26,
    jitter: 20,
    slowmo: false,
    render(c) {
      addWoodblock(c.main, c.sr, c.r, { f: rr(c.r, 1250, 1350), gain: 1, d: 0.03 });
    },
  }),
  ui_select: def({
    variants: 1,
    dur: 0.7,
    db: -20,
    jitter: 0,
    reverb: 0.15,
    slowmo: false,
    render(c) {
      const { sr, r, main } = c;
      addPluck(main, sr, r, { f: hz(D5), t60: 0.8, dur: 0.65, bright: 0.8, gain: 1 });
      addPluck(main, sr, r, { t0: 0.055, f: hz(A5), t60: 0.7, dur: 0.6, bright: 0.8, gain: 0.8 });
      addWoodblock(main, sr, r, { f: 950, gain: 0.3 });
    },
  }),
  ui_back: def({
    variants: 1,
    dur: 0.42,
    db: -22,
    jitter: 0,
    slowmo: false,
    render(c) {
      const { sr, r, main } = c;
      addPluck(main, sr, r, { f: hz(A4), t60: 0.4, dur: 0.4, bright: 0.5, gain: 1, bend: [[0, 0], [0.02, 0], [0.14, -2]] });
      addWoodblock(main, sr, r, { f: 620, gain: 0.35 });
    },
  }),
  countdown: def({
    variants: 1,
    dur: 0.16,
    db: -19,
    jitter: 0,
    slowmo: false,
    render(c) {
      addWoodblock(c.main, c.sr, c.r, { f: 1650 + c.v * 40, gain: 1, d: 0.035 });
      addKa(c.main, c.sr, c.r, { gain: 0.25, f: 2600 });
    },
  }),

  // ------------------------------------------------------------------ stingers
  victory: def({
    div: 2,
    variants: 1,
    dur: 3.4,
    db: -14,
    jitter: 0,
    reverb: 0.3,
    slowmo: false,
    render(c) {
      const { sr, r, main } = c;
      [D4, F4, G4, A4, C5, D5].forEach((m, k) => {
        addPluck(main, sr, r, { t0: k * 0.065, f: hz(m), t60: 1.2, dur: 1.2, bright: 0.75, gain: 0.55 + k * 0.04 });
      });
      addTaiko(main, sr, r, { f: 70, size: 0.6, gain: 0.5 });
      const t = 0.45;
      addTaiko(main, sr, r, { t0: t, f: 62, size: 0.85, gain: 0.9 });
      [D3, A3, D4, A4].forEach((m, k) => {
        addPluck(main, sr, r, { t0: t + k * 0.03, f: hz(m), t60: 2.5, dur: 2.8, bright: 0.7, gain: 0.6 });
      });
      addPluck(main, sr, r, { t0: t + 0.12, f: hz(D5), t60: 2.2, dur: 2.8, bright: 0.75, gain: 0.7, bend: [[0, 0], [0.5, 0], [0.7, 0.35], [0.9, -0.1], [1.1, 0.3], [1.3, 0]] });
      addGong(main, sr, r, { t0: t, f: 196, dur: 2.6, gain: 0.25, bright: 0.9 });
      addGrains(main, sr, r, { t0: t, t1: t + 0.6, count: 12, fLo: 6000, fHi: 11000, dLo: 0.002, dHi: 0.005, gain: 0.12 });
    },
  }),
  defeat: def({
    div: 2,
    variants: 1,
    dur: 3.8,
    db: -16,
    jitter: 0,
    reverb: 0.35,
    slowmo: false,
    render(c) {
      const { sr, r, main } = c;
      [A4, G4, F4].forEach((m, k) => {
        addPluck(main, sr, r, { t0: k * 0.38, f: hz(m), t60: 1.4, dur: 1.4, bright: 0.45, gain: 0.6 });
      });
      const t = 1.14;
      addPluck(main, sr, r, { t0: t, f: hz(D4), t60: 2.4, dur: 2.6, bright: 0.45, gain: 0.65, bend: [[0, 0], [0.4, 0], [1.6, -1]] });
      addPluck(main, sr, r, { t0: t, f: hz(D2), t60: 3, dur: 2.6, bright: 0.3, gain: 0.5 });
      addPluck(main, sr, r, { t0: t + 0.03, f: hz(A2), t60: 2.6, dur: 2.5, bright: 0.3, gain: 0.35 });
      addGong(main, sr, r, { t0: t, f: 73, dur: 2.6, gain: 0.25, bright: 0.3, mallet: 0.3 });
      addNoise(main, sr, r, { env: [[0, 0], [1, 0.5], [3.6, 0]], mode: 'bp', fc: 500, q: 0.8, gain: 0.12, flutter: 0.4, flutterRate: 3 });
    },
  }),
};

export const SFX_IDS = Object.keys(SFX_DEFS) as SfxId[];

/** In-place soft knee: linear below `knee`, tanh-shaped approach to `ceil` above it. */
function softLimit(buf: Float32Array, knee: number, ceil: number): void {
  const range = ceil - knee;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const a = x < 0 ? -x : x;
    if (a > knee) {
      const y = knee + range * fastTanh((a - knee) / range);
      buf[i] = x < 0 ? -y : y;
    }
  }
}

/** Heavy layers are shared: only the first HEAVY_VARIANTS variations render one. */
export const HEAVY_VARIANTS = 2;

/** Default intensity used when PlayOpts.intensity is omitted. */
export const DEFAULT_INTENSITY = 0.5;

/** Heavy-layer gain for an intensity in 0..1 (shared with the engine so calibration matches). */
export function heavyGainFor(intensity: number): number {
  const u = Math.max(0, (intensity - 0.2) / 0.8);
  return Math.pow(u, 1.3);
}

/** Render one variation of an SFX: deterministic for (id, variant, sampleRate). */
export function renderSfx(id: SfxId, ctxRate: number, variant: number): SfxRender {
  const d = SFX_DEFS[id];
  const sr = renderRate(ctxRate, d.div);
  const r = mulberry32(hashString(id) ^ Math.imul(variant + 1, 0x9e3779b1));
  const main = alloc(sr, d.dur);
  const heavy = d.heavyDur && variant < HEAVY_VARIANTS ? alloc(sr, d.heavyDur) : null;
  d.render({ sr, r, main, heavy, v: variant });
  dcBlock(main, sr);
  if (heavy) dcBlock(heavy, sr);
  // calibrate loudness on the main layer; the heavy layer (same gain) adds weight on top
  let g = dbToGain(d.db - loudnessDb(main, sr));
  const pk0 = peakAbs(main);
  const headroom = d.sat ? 2 : 1; // saturating sounds may push up to 6 dB into the soft knee
  if (pk0 * g > 0.97 * headroom) g = (0.97 * headroom) / pk0;
  scale(main, g);
  if (heavy) scale(heavy, g);
  if (d.sat) softLimit(main, 0.62, 0.97);
  return { main: trimTail(main, sr), heavy: heavy ? trimTail(heavy, sr) : null, rate: sr };
}
