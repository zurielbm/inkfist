// Numeric sanity checks for INKFIST's procedural audio (game/src/audio). No browser needed:
// imports the pure DSP / recipe / generator modules directly (Node >= 22.18 strips TS types).
//
//   node tools/audio-check.mjs                 # checks at 48 kHz and 44.1 kHz
//   node tools/audio-check.mjs --wav out/wav   # also write every SFX + 45 s music mixdowns as WAV
//
// Checks: public API never throws without Web Audio; no NaN/Inf, peak <= 1, audible level, no DC
// offset, faded tails, durations, loudness vs target; design intent (attack, spectral centroid,
// low end vs 1-6 kHz presence, qi_charge rising...); KS pluck tuning; seamless drone loops; music
// event sanity / variety / mix headroom; pre-render CPU cost. Exit code 1 on any hard failure.

import { registerHooks } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

// The game sources use extensionless relative imports (Vite/bundler style); map them to .ts.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (e) {
      if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(specifier + '.ts', context);
      throw e;
    }
  },
});

const base = new URL('../game/src/audio/', import.meta.url);
const dsp = await import(new URL('dsp.ts', base).href);
const sfx = await import(new URL('sfx-defs.ts', base).href);
const inst = await import(new URL('instruments.ts', base).href);
const gen = await import(new URL('music-gen.ts', base).href);

const args = process.argv.slice(2);
const wavDir = args.includes('--wav') ? resolve(args[args.indexOf('--wav') + 1] ?? 'audio-wav') : null;

let failures = 0;
let warnings = 0;
const fail = (msg) => {
  failures++;
  console.log('  FAIL ' + msg);
};
const warn = (msg) => {
  warnings++;
  console.log('  warn ' + msg);
};

// expected rendered durations (s) after tail trimming: [min, max]
const DUR = {
  whoosh_light: [0.15, 0.36], whoosh_heavy: [0.3, 0.75], hit_light: [0.08, 0.5], hit_heavy: [0.15, 1.1],
  hit_focus: [0.8, 2.1], block: [0.08, 0.5], deflect: [0.6, 1.5], guard_crush: [0.4, 1.4],
  dash: [0.2, 0.45], jump: [0.2, 0.38], land: [0.1, 0.5], slam: [0.6, 1.6], crater: [1.5, 3.0],
  qi_charge: [0.75, 1.0], qi_ready: [0.4, 1.2], qi_burst: [0.6, 1.6], art_cast: [1.0, 1.45],
  projectile: [0.6, 1.0], secret_start: [3.0, 4.4], secret_hit: [1.5, 3.4], ko: [2.5, 5.0],
  round_call: [2.0, 4.6], fight_call: [0.4, 1.4], ui_move: [0.03, 0.12], ui_select: [0.2, 0.7],
  ui_back: [0.15, 0.42], victory: [2.0, 3.4], defeat: [2.5, 3.8], countdown: [0.04, 0.16],
};

function stats(buf, sr) {
  let pk = 0;
  let sum = 0;
  let sq = 0;
  let bad = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    if (!Number.isFinite(x)) {
      bad++;
      continue;
    }
    const a = Math.abs(x);
    if (a > pk) pk = a;
    sum += x;
    sq += x * x;
  }
  const n = Math.max(1, buf.length);
  const tailN = Math.max(1, Math.round(0.001 * sr));
  let tail = 0;
  for (let i = Math.max(0, buf.length - tailN); i < buf.length; i++) tail = Math.max(tail, Math.abs(buf[i]));
  return { pk, mean: sum / n, rms: Math.sqrt(sq / n), bad, tail, dur: buf.length / sr, head: Math.abs(buf[0] ?? 0) };
}

function checkBuffer(label, buf, sr, { minPeak = 0.02, dur, loop = false } = {}) {
  const s = stats(buf, sr);
  if (s.bad) fail(`${label}: ${s.bad} non-finite samples`);
  if (s.pk > 1) fail(`${label}: peak ${s.pk.toFixed(3)} > 1`);
  if (s.pk < minPeak) fail(`${label}: nearly silent (peak ${s.pk.toFixed(4)})`);
  if (Math.abs(s.mean) > 0.004 && Math.abs(s.mean) > 0.02 * s.pk) fail(`${label}: DC offset ${s.mean.toExponential(2)}`);
  if (!loop && s.tail > 0.02 * s.pk + 1e-4) fail(`${label}: tail not faded (${s.tail.toFixed(4)})`);
  if (!loop && s.head > 0.1 * s.pk) warn(`${label}: abrupt first sample ${s.head.toFixed(3)}`);
  if (dur && (s.dur < dur[0] - 1e-3 || s.dur > dur[1] + 1e-3)) fail(`${label}: duration ${s.dur.toFixed(3)} s outside [${dur[0]}, ${dur[1]}]`);
  return s;
}

function writeWav(path, buf, sr) {
  const n = buf.length;
  const out = Buffer.alloc(44 + n * 2);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + n * 2, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sr, 24);
  out.writeUInt32LE(sr * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, buf[i])) * 32767), 44 + i * 2);
  writeFileSync(path, out);
}

/** Autocorrelation pitch estimate (Hz) over a window of the buffer. */
function estimatePitch(buf, sr, from, to, fMin, fMax) {
  const a = Math.round(from * sr);
  const b = Math.min(buf.length, Math.round(to * sr));
  const lagMin = Math.floor(sr / fMax);
  const lagMax = Math.ceil(sr / fMin);
  let best = 0;
  let bestLag = lagMin;
  const corr = new Float64Array(lagMax + 2);
  for (let lag = lagMin; lag <= lagMax + 1; lag++) {
    let c = 0;
    for (let i = a; i + lag < b; i++) c += buf[i] * buf[i + lag];
    corr[lag] = c;
    if (lag <= lagMax && c > best) {
      best = c;
      bestLag = lag;
    }
  }
  // parabolic interpolation
  const y0 = corr[bestLag - 1] ?? corr[bestLag];
  const y1 = corr[bestLag];
  const y2 = corr[bestLag + 1] ?? corr[bestLag];
  const den = y0 - 2 * y1 + y2;
  const shift = den !== 0 ? (0.5 * (y0 - y2)) / den : 0;
  return sr / (bestLag + shift);
}

// ------------------------------------------------------------------------------------------- SFX

function checkSfx(ctxSr, verbose) {
  console.log(`\n== SFX @ ${ctxSr} Hz  (* = rendered at half rate)`);
  let totalMs = 0;
  let worst = { id: '', ms: 0 };
  let samples = 0;
  if (verbose) console.log('  id              var  dur(s)  peak   loud(dB) target  heavy@1 peak   ms');
  for (const id of sfx.SFX_IDS) {
    const d = sfx.SFX_DEFS[id];
    for (let v = 0; v < d.variants; v++) {
      const t0 = performance.now();
      const out = sfx.renderSfx(id, ctxSr, v);
      const ms = performance.now() - t0;
      const sr = out.rate;
      totalMs += ms;
      if (ms > worst.ms) worst = { id: `${id}#${v}`, ms };
      samples += (out.main.length + (out.heavy?.length ?? 0)) * (ctxSr / sr);
      const s = checkBuffer(`${id}#${v}`, out.main, sr, { dur: DUR[id] });
      const loud = dsp.loudnessDb(out.main, sr);
      let heavyPk = '';
      if (out.heavy) {
        checkBuffer(`${id}#${v} heavy`, out.heavy, sr, { minPeak: 0.005 });
        // full-intensity mix as the engine plays it (main x1.25 + heavy x1)
        const n = Math.max(out.main.length, out.heavy.length);
        const mix = new Float32Array(n);
        for (let i = 0; i < out.main.length; i++) mix[i] += out.main[i] * 1.25;
        for (let i = 0; i < out.heavy.length; i++) mix[i] += out.heavy[i] * sfx.heavyGainFor(1);
        heavyPk = dsp.peakAbs(mix).toFixed(2);
      }
      if (loud < d.db - 8) warn(`${id}#${v}: loudness ${loud.toFixed(1)} dB is far below target ${d.db} (peak-limited)`);
      if (verbose) {
        console.log(
          `  ${(id + (sr !== ctxSr ? '*' : '')).padEnd(15)} ${String(v).padStart(3)}  ${s.dur.toFixed(2).padStart(6)}  ${s.pk.toFixed(2)}  ${loud.toFixed(1).padStart(7)}  ${String(d.db).padStart(6)}  ${heavyPk.padStart(12)}  ${ms.toFixed(1).padStart(5)}`,
        );
      }
      if (wavDir && verbose && v === 0) writeWav(join(wavDir, `sfx_${id}.wav`), out.main, sr);
    }
  }
  console.log(`  total SFX pre-render: ${totalMs.toFixed(0)} ms CPU for ${(samples / ctxSr).toFixed(1)} s of audio (slowest: ${worst.id} ${worst.ms.toFixed(1)} ms)`);
  if (totalMs > 300) warn(`SFX pre-render ${totalMs.toFixed(0)} ms CPU exceeds ~300 ms on this machine (browser renders it in a Web Worker, so the main thread is not blocked)`);
  return totalMs;
}

// ------------------------------------------------------------------------------------ instruments

function checkInstruments(sr, verbose) {
  console.log(`\n== Music instruments @ ${sr} Hz`);
  const t0 = performance.now();
  const half = dsp.renderRate(sr, 2); // gongs + drones render at half rate, as in music.ts
  const bank = { sr, half, pluck: [], drum: {}, gong: {}, drone: {}, breath: null };
  for (let i = 0; i < inst.NOTE_COUNT; i++) bank.pluck.push(inst.renderPluckNote(sr, i));
  for (const d of inst.DRUM_NAMES) bank.drum[d] = inst.renderDrum(sr, d);
  for (const k of ['hit', 'swell']) bank.gong[k] = inst.renderGong(half, k);
  for (const k of ['menu', 'tension']) bank.drone[k] = inst.renderDroneLoop(half, k);
  bank.breath = inst.renderBreathLoop(sr);
  const ms = performance.now() - t0;
  console.log(`  instrument bank render: ${ms.toFixed(0)} ms CPU (lazy, on the first music() call)`);

  bank.pluck.forEach((b, i) => checkBuffer(`pluck[${i}]`, b, sr));
  for (const d of inst.DRUM_NAMES) checkBuffer(`drum ${d}`, bank.drum[d], sr);
  for (const k of ['hit', 'swell']) checkBuffer(`gong ${k}`, bank.gong[k], half);

  // KS tuning: low, mid and high strings
  for (const i of [0, 8, 13, 20]) {
    const f = dsp.midiToHz(inst.SCALE_MIDI[i]);
    const est = estimatePitch(bank.pluck[i], sr, 0.1, 0.45, f * 0.8, f * 1.25);
    const cents = 1200 * Math.log2(est / f);
    if (verbose) console.log(`  pluck[${i}] target ${f.toFixed(2)} Hz, measured ${est.toFixed(2)} Hz (${cents >= 0 ? '+' : ''}${cents.toFixed(1)} cents)`);
    if (Math.abs(cents) > 8) fail(`pluck[${i}] out of tune by ${cents.toFixed(1)} cents`);
  }

  // drone loops must be seamless
  for (const k of ['menu', 'tension']) {
    const b = bank.drone[k];
    checkBuffer(`drone ${k}`, b, half, { minPeak: 0.05, loop: true });
    let typical = 0;
    for (let i = 1; i < b.length; i++) typical += Math.abs(b[i] - b[i - 1]);
    typical /= b.length - 1;
    const seam = Math.abs(b[0] - b[b.length - 1]);
    if (verbose) console.log(`  drone ${k}: ${(b.length / half).toFixed(2)} s loop @ ${half} Hz, seam jump ${seam.toExponential(2)} vs typical step ${typical.toExponential(2)}`);
    if (seam > typical * 5) fail(`drone ${k}: loop seam discontinuity (${seam.toExponential(2)})`);
  }
  return { bank, ms };
}

// -------------------------------------------------------------------------------- music mixdown

function mixdown(bank, name, seconds, sr, seed) {
  const r = dsp.mulberry32(seed);
  const track = gen.createTrack(name, r);
  const out = new Float32Array(Math.ceil((seconds + 6) * sr));
  const events = [];
  let bad = 0;
  // mixes a buffer recorded at `rate` (linear resampling to sr), optionally damped after `len` s
  const addBuf = (buf, t, g, len, rate = sr) => {
    const n0 = Math.round(t * sr);
    const step = rate / sr;
    const total = Math.floor((buf.length - 1) / step);
    const lenN = len === undefined ? total : Math.min(total, Math.round((len + 0.3) * sr));
    const dampN = len === undefined ? Infinity : Math.round(len * sr);
    const k = Math.exp(-1 / (0.035 * sr));
    let e = 1;
    for (let i = 0; i < lenN && n0 + i < out.length; i++) {
      if (i >= dampN) e *= k;
      const p = i * step;
      const j = Math.floor(p);
      const f = p - j;
      out[n0 + i] += (buf[j] * (1 - f) + (buf[j + 1] ?? 0) * f) * g * e;
    }
  };
  const sink = {
    pluck(t, idx, vel, o) {
      if (!Number.isFinite(t) || !Number.isInteger(idx) || idx < 0 || idx >= inst.NOTE_COUNT || !(vel > 0) || vel > 1.5) bad++;
      events.push({ t, k: 'p' + idx });
      const b = bank.pluck[Math.max(0, Math.min(inst.NOTE_COUNT - 1, Math.round(idx)))];
      addBuf(b, t, vel * gen.MIX.pluck, o?.len);
    },
    drum(t, d, vel) {
      if (!Number.isFinite(t) || !bank.drum[d] || !(vel > 0) || vel > 1.5) bad++;
      events.push({ t, k: 'd' + d });
      if (bank.drum[d]) addBuf(bank.drum[d], t, vel * gen.MIX.drum[d]);
    },
    gong(t, kind, vel) {
      if (!Number.isFinite(t) || !bank.gong[kind]) bad++;
      events.push({ t, k: 'g' + kind });
      addBuf(bank.gong[kind], t, vel * gen.MIX.gong, undefined, bank.half);
    },
    flute(t, notes, vel) {
      if (!Number.isFinite(t) || !notes.length || notes.some((n) => !(n.dur > 0) || n.idx < 0 || n.idx >= inst.NOTE_COUNT)) bad++;
      events.push({ t, k: 'f' + notes.length });
      // crude stand-in for the live flute voice: sine + soft 3rd harmonic with fades
      let tt = t;
      const lvl = vel * gen.MIX.flute;
      for (const n of notes) {
        const f = dsp.midiToHz(inst.SCALE_MIDI[n.idx]);
        const n0 = Math.round(tt * sr);
        const N = Math.round(n.dur * sr);
        for (let i = 0; i < N && n0 + i < out.length; i++) {
          const e = Math.min(1, i / (0.05 * sr), (N - i) / (0.05 * sr));
          const ph = (2 * Math.PI * f * i) / sr;
          out[n0 + i] += lvl * e * (Math.sin(ph) + 0.1 * Math.sin(3 * ph));
        }
        tt += n.dur;
      }
    },
    tone() {},
  };
  const sd = 60 / track.bpm / track.stepsPerBeat;
  const steps = Math.floor(seconds / sd);
  for (let s = 0; s < steps; s++) track.step(sink, s, 0.05 + s * sd, sd);
  if (track.drone) {
    const loop = bank.drone[track.drone];
    const step = bank.half / sr;
    for (let i = 0; i < out.length; i++) {
      const p = (i * step) % loop.length;
      const j = Math.floor(p);
      const f = p - j;
      const v = loop[j] * (1 - f) + loop[(j + 1) % loop.length] * f;
      out[i] += v * track.droneGain * Math.min(1, i / (2.5 * sr));
    }
  }
  for (let i = 0; i < out.length; i++) out[i] *= gen.MIX.track * track.level;
  // per-bar fingerprints to measure variety
  const stepsPerBar = track.stepsPerBeat * 4;
  const barDur = sd * stepsPerBar;
  const bars = new Map();
  for (const e of events) {
    const bar = Math.floor((e.t - 0.05 + 1e-6) / barDur);
    const pos = Math.round(((e.t - 0.05 - bar * barDur) / sd) * 4);
    if (!bars.has(bar)) bars.set(bar, []);
    bars.get(bar).push(e.k + '@' + pos);
  }
  const prints = [...bars.values()].map((l) => l.sort().join(','));
  const unique = new Set(prints).size;
  return { out, events, bad, bars: prints.length, unique, track };
}

function checkMusic(bank, sr) {
  console.log(`\n== Music generators @ ${sr} Hz (offline mixdown, 90 s each, 3 seeds)`);
  const volMusic = 0.7 * 0.7;
  const volMaster = 0.85 * 0.85;
  for (const name of ['menu', 'battle', 'tension']) {
    for (const seed of [1, 2, 3]) {
      const m = mixdown(bank, name, 90, sr, seed * 7919);
      const s = stats(m.out, sr);
      const loud = dsp.loudnessDb(m.out, sr);
      const perMin = (m.events.length / 90) * 60;
      const variety = m.unique / Math.max(1, m.bars);
      if (seed === 1 || m.bad || s.bad) {
        console.log(
          `  ${name.padEnd(8)} seed ${seed}: ${m.track.bpm} BPM, ${perMin.toFixed(0)} events/min, ${m.unique}/${m.bars} distinct bars, ` +
            `track peak ${s.pk.toFixed(2)}, rms ${(20 * Math.log10(s.rms + 1e-12)).toFixed(1)} dB, short-term max ${loud.toFixed(1)} dB, ` +
            `at default volumes peak ${(s.pk * volMusic * volMaster).toFixed(2)}`,
        );
      }
      if (m.bad) fail(`${name} seed ${seed}: ${m.bad} malformed events`);
      if (s.bad) fail(`${name} seed ${seed}: non-finite samples in mixdown`);
      if (s.pk > 1.6) fail(`${name} seed ${seed}: mixdown peak ${s.pk.toFixed(2)} (too hot before music volume)`);
      if (s.pk < 0.08) fail(`${name} seed ${seed}: mixdown too quiet (${s.pk.toFixed(3)})`);
      if (name === 'battle' && variety < 0.6) fail(`battle seed ${seed}: only ${(variety * 100).toFixed(0)} % distinct bars`);
      if (name !== 'battle' && variety < 0.3) warn(`${name} seed ${seed}: low variety ${(variety * 100).toFixed(0)} % distinct bars`);
      if (wavDir && seed === 1) writeWav(join(wavDir, `music_${name}.wav`), m.out.subarray(0, 45 * sr), sr);
    }
  }
}

// ------------------------------------------------------------------------------- design intent

/** In-place iterative radix-2 FFT (re/im arrays, length = power of two). */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar;
        im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** Energy-weighted spectral centroid (Hz) and share of energy below 200 Hz, over [t0, t1). */
function spectrum(buf, sr, t0 = 0, t1 = Infinity) {
  const N = 2048;
  const a = Math.round(t0 * sr);
  const b = Math.min(buf.length, Math.round(t1 * sr));
  let num = 0;
  let den = 0;
  let low = 0;
  let pres = 0;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let s = a; s + N <= Math.max(b, a + N); s += N / 2) {
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
      re[i] = (buf[s + i] ?? 0) * w;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const e = re[k] * re[k] + im[k] * im[k];
      const f = (k * sr) / N;
      num += f * e;
      den += e;
      if (f < 200) low += e;
      else if (f >= 1000 && f < 6000) pres += e;
    }
    if (s + N >= b) break;
  }
  return { centroid: den > 0 ? num / den : 0, low: den > 0 ? low / den : 0, pres: den > 0 ? pres / den : 0, lowE: low };
}

/** Time (s) of the loudest 20 ms window, and attack time (ms) to 90 % of the peak sample. */
function envelopeShape(buf, sr, attackWindow = Infinity) {
  const W = Math.round(0.02 * sr);
  let acc = 0;
  let best = 0;
  let bestAt = 0;
  for (let i = 0; i < buf.length; i++) {
    acc += buf[i] * buf[i];
    if (i >= W) acc -= buf[i - W] * buf[i - W];
    if (acc > best) {
      best = acc;
      bestAt = (i - W / 2) / sr;
    }
  }
  const win = buf.subarray(0, Math.min(buf.length, Math.round(attackWindow * sr)));
  const pk = dsp.peakAbs(win);
  let att = 0;
  while (att < win.length && Math.abs(win[att]) < 0.9 * pk) att++;
  return { peakAt: Math.max(0, bestAt), attackMs: (att / sr) * 1000 };
}

function checkCharacter(ctxSr) {
  console.log(`\n== SFX character (variant 0, main layer) @ ${ctxSr} Hz`);
  console.log('  id              attack   loudest  centroid  <200Hz  1-6kHz   (attack of the first hit for fight_call)');
  const m = {};
  for (const id of sfx.SFX_IDS) {
    const out = sfx.renderSfx(id, ctxSr, 0);
    const sp = spectrum(out.main, out.rate);
    const sh = envelopeShape(out.main, out.rate, id === 'fight_call' ? 0.15 : Infinity);
    m[id] = { ...sp, ...sh, buf: out.main, rate: out.rate };
    console.log(
      `  ${id.padEnd(15)} ${sh.attackMs.toFixed(1).padStart(6)}ms ${sh.peakAt.toFixed(2).padStart(6)}s ${sp.centroid.toFixed(0).padStart(7)}Hz ${(sp.low * 100).toFixed(0).padStart(5)}% ${(sp.pres * 100).toFixed(0).padStart(6)}%`,
    );
  }
  const expect = (cond, msg) => (cond ? undefined : fail('character: ' + msg));
  for (const id of ['hit_light', 'hit_heavy', 'hit_focus', 'block', 'deflect', 'guard_crush', 'slam', 'crater', 'countdown', 'ui_move', 'fight_call']) {
    expect(m[id].attackMs < 25, `${id} should have a sharp transient (attack ${m[id].attackMs.toFixed(1)} ms)`);
  }
  expect(m.deflect.centroid > 1800, `deflect should be bright (centroid ${m.deflect.centroid.toFixed(0)} Hz)`);
  expect(m.block.centroid < m.hit_light.centroid, 'block should be duller than hit_light');
  expect(m.block.centroid < m.deflect.centroid / 2, 'block should be much duller than deflect');
  expect(m.hit_heavy.lowE > 1.5 * m.hit_light.lowE, 'hit_heavy should carry clearly more (absolute) low end than hit_light');
  expect(m.hit_light.centroid > m.hit_heavy.centroid * 0.5, 'hit_light should not be darker than half of hit_heavy');
  // small speakers: hits must keep real mid/high presence, not just a sub thump
  for (const id of ['hit_light', 'hit_heavy', 'guard_crush']) expect(m[id].pres > 0.08, `${id} needs 1-6 kHz presence (${(m[id].pres * 100).toFixed(0)} %)`);
  for (const id of ['hit_heavy', 'hit_focus', 'slam', 'crater', 'secret_hit', 'ko']) expect(m[id].low > 0.2, `${id} should be bass-heavy (${(m[id].low * 100).toFixed(0)} % < 200 Hz)`);
  expect(m.whoosh_light.peakAt > 0.04 && m.whoosh_light.peakAt < 0.16, 'whoosh_light should swell then fade (peak 40-160 ms)');
  expect(m.whoosh_heavy.peakAt > 0.1 && m.whoosh_heavy.peakAt < 0.32, 'whoosh_heavy should peak at 100-320 ms');
  expect(m.qi_charge.peakAt > 0.55 && m.qi_charge.peakAt < 0.9, `qi_charge should build up to ~0.8 s (loudest at ${m.qi_charge.peakAt.toFixed(2)} s)`);
  const qc = m.qi_charge;
  const early = spectrum(qc.buf, qc.rate, 0.05, 0.3).centroid;
  const late = spectrum(qc.buf, qc.rate, 0.55, 0.8).centroid;
  console.log(`  qi_charge centroid rises ${early.toFixed(0)} Hz -> ${late.toFixed(0)} Hz`);
  expect(late > early * 1.3, 'qi_charge should rise in brightness');
  expect(m.secret_start.peakAt < 0.3 || m.secret_start.peakAt > 1.8, 'secret_start: taiko hit at 0, gong swell climax ~2 s');
  expect(m.ui_move.buf.length / m.ui_move.rate < 0.15, 'ui_move should be short');
}

// ------------------------------------------------------------------------------ API safety

/** The public engine must never throw without Web Audio, without unlock(), or with bad input. */
async function checkApiSafety() {
  console.log('\n== Public API without Web Audio (Node: no window / AudioContext / localStorage)');
  const { audio, audioDebugInfo } = await import(new URL('audio.ts', base).href);
  const calls = [
    ['ready', () => audio.ready],
    ['play before unlock', () => audio.play('hit_heavy', { intensity: 1, pan: -1, pitch: 2, volume: 1 })],
    ['play unknown id', () => audio.play('nope')],
    ['play NaN opts', () => audio.play('deflect', { intensity: NaN, pan: Infinity, pitch: -1, volume: NaN })],
    ['music before unlock', () => audio.music('battle', 2)],
    ['music null', () => audio.music(null)],
    ['setVolume', () => audio.setVolume('music', 0.5)],
    ['setVolume NaN', () => audio.setVolume('sfx', NaN)],
    ['getVolume', () => audio.getVolume('music')],
    ['duck', () => audio.duck(0.3, 2)],
    ['setSlowmo', () => audio.setSlowmo(0.4)],
    ['setSlowmo bad', () => audio.setSlowmo(-3)],
    ['unlock (no window)', () => audio.unlock()],
  ];
  for (const [name, fn] of calls) {
    try {
      const v = fn();
      if (v && typeof v.then === 'function') await v;
    } catch (e) {
      fail(`API: ${name} threw ${e}`);
    }
  }
  // a browser-like global without Web Audio
  globalThis.window = {};
  try {
    await audio.unlock();
    audio.play('hit_light');
    audio.music('menu');
  } catch (e) {
    fail(`API: window without AudioContext threw ${e}`);
  } finally {
    delete globalThis.window;
  }
  const d = audioDebugInfo();
  if (audio.ready !== false) fail('API: ready should stay false without Web Audio');
  if (audio.getVolume('music') !== 0.5) fail(`API: getVolume should return the set value (got ${audio.getVolume('music')})`);
  console.log(`  ok: ready=${audio.ready}, supported=${d.supported}, music volume=${audio.getVolume('music')}, wanted track=${d.musicTrack}`);
}

// -------------------------------------------------------------------------------------------- run

if (wavDir) mkdirSync(wavDir, { recursive: true });
await checkApiSafety();
const sfxMs48 = checkSfx(48000, true);
checkSfx(44100, false);
checkCharacter(48000);
const { bank, ms: instMs } = checkInstruments(48000, true);
checkInstruments(44100, false);
checkMusic(bank, 48000);

console.log(`\nInit budget (48 kHz, this machine): SFX ${sfxMs48.toFixed(0)} ms first-run CPU, music bank ${instMs.toFixed(0)} ms (both run in a Web Worker in the browser).`);
if (wavDir) console.log(`WAV files written to ${wavDir}`);
console.log(failures ? `\n${failures} FAILURE(S), ${warnings} warning(s)` : `\nALL CHECKS PASSED (${warnings} warning(s))`);
process.exit(failures ? 1 : 0);
