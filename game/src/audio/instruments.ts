/*
 * INKFIST procedural audio: music instrument renderers. Pure (no DOM); every function returns a
 * mono Float32Array at the requested sample rate. Rendered lazily on the first music() call.
 */

import {
  addGong,
  addKa,
  addPartials,
  addNoise,
  addPluck,
  addTaiko,
  addWoodblock,
  alloc,
  clamp,
  dcBlock,
  hashString,
  midiToHz,
  mulberry32,
  peakAbs,
  renderDrone,
  scale,
  trimTail,
} from './dsp';
import type { Rng } from './dsp';

/** D minor pentatonic (D F G A C = yu mode of F gong), D2..D6: 21 strings. */
export const SCALE_MIDI: readonly number[] = (() => {
  const degs = [0, 3, 5, 7, 10];
  const out: number[] = [];
  for (let o = 0; o < 4; o++) for (const d of degs) out.push(38 + 12 * o + d);
  out.push(38 + 48);
  return out;
})();
export const NOTE_COUNT = SCALE_MIDI.length;

export type DrumName = 'taikoBig' | 'taikoLo' | 'buk' | 'ka' | 'wbHi' | 'wbLo' | 'kkwaeng';
export const DRUM_NAMES: readonly DrumName[] = ['taikoBig', 'taikoLo', 'buk', 'ka', 'wbHi', 'wbLo', 'kkwaeng'];
export type GongKind = 'hit' | 'swell';
export type DroneName = 'menu' | 'tension';

function seeded(key: string): Rng {
  return mulberry32(hashString('inkfist-music:' + key));
}

/** Plucked zither string for scale index 0..20. Low strings ring longer, high strings are brighter. */
export function renderPluckNote(sr: number, idx: number): Float32Array {
  const i = clamp(Math.round(idx), 0, NOTE_COUNT - 1);
  const u = i / (NOTE_COUNT - 1);
  const t60 = 3.4 - 2.2 * u;
  const dur = Math.min(t60 * 0.7 + 0.15, 2.6);
  const r = seeded('pluck' + i);
  const out = alloc(sr, dur);
  addPluck(out, sr, r, { f: midiToHz(SCALE_MIDI[i]), t60, dur, bright: 0.5 + 0.3 * u, pos: 0.11 + 0.05 * r(), gain: 1, nail: 0.25 });
  dcBlock(out, sr);
  const pk = peakAbs(out);
  if (pk > 0) scale(out, 0.5 / pk);
  return trimTail(out, sr, -60);
}

export function renderDrum(sr: number, name: DrumName): Float32Array {
  const r = seeded('drum-' + name);
  let out: Float32Array;
  switch (name) {
    case 'taikoBig':
      out = alloc(sr, 1.6);
      addTaiko(out, sr, r, { f: 52, size: 1, gain: 1, rim: 0.15 });
      break;
    case 'taikoLo':
      out = alloc(sr, 1.0);
      addTaiko(out, sr, r, { f: 68, size: 0.7, gain: 1, rim: 0.2 });
      break;
    case 'buk':
      out = alloc(sr, 0.6);
      addTaiko(out, sr, r, { f: 118, size: 0.35, gain: 1, rim: 0.35 });
      break;
    case 'ka':
      out = alloc(sr, 0.12);
      addKa(out, sr, r, { gain: 1, f: 1850 });
      break;
    case 'wbHi':
      out = alloc(sr, 0.15);
      addWoodblock(out, sr, r, { f: 1250, gain: 1, d: 0.04 });
      break;
    case 'wbLo':
      out = alloc(sr, 0.18);
      addWoodblock(out, sr, r, { f: 820, gain: 1, d: 0.05 });
      break;
    case 'kkwaeng': {
      // small bright gong (kkwaenggwari): clangy inharmonic partials, short-ish
      out = alloc(sr, 0.9);
      const f = 980;
      addPartials(out, sr, {
        gain: 1,
        attack: 0.0005,
        parts: [
          { f, a: 1, d: 0.35 },
          { f: f + 3.1, a: 0.6, d: 0.3 },
          { f: f * 1.51, a: 0.6, d: 0.22 },
          { f: f * 2.13, a: 0.5, d: 0.18 },
          { f: f * 2.77, a: 0.35, d: 0.14 },
          { f: f * 3.66, a: 0.25, d: 0.1 },
        ],
      });
      addNoise(out, sr, r, { env: { a: 0.0005, d: 0.05 }, mode: 'hp', fc: 4000, gain: 0.3 });
      break;
    }
  }
  dcBlock(out, sr);
  const pk = peakAbs(out);
  if (pk > 0) scale(out, 0.8 / pk);
  return trimTail(out, sr, -66);
}

export function renderGong(sr: number, kind: GongKind): Float32Array {
  const r = seeded('gong-' + kind);
  const out = alloc(sr, kind === 'hit' ? 4.2 : 5.2);
  if (kind === 'hit') addGong(out, sr, r, { f: 110, dur: 4.2, gain: 1, bright: 0.55 });
  else addGong(out, sr, r, { f: 98, dur: 5.2, gain: 1, bright: 0.5, swell: 2.2 });
  dcBlock(out, sr);
  const pk = peakAbs(out);
  if (pk > 0) scale(out, 0.6 / pk);
  return trimTail(out, sr, -60);
}

/** Seamless 8 s drone loop. */
export function renderDroneLoop(sr: number, name: DroneName): Float32Array {
  const r = seeded('drone-' + name);
  const out =
    name === 'menu'
      ? renderDrone(sr, r, {
          loop: 8,
          voices: [
            { f: 73.42, a: 0.5, harm: 6, beat: 0.25, am: 0.35 },
            { f: 110, a: 0.3, harm: 5, beat: 0.125, am: 0.4 },
            { f: 146.83, a: 0.15, harm: 4, beat: 0.375, am: 0.5 },
          ],
          noise: [{ fc: 600, q: 0.7, a: 0.03, mode: 'bp' }],
        })
      : renderDrone(sr, r, {
          loop: 8,
          voices: [
            { f: 73.42, a: 0.55, harm: 8, beat: 0.25, am: 0.3 },
            { f: 55, a: 0.35, harm: 6, beat: 0.125, am: 0.35 },
            { f: 77.78, a: 0.14, harm: 5, beat: 0.375, am: 1 },
          ],
          noise: [
            { fc: 200, q: 0.7, a: 0.05, mode: 'lp' },
            { fc: 1200, q: 4, a: 0.012, mode: 'bp' },
          ],
        });
  const pk = peakAbs(out);
  if (pk > 0) scale(out, 0.4 / pk);
  return out;
}

/** 1 s white-noise loop for the flute's breath (filtered live). */
export function renderBreathLoop(sr: number): Float32Array {
  const r = seeded('breath');
  const out = new Float32Array(Math.round(sr));
  for (let i = 0; i < out.length; i++) out[i] = (r() * 2 - 1) * 0.5;
  return out;
}
