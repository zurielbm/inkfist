/*
 * INKFIST procedural audio: pure DSP primitives.
 *
 * Everything here writes into plain Float32Arrays and has no DOM / Web Audio dependency, so the
 * same code pre-renders AudioBuffers in the browser and runs in Node for numeric checks
 * (tools/audio-check.mjs). Keep this file to erasable TypeScript syntax (no enums, namespaces or
 * constructor parameter properties) so Node's built-in type stripping can load it directly.
 *
 * Performance notes (init budget is ~300 ms for every SFX): hot loops avoid per-sample
 * transcendental calls and closures. Envelopes / filter coefficients / modulators run at a
 * control rate of CR samples, oscillators are damped complex rotators, noise comes from a shared
 * pre-generated table, and saturation uses a rational tanh approximation.
 */

export type Rng = () => number;
/** Breakpoint curve: [timeSeconds, value] pairs, sorted by time. */
export type Pts = ReadonlyArray<readonly [number, number]>;
/** Envelope: breakpoints (smoothstep-interpolated) or attack / hold / exponential-decay (tau). */
export type Env = Pts | { a: number; d: number; h?: number };

export const TAU = Math.PI * 2;
/** control-rate block size (samples) */
const CR = 16;

// ---------------------------------------------------------------------------------------------
// Random + small helpers

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rr(r: Rng, a: number, b: number): number {
  return a + (b - a) * r();
}

/** Log-uniform random value in [a, b] (a, b > 0). */
export function rlog(r: Rng, a: number, b: number): number {
  return a * Math.pow(b / a, r());
}

export function pick<T>(r: Rng, arr: readonly T[]): T {
  return arr[Math.min(arr.length - 1, Math.floor(r() * arr.length))];
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function midiToHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * Sample rate for content that does not need the full band (gongs, booms, drones): sr / div,
 * but never below 22050 Hz (older WebKit rejects AudioBuffers below that rate).
 */
export function renderRate(sr: number, div: number): number {
  return div > 1 && sr / div >= 22050 ? sr / div : sr;
}

export function alloc(sr: number, seconds: number): Float32Array {
  return new Float32Array(Math.max(1, Math.ceil(seconds * sr)));
}

/** Rational tanh approximation (exact at 0 and ±3, saturates beyond). */
export function fastTanh(x: number): number {
  if (x >= 3) return 1;
  if (x <= -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

const NOISE_N = 1 << 16;
const NOISE_MASK = NOISE_N - 1;
let noiseTab: Float32Array | null = null;

/**
 * Shared table of uniform white noise in [-1, 1]. Readers jump to a fresh random offset every
 * 4096 samples, so long layers never loop audibly (white noise has no continuity to preserve).
 */
function noiseTable(): Float32Array {
  if (!noiseTab) {
    const r = mulberry32(0x1c0ffee);
    const t = new Float32Array(NOISE_N);
    for (let i = 0; i < NOISE_N; i++) t[i] = r() * 2 - 1;
    noiseTab = t;
  }
  return noiseTab;
}

// ---------------------------------------------------------------------------------------------
// Curves and envelopes

/**
 * Returns a sampler for a breakpoint curve. Optimised for monotonically increasing t (keeps a
 * cursor); resets if t goes backwards. Values outside the curve hold the end values.
 */
export function curve(p: Pts, mode: 'lin' | 'log' | 'smooth' = 'lin'): (t: number) => number {
  const n = p.length;
  let i = 0;
  return (t: number): number => {
    if (n === 0) return 0;
    if (n === 1 || t <= p[0][0]) return p[0][1];
    if (t >= p[n - 1][0]) return p[n - 1][1];
    if (t < p[i][0]) i = 0;
    while (i < n - 2 && t >= p[i + 1][0]) i++;
    const t0 = p[i][0];
    const v0 = p[i][1];
    const t1 = p[i + 1][0];
    const v1 = p[i + 1][1];
    let u = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
    if (mode === 'log' && v0 > 0 && v1 > 0) return v0 * Math.pow(v1 / v0, u);
    if (mode === 'smooth') u = u * u * (3 - 2 * u);
    return v0 + (v1 - v0) * u;
  };
}

export function envDuration(e: Env): number {
  if ('a' in e) return e.a + (e.h ?? 0) + e.d * 6;
  return e.length ? e[e.length - 1][0] : 0;
}

export function envFn(e: Env): (t: number) => number {
  if ('a' in e) {
    const a = Math.max(e.a, 1e-5);
    const h = e.h ?? 0;
    const d = Math.max(e.d, 1e-5);
    return (t: number) => (t < a ? t / a : t < a + h ? 1 : Math.exp(-(t - a - h) / d));
  }
  return curve(e, 'smooth');
}

/**
 * Fills `buf[0..len)` with an envelope (times `gain`). AD envelopes are computed exactly with
 * incremental multiplies; breakpoint envelopes at control rate with linear interpolation.
 */
function fillEnv(buf: Float64Array, len: number, sr: number, e: Env, gain: number): void {
  if ('a' in e) {
    const att = Math.max(1, Math.round(Math.max(e.a, 1e-5) * sr));
    const hold = att + Math.round((e.h ?? 0) * sr);
    const k = Math.exp(-1 / (Math.max(e.d, 1e-5) * sr));
    const aEnd = Math.min(att, len);
    const hEnd = Math.min(hold, len);
    const inc = gain / att;
    let v = 0;
    for (let i = 0; i < aEnd; i++) {
      buf[i] = v;
      v += inc;
    }
    for (let i = aEnd; i < hEnd; i++) buf[i] = gain;
    v = gain;
    for (let i = hEnd; i < len; i++) {
      buf[i] = v;
      v *= k;
    }
    return;
  }
  const f = curve(e, 'smooth');
  for (let i0 = 0; i0 < len; i0 += CR) {
    const i1 = Math.min(len, i0 + CR);
    const a = f(i0 / sr) * gain;
    const b = f(i1 / sr) * gain;
    const st = (b - a) / (i1 - i0);
    let v = a;
    for (let i = i0; i < i1; i++) {
      buf[i] = v;
      v += st;
    }
  }
}

let envScratch = new Float64Array(1 << 16);
function scratchEnv(len: number): Float64Array {
  if (envScratch.length < len) envScratch = new Float64Array(Math.max(len, envScratch.length * 2));
  return envScratch;
}

// ---------------------------------------------------------------------------------------------
// Filters

/** Topology-preserving state-variable filter (Zavalishin). `bpn` is peak-normalised band-pass. */
export class SVF {
  lp = 0;
  bp = 0;
  bpn = 0;
  hp = 0;
  private ic1 = 0;
  private ic2 = 0;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private k = 1.414;
  private readonly sr: number;

  constructor(sr: number) {
    this.sr = sr;
  }

  set(fc: number, q: number): void {
    const f = clamp(fc, 10, this.sr * 0.45);
    const g = Math.tan((Math.PI * f) / this.sr);
    this.k = 1 / Math.max(q, 0.05);
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }

  tick(v0: number): void {
    const v3 = v0 - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2;
    this.bp = v1;
    this.bpn = this.k * v1;
    this.hp = v0 - this.k * v1 - v2;
  }
}

type FilterMode = 'lp' | 'bp' | 'hp' | 'none';

/** Gain that brings band-limited white noise back to roughly the RMS of full-band noise. */
function noiseComp(mode: FilterMode, fc: number, q: number, nyq: number, twoPole: boolean): number {
  let enbw: number;
  if (mode === 'lp') enbw = 1.11 * fc * (twoPole ? 0.85 : 1);
  else if (mode === 'bp') enbw = ((1.57 * fc) / Math.max(q, 0.1)) * (twoPole ? 0.6 : 1);
  else if (mode === 'hp') enbw = Math.max(nyq - fc, nyq * 0.05);
  else return 1;
  return Math.min(40, Math.sqrt(nyq / clamp(enbw, 1, nyq)));
}

// ---------------------------------------------------------------------------------------------
// Generators. All `add*` functions mix (+=) into `out`, starting at `t0` seconds.

export interface NoiseL {
  t0?: number;
  dur?: number;
  env: Env;
  gain: number;
  mode?: FilterMode;
  /** cutoff / centre Hz, or breakpoints (log-interpolated) */
  fc?: number | Pts;
  q?: number | Pts;
  poles?: 1 | 2;
  /** use brown (1/f^2) noise as the source instead of white */
  brown?: boolean;
  /** tanh saturation amount applied after the envelope (crunch) */
  drive?: number;
  /** cloth-like amplitude flutter depth 0..1 */
  flutter?: number;
  flutterRate?: number;
}

/** Filtered noise layer. Output RMS ≈ 0.58 × gain × env regardless of filter bandwidth. */
export function addNoise(out: Float32Array, sr: number, r: Rng, L: NoiseL): void {
  const n0 = Math.max(0, Math.round((L.t0 ?? 0) * sr));
  const len = Math.min(out.length - n0, Math.ceil((L.dur ?? envDuration(L.env)) * sr));
  if (len <= 0) return;
  const env = scratchEnv(len);
  fillEnv(env, len, sr, L.env, 1);
  const gain = L.gain;
  const mode: FilterMode = L.mode ?? 'none';
  const modeN = mode === 'lp' ? 0 : mode === 'bp' ? 1 : mode === 'hp' ? 2 : 3;
  const fcv = L.fc ?? 1000;
  const qv = L.q ?? 0.707;
  const fcF = typeof fcv === 'number' ? null : curve(fcv, 'log');
  const qF = typeof qv === 'number' ? null : curve(qv, 'lin');
  const varying = fcF !== null || qF !== null;
  const two = (L.poles ?? 1) === 2;
  const nyq = sr / 2;
  const drive = L.drive ?? 0;
  const dn = drive > 0 ? 1 / fastTanh(drive) : 1;
  const fl = L.flutter ?? 0;
  const fbase = L.flutterRate ?? 20;
  let frate = fbase;
  let fph = r() * TAU;
  const brown = L.brown === true;
  // brown noise: one-pole LP at ~120 Hz, rescaled to the RMS of uniform white noise
  const ba = Math.exp((-TAU * 120) / sr);
  const bScale = 0.577 / Math.sqrt((1 - ba) / (1 + ba) / 3);
  let bs = 0;
  const tab = noiseTable();
  // sequential reads from a random offset: cache friendly, and layers stay uncorrelated
  let ni = Math.floor(r() * NOISE_N);
  // inline SVF state (two stages)
  let s1a = 0;
  let s2a = 0;
  let s1b = 0;
  let s2b = 0;
  let a1 = 0;
  let a2 = 0;
  let a3 = 0;
  let k = 1;
  let comp = 1;
  let fm = 1;
  let fstep = 0;
  for (let i0 = 0; i0 < len; i0 += CR) {
    const i1 = Math.min(len, i0 + CR);
    if (modeN !== 3 && (i0 === 0 || varying)) {
      const t = i0 / sr;
      const fc = clamp(fcF ? fcF(t) : (fcv as number), 10, sr * 0.45);
      const q = Math.max(qF ? qF(t) : (qv as number), 0.05);
      const gg = Math.tan((Math.PI * fc) / sr);
      k = 1 / q;
      a1 = 1 / (1 + gg * (gg + k));
      a2 = gg * a1;
      a3 = gg * a2;
      comp = brown ? 1 : noiseComp(mode, fc, q, nyq, two);
    }
    if (fl > 0) {
      if ((i0 & 1023) === 0) frate = fbase * (0.7 + 0.6 * r());
      const s0 = 0.5 + 0.5 * Math.sin(fph);
      fph += (TAU * frate * (i1 - i0)) / sr;
      const s1 = 0.5 + 0.5 * Math.sin(fph);
      fm = 1 - fl * s0 * s0;
      fstep = (1 - fl * s1 * s1 - fm) / (i1 - i0);
    }
    for (let i = i0; i < i1; i++) {
      let x = tab[ni];
      ni = (ni + 1) & NOISE_MASK;
      if ((i & 4095) === 4095) ni = Math.floor(r() * NOISE_N);
      if (brown) {
        bs = ba * bs + (1 - ba) * x;
        x = bs * bScale;
      }
      let y = x;
      if (modeN !== 3) {
        let v3 = x - s2a;
        let v1 = a1 * s1a + a2 * v3;
        let v2 = s2a + a2 * s1a + a3 * v3;
        s1a = 2 * v1 - s1a;
        s2a = 2 * v2 - s2a;
        y = modeN === 0 ? v2 : modeN === 1 ? k * v1 : x - k * v1 - v2;
        if (two) {
          const xin = y;
          v3 = xin - s2b;
          v1 = a1 * s1b + a2 * v3;
          v2 = s2b + a2 * s1b + a3 * v3;
          s1b = 2 * v1 - s1b;
          s2b = 2 * v2 - s2b;
          y = modeN === 0 ? v2 : modeN === 1 ? k * v1 : xin - k * v1 - v2;
        }
        y *= comp;
      }
      let e = env[i];
      if (fl > 0) {
        e *= fm;
        fm += fstep;
      }
      if (drive > 0) out[n0 + i] += fastTanh(y * e * drive) * dn * gain;
      else out[n0 + i] += y * e * gain;
    }
  }
}

export interface KickL {
  t0?: number;
  /** start / end frequency of the exponential pitch sweep */
  f0: number;
  f1: number;
  /** pitch-sweep time constant (s) */
  pd: number;
  /** amplitude decay time constant (s) */
  d: number;
  /** attack (s) */
  a?: number;
  drive?: number;
  gain: number;
}

/** Pitch-enveloped sine (kick / thump / boom) with optional tanh drive. */
export function addKick(out: Float32Array, sr: number, k: KickL): void {
  const n0 = Math.max(0, Math.round((k.t0 ?? 0) * sr));
  const a = k.a ?? 0.0012;
  const len = Math.min(out.length - n0, Math.ceil((a + k.d * 6.5) * sr));
  if (len <= 0) return;
  const fadeStart = Math.max(0, len - Math.ceil(k.d * 0.5 * sr));
  const fadeInv = 1 / Math.max(1, len - fadeStart);
  const att = Math.max(1, Math.round(a * sr));
  const ak = Math.exp(-1 / (k.d * sr));
  const pkBlock = Math.exp(-CR / (k.pd * sr));
  const pkHalf = Math.exp(-CR / 2 / (k.pd * sr));
  const drive = k.drive ?? 0;
  const dn = drive > 0 ? 1 / fastTanh(drive) : 1;
  const g = k.gain;
  let pe = 1;
  let ae = 1;
  let x = 1;
  let y = 0;
  for (let i0 = 0; i0 < len; i0 += CR) {
    const i1 = Math.min(len, i0 + CR);
    const f = k.f1 + (k.f0 - k.f1) * pe * pkHalf;
    pe *= pkBlock;
    const w = (TAU * f) / sr;
    const c = Math.cos(w);
    const s = Math.sin(w);
    for (let i = i0; i < i1; i++) {
      const nx = c * x - s * y;
      y = s * x + c * y;
      x = nx;
      let amp: number;
      if (i < att) amp = i / att;
      else {
        amp = ae;
        ae *= ak;
        if (i > fadeStart) amp *= (len - i) * fadeInv;
      }
      const v = y * amp;
      out[n0 + i] += (drive > 0 ? fastTanh(v * drive) * dn : v) * g;
    }
  }
}

export interface Partial {
  f: number;
  a: number;
  /** decay time constant (s) */
  d: number;
  ph?: number;
}

export interface PartialsL {
  t0?: number;
  parts: readonly Partial[];
  gain: number;
  attack?: number;
  env?: Env;
  /** render length; when given, the layer fades out over its last 5 % (max 0.25 s) */
  dur?: number;
  /** frequency ratio the partials glide towards (pitch sag/rise), time constant glideTau */
  glide?: number;
  glideTau?: number;
  /** vibrato depth (ratio, e.g. 0.004) and rate (Hz) */
  vib?: number;
  vibRate?: number;
}

let accScratch = new Float64Array(1 << 16);

/**
 * Sum of exponentially decaying sines (bells, gongs, metal, wood). Uses a damped complex
 * rotator per partial, so long metallic tails cost a few multiplies per sample.
 */
export function addPartials(out: Float32Array, sr: number, L: PartialsL): void {
  const n0 = Math.max(0, Math.round((L.t0 ?? 0) * sr));
  let maxD = 0;
  for (const p of L.parts) maxD = Math.max(maxD, p.d);
  const attack = L.attack ?? 0.0005;
  const dur = L.dur ?? (L.env ? Math.max(envDuration(L.env), attack + maxD * 7) : attack + maxD * 7);
  const len = Math.min(out.length - n0, Math.ceil(dur * sr));
  if (len <= 0) return;
  if (accScratch.length < len) accScratch = new Float64Array(Math.max(len, accScratch.length * 2));
  const acc = accScratch;
  acc.fill(0, 0, len);
  const glide = L.glide ?? 1;
  const glideTau = L.glideTau ?? 1;
  const vib = L.vib ?? 0;
  const vibRate = L.vibRate ?? 5;
  const dynamic = glide !== 1 || vib > 0;
  const BLK = 64;
  let fmTab: Float64Array | null = null;
  if (dynamic) {
    const nb = Math.ceil(len / BLK) + 1;
    fmTab = new Float64Array(nb);
    for (let b = 0; b < nb; b++) {
      const t = (b * BLK + BLK / 2) / sr;
      let fm = 1 + (glide - 1) * (1 - Math.exp(-t / glideTau));
      if (vib > 0) fm *= 1 + vib * Math.sin(TAU * vibRate * t);
      fmTab[b] = fm;
    }
  }
  const nyqLimit = sr * 0.47;
  for (const p of L.parts) {
    if (p.a === 0 || p.f <= 0 || p.f >= nyqLimit) continue;
    const rdec = Math.exp(-1 / (p.d * sr));
    const nmax = Math.min(len, Math.ceil(p.d * sr * Math.log(Math.abs(p.a) / 1e-4 + 1)));
    const ph0 = p.ph ?? 0;
    let x = p.a * Math.cos(ph0);
    let y = p.a * Math.sin(ph0);
    if (!fmTab) {
      const w = (TAU * p.f) / sr;
      const c = rdec * Math.cos(w);
      const s = rdec * Math.sin(w);
      for (let i = 0; i < nmax; i++) {
        const nx = c * x - s * y;
        y = s * x + c * y;
        x = nx;
        acc[i] += y;
      }
    } else {
      for (let i0 = 0, b = 0; i0 < nmax; i0 += BLK, b++) {
        const w = Math.min((TAU * p.f * fmTab[b]) / sr, Math.PI * 0.94);
        const c = rdec * Math.cos(w);
        const s = rdec * Math.sin(w);
        const i1 = Math.min(nmax, i0 + BLK);
        for (let i = i0; i < i1; i++) {
          const nx = c * x - s * y;
          y = s * x + c * y;
          x = nx;
          acc[i] += y;
        }
      }
    }
  }
  // envelope: attack ramp × optional curve × end fade
  const att = Math.max(1, attack * sr);
  const fadeN = L.dur !== undefined ? Math.max(1, Math.min(Math.round(0.25 * sr), Math.round(len * 0.05))) : 0;
  let env: Float64Array | null = null;
  if (L.env) {
    env = scratchEnv(len);
    fillEnv(env, len, sr, L.env, 1);
  }
  const g = L.gain;
  for (let i = 0; i < len; i++) {
    let e = i < att ? (i / att) * g : g;
    if (env) e *= env[i];
    if (fadeN && i > len - fadeN) e *= (len - i) / fadeN;
    out[n0 + i] += acc[i] * e;
  }
}

export interface FML {
  t0?: number;
  fc: number;
  ratio: number;
  /** modulation index at start / end, decaying with time constant id */
  i0: number;
  i1?: number;
  id: number;
  d: number;
  a?: number;
  gain: number;
}

/** Two-operator FM (metallic clang). */
export function addFM(out: Float32Array, sr: number, L: FML): void {
  const n0 = Math.max(0, Math.round((L.t0 ?? 0) * sr));
  const a = L.a ?? 0.0005;
  const len = Math.min(out.length - n0, Math.ceil((a + L.d * 6) * sr));
  if (len <= 0) return;
  const att = Math.max(1, a * sr);
  const wc = (TAU * L.fc) / sr;
  const wm = wc * L.ratio;
  const i1 = L.i1 ?? 0;
  const ik = Math.exp(-1 / (L.id * sr));
  const ak = Math.exp(-1 / (L.d * sr));
  // modulator as a rotator; carrier phase needs sin(phase + idx*mod) per sample
  const cm = Math.cos(wm);
  const sm = Math.sin(wm);
  let mx = 1;
  let my = 0;
  let ie = 1;
  let ae = 1;
  for (let i = 0; i < len; i++) {
    const idx = i1 + (L.i0 - i1) * ie;
    const s = Math.sin(wc * i + idx * my);
    out[n0 + i] += s * (i < att ? i / att : ae) * L.gain;
    const nx = cm * mx - sm * my;
    my = sm * mx + cm * my;
    mx = nx;
    ie *= ik;
    if (i >= att) ae *= ak;
  }
}

export interface ToneL {
  t0?: number;
  /** fundamental Hz or breakpoints (log-interpolated) */
  f: number | Pts;
  /** harmonic amplitudes: harm[0] = fundamental, harm[1] = 2nd harmonic, ... */
  harm: readonly number[];
  env: Env;
  gain: number;
  dur?: number;
  /** vibrato depth in cents and rate in Hz */
  vib?: number;
  vibRate?: number;
  /** tremolo depth 0..1 and rate (Hz or breakpoints) */
  trem?: number;
  tremRate?: number | Pts;
}

/** Additive harmonic tone with pitch curve, vibrato and tremolo (hums, swells, flute-like). */
export function addTone(out: Float32Array, sr: number, L: ToneL): void {
  const n0 = Math.max(0, Math.round((L.t0 ?? 0) * sr));
  const len = Math.min(out.length - n0, Math.ceil((L.dur ?? envDuration(L.env)) * sr));
  if (len <= 0) return;
  const env = scratchEnv(len);
  fillEnv(env, len, sr, L.env, L.gain);
  const fF = typeof L.f === 'number' ? null : curve(L.f, 'log');
  const f0 = typeof L.f === 'number' ? L.f : 0;
  const trF = L.tremRate === undefined || typeof L.tremRate === 'number' ? null : curve(L.tremRate, 'log');
  const trC = typeof L.tremRate === 'number' ? L.tremRate : 6;
  const trem = L.trem ?? 0;
  const vib = L.vib ?? 0;
  const vibRate = L.vibRate ?? 5.5;
  const harm = L.harm;
  const H = harm.length;
  const nyq = sr * 0.45;
  let x = 1;
  let y = 0;
  let tph = 0;
  let tm = 1;
  let tstep = 0;
  for (let i0 = 0; i0 < len; i0 += CR) {
    const i1 = Math.min(len, i0 + CR);
    const t = (i0 + CR / 2) / sr;
    let f = fF ? fF(t) : f0;
    if (vib > 0) f *= Math.pow(2, (vib * Math.sin(TAU * vibRate * t)) / 1200);
    const w = (TAU * f) / sr;
    const c = Math.cos(w);
    const s = Math.sin(w);
    let hmax = H;
    while (hmax > 1 && f * hmax >= nyq) hmax--;
    if (trem > 0) {
      const a0 = 1 - trem * (0.5 + 0.5 * Math.sin(tph));
      tph += (TAU * (trF ? trF(t) : trC) * (i1 - i0)) / sr;
      const a1 = 1 - trem * (0.5 + 0.5 * Math.sin(tph));
      tm = a0;
      tstep = (a1 - a0) / (i1 - i0);
    }
    for (let i = i0; i < i1; i++) {
      const nx = c * x - s * y;
      y = s * x + c * y;
      x = nx;
      // harmonics via repeated complex multiplication: (x + iy)^h
      let hx = x;
      let hy = y;
      let sum = harm[0] * y;
      for (let h = 1; h < hmax; h++) {
        const tx = hx * x - hy * y;
        hy = hx * y + hy * x;
        hx = tx;
        sum += harm[h] * hy;
      }
      let e = env[i];
      if (trem > 0) {
        e *= tm;
        tm += tstep;
      }
      out[n0 + i] += sum * e;
    }
    // renormalise the rotator once per block (guards against slow magnitude drift)
    const m = 1 / Math.sqrt(x * x + y * y);
    x *= m;
    y *= m;
  }
}

export interface PluckL {
  t0?: number;
  f: number;
  /** decay time of the fundamental (s) */
  t60: number;
  dur?: number;
  /** 0 = dark silk string, 1 = bright metal string */
  bright?: number;
  /** pluck position (fraction of the string) */
  pos?: number;
  gain: number;
  /** pitch bend in semitones over time */
  bend?: Pts;
  /** fingernail click amount */
  nail?: number;
}

/**
 * Karplus-Strong plucked string (guzheng / gayageum-like), rendered in JS because a Web Audio
 * feedback DelayNode cannot go below 128 samples. Loop = delay line + one-pole low-pass (with
 * phase-delay compensation) + fractional delay: first-order all-pass for fixed pitch, Hermite
 * interpolation when the string is bent.
 */
export function addPluck(out: Float32Array, sr: number, r: Rng, L: PluckL): void {
  const n0 = Math.max(0, Math.round((L.t0 ?? 0) * sr));
  const dur = L.dur ?? Math.min(L.t60, 4);
  const len = Math.min(out.length - n0, Math.ceil(dur * sr));
  if (len <= 0) return;
  const bright = clamp(L.bright ?? 0.6, 0, 1);
  const b = 0.6 - 0.48 * bright;
  const P0 = sr / L.f;
  const w0 = (TAU * L.f) / sr;
  const lpDelay = Math.atan2(b * Math.sin(w0), 1 - b * Math.cos(w0)) / w0;
  const mag = (1 - b) / Math.sqrt(1 - 2 * b * Math.cos(w0) + b * b);
  const g = Math.min(0.99995, Math.pow(10, (-3 * P0) / (sr * L.t60)) / mag);
  const gain = L.gain;
  // excitation: low-passed noise burst, comb-filtered by pluck position, zero mean, unit peak
  const E = Math.max(4, Math.round(P0));
  const raw = new Float64Array(E);
  const ea = 0.25 + 0.7 * bright;
  let lp = 0;
  for (let i = 0; i < E; i++) {
    lp += ea * (r() * 2 - 1 - lp);
    raw[i] = lp;
  }
  const pd = Math.max(1, Math.round((L.pos ?? 0.13) * E));
  const exc = new Float64Array(E);
  let mean = 0;
  for (let i = 0; i < E; i++) {
    exc[i] = raw[i] - (i >= pd ? raw[i - pd] : 0);
    mean += exc[i];
  }
  mean /= E;
  let pk = 1e-9;
  for (let i = 0; i < E; i++) {
    exc[i] -= mean;
    pk = Math.max(pk, Math.abs(exc[i]));
  }
  for (let i = 0; i < E; i++) {
    const tw = Math.min(1, i / 3, (E - 1 - i) / 3);
    exc[i] = (exc[i] / pk) * Math.max(0, tw);
  }
  const fadeStart = len - Math.min(len, Math.round(0.03 * sr));
  const fadeN = len - fadeStart;
  let lps = 0;

  if (!L.bend) {
    // fixed pitch: integer delay N + all-pass fractional delay D in [0.1, 1.1)
    const total = P0 - lpDelay;
    const N = Math.max(2, Math.floor(total - 0.1));
    const D = total - N;
    const C = (1 - D) / (1 + D);
    const line = new Float64Array(N);
    let p = 0;
    let apX = 0;
    let apY = 0;
    for (let n = 0; n < len; n++) {
      const d = line[p];
      const ap = C * (d - apY) + apX;
      apX = d;
      apY = ap;
      lps = (1 - b) * ap + b * lps;
      const yv = (n < E ? exc[n] : 0) + g * lps;
      line[p] = yv;
      p = p + 1 === N ? 0 : p + 1;
      const v = n >= fadeStart ? (yv * (len - n)) / fadeN : yv;
      out[n0 + n] += v * gain;
    }
  } else {
    let minSemi = 0;
    for (const pt of L.bend) minSemi = Math.min(minSemi, pt[1]);
    const maxDelay = P0 * Math.pow(2, -minSemi / 12) + 8;
    let size = 64;
    while (size < maxDelay + 4) size <<= 1;
    const mask = size - 1;
    const line = new Float64Array(size);
    const bendF = curve(L.bend, 'smooth');
    let D = P0 - lpDelay;
    let wi = 0;
    for (let n = 0; n < len; n++) {
      if ((n & 15) === 0) D = P0 * Math.pow(2, -bendF(n / sr) / 12) - lpDelay;
      const rp = wi - D;
      const ip = Math.floor(rp);
      const fr = rp - ip;
      const xm1 = line[(ip - 1) & mask];
      const x0 = line[ip & mask];
      const x1 = line[(ip + 1) & mask];
      const x2 = line[(ip + 2) & mask];
      const c1 = 0.5 * (x1 - xm1);
      const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
      const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
      const v = ((c3 * fr + c2) * fr + c1) * fr + x0;
      lps = (1 - b) * v + b * lps;
      const yv = (n < E ? exc[n] : 0) + g * lps;
      line[wi & mask] = yv;
      wi++;
      const o = n >= fadeStart ? (yv * (len - n)) / fadeN : yv;
      out[n0 + n] += o * gain;
    }
  }
  const nail = L.nail ?? 0.3 * bright;
  if (nail > 0) {
    addNoise(out, sr, r, { t0: L.t0, env: { a: 0.0002, d: 0.0018 }, mode: 'hp', fc: Math.min(3500, sr * 0.3), gain: gain * nail * 0.5 });
  }
}

export interface GrainsL {
  t0: number;
  t1: number;
  count: number;
  /** time distribution: denser at the start ('decay'), the end ('rise') or uniform */
  shape?: 'decay' | 'rise' | 'flat';
  fLo: number;
  fHi: number;
  dLo: number;
  dHi: number;
  gain: number;
  /** amplitude decay time constant across the grain cloud */
  fall?: number;
  q?: number;
  drive?: number;
}

/** Cloud of tiny band-passed noise grains: debris, crackle, sparkle. */
export function addGrains(out: Float32Array, sr: number, r: Rng, L: GrainsL): void {
  const fTop = sr * 0.42;
  for (let k = 0; k < L.count; k++) {
    const u = r();
    const tt = L.shape === 'decay' ? u * u : L.shape === 'rise' ? Math.sqrt(u) : u;
    const t = L.t0 + (L.t1 - L.t0) * tt;
    const amp = rr(r, 0.3, 1) * (L.fall ? Math.exp(-(t - L.t0) / L.fall) : 1);
    const d = rr(r, L.dLo, L.dHi);
    addNoise(out, sr, r, {
      t0: t,
      env: { a: 0.0004, d: d / 3 },
      dur: d * 2.4,
      mode: 'bp',
      fc: Math.min(fTop, rlog(r, L.fLo, L.fHi)),
      q: L.q ?? 2,
      gain: L.gain * amp,
      drive: L.drive,
    });
  }
}

/** Mix `src` reversed into `out` so that it ends at sample index `end`. */
export function addReversed(out: Float32Array, src: Float32Array, end: number, gain: number): void {
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const j = end - n + i;
    if (j >= 0 && j < out.length) out[j] += src[n - 1 - i] * gain;
  }
}

// ---------------------------------------------------------------------------------------------
// Percussion and metal (shared by SFX and music)

export interface TaikoL {
  t0?: number;
  f: number;
  /** 0 = small barrel drum (buk), 1 = huge odaiko */
  size: number;
  gain: number;
  /** rim / bachi "ka" amount */
  rim?: number;
}

export function addTaiko(out: Float32Array, sr: number, r: Rng, L: TaikoL): void {
  const s = clamp(L.size, 0, 1);
  const t0 = L.t0 ?? 0;
  addKick(out, sr, { t0, f0: L.f * 1.7, f1: L.f, pd: 0.018 + 0.03 * s, d: 0.16 + 0.5 * s, a: 0.001, drive: 1.6, gain: L.gain });
  // membrane modes (Bessel-zero ratios)
  addPartials(out, sr, {
    t0,
    gain: L.gain * 0.35,
    attack: 0.001,
    parts: [
      { f: L.f * 1.59, a: 0.6, d: 0.06 + 0.12 * s },
      { f: L.f * 2.14, a: 0.4, d: 0.05 + 0.08 * s },
      { f: L.f * 2.3, a: 0.3, d: 0.04 + 0.06 * s },
      { f: L.f * 2.65, a: 0.22, d: 0.03 + 0.05 * s },
      { f: L.f * 2.92, a: 0.15, d: 0.03 + 0.04 * s },
    ],
  });
  addNoise(out, sr, r, { t0, env: { a: 0.0005, d: 0.012 + 0.02 * s }, mode: 'lp', fc: 1500 - 500 * s, gain: L.gain * 0.45 });
  addNoise(out, sr, r, { t0, env: { a: 0.0003, d: 0.005 }, mode: 'bp', fc: 2400, q: 1.2, gain: L.gain * 0.22 });
  addNoise(out, sr, r, { t0, env: { a: 0.003, d: 0.06 + 0.22 * s }, mode: 'lp', fc: L.f * 2.5, brown: true, gain: L.gain * 0.3 * s });
  if (L.rim) addKa(out, sr, r, { t0, gain: L.gain * L.rim * 0.45 });
}

/** Stick on rim / wooden "ka" click. */
export function addKa(out: Float32Array, sr: number, r: Rng, L: { t0?: number; gain: number; f?: number }): void {
  const f = L.f ?? 1900;
  addPartials(out, sr, {
    t0: L.t0,
    gain: L.gain,
    attack: 0.0002,
    parts: [
      { f, a: 1, d: 0.018 },
      { f: f * 1.73, a: 0.6, d: 0.012 },
      { f: f * 2.41, a: 0.35, d: 0.008 },
    ],
  });
  addNoise(out, sr, r, { t0: L.t0, env: { a: 0.0001, d: 0.003 }, mode: 'hp', fc: Math.min(3000, sr * 0.3), gain: L.gain * 0.5 });
}

export function addWoodblock(out: Float32Array, sr: number, r: Rng, L: { t0?: number; f: number; gain: number; d?: number }): void {
  const d = L.d ?? 0.05;
  addPartials(out, sr, {
    t0: L.t0,
    gain: L.gain,
    attack: 0.0003,
    parts: [
      { f: L.f, a: 1, d },
      { f: L.f * 2.47, a: 0.3, d: d * 0.5 },
      { f: L.f * 3.9, a: 0.1, d: d * 0.3 },
    ],
  });
  addNoise(out, sr, r, { t0: L.t0, env: { a: 0.0001, d: 0.0015 }, mode: 'bp', fc: Math.min(L.f * 2.8, sr * 0.4), q: 1.5, gain: L.gain * 0.35 });
}

const GONG_RATIOS = [1, 1.42, 1.94, 2.37, 2.89, 3.36, 3.83, 4.45, 5.1, 5.86, 6.62, 7.5];

export interface GongL {
  t0?: number;
  f: number;
  dur: number;
  gain: number;
  /** 0 = dark, 1 = bright/splashy */
  bright?: number;
  /** if > 0: rolled crescendo of this length (s) instead of a single strike */
  swell?: number;
  /** soft-mallet thump amount */
  mallet?: number;
  /** pitch glide ratio over the tail (jing "wooong" sag) */
  glide?: number;
}

/** Large gong (jing / tam-tam): inharmonic partials with beating twins and pitch sag. */
export function addGong(out: Float32Array, sr: number, r: Rng, L: GongL): void {
  const br = clamp(L.bright ?? 0.6, 0, 1);
  const swell = L.swell ?? 0;
  const t0 = L.t0 ?? 0;
  const parts: Partial[] = [];
  GONG_RATIOS.forEach((k, i) => {
    const a = Math.pow(0.8 - 0.2 * (1 - br), i) * rr(r, 0.75, 1.15);
    const d = ((L.dur * 0.42) / (1 + i * (0.35 - 0.15 * br))) * (swell > 0 ? 1.6 : 1) * rr(r, 0.85, 1.15);
    const f = L.f * k * rr(r, 0.996, 1.004);
    parts.push({ f, a, d, ph: r() * TAU });
    if (i < 6) parts.push({ f: f + rr(r, 0.4, 2.4) * (r() < 0.5 ? -1 : 1), a: a * rr(r, 0.4, 0.7), d: d * 0.9, ph: r() * TAU });
  });
  addPartials(out, sr, {
    t0,
    parts,
    gain: L.gain * 0.35,
    attack: swell > 0 ? 0.02 : 0.003,
    env: swell > 0 ? [[0, 0], [swell * 0.55, 0.18], [swell, 1]] : undefined,
    dur: L.dur,
    glide: L.glide ?? 0.99,
    glideTau: L.dur * 0.4,
  });
  if (swell > 0) {
    addNoise(out, sr, r, { t0, env: [[0, 0], [swell, 1], [swell + 0.5, 0]], mode: 'bp', fc: L.f * 9, q: 1.5, gain: L.gain * 0.05 });
  } else {
    const m = L.mallet ?? 0.6;
    if (m > 0) {
      addKick(out, sr, { t0, f0: L.f * 1.4, f1: L.f * 0.9, pd: 0.02, d: 0.08, gain: L.gain * 0.35 * m });
      addNoise(out, sr, r, { t0, env: { a: 0.001, d: 0.02 }, mode: 'lp', fc: 900, gain: L.gain * 0.3 * m });
    }
  }
}

// [ratio to prime, amplitude, decay as fraction of dur]
const BELL_PARTIALS: ReadonlyArray<readonly [number, number, number]> = [
  [0.5, 0.55, 0.32],
  [1, 0.8, 0.24],
  [1.19, 0.45, 0.17],
  [1.5, 0.3, 0.12],
  [2.0, 0.55, 0.13],
  [2.51, 0.22, 0.08],
  [2.66, 0.2, 0.07],
  [3.01, 0.14, 0.055],
  [4.07, 0.1, 0.04],
  [5.4, 0.05, 0.025],
];

/** Temple bell (beomjong-like): hum + prime + minor-third tierce, slow beating, log strike. */
export function addBell(out: Float32Array, sr: number, r: Rng, L: { t0?: number; f: number; dur: number; gain: number; strike?: number }): void {
  const t0 = L.t0 ?? 0;
  const parts: Partial[] = [];
  BELL_PARTIALS.forEach(([k, a, df], i) => {
    const f = L.f * k * rr(r, 0.998, 1.002);
    const d = L.dur * df * rr(r, 0.9, 1.1);
    parts.push({ f, a, d });
    if (i < 5) parts.push({ f: f + rr(r, 0.5, 1.8), a: a * rr(r, 0.5, 0.8), d: d * 0.95, ph: r() * TAU });
  });
  addPartials(out, sr, { t0, parts, gain: L.gain * 0.4, attack: 0.002, dur: L.dur });
  const s = L.strike ?? 1;
  if (s > 0) {
    addKick(out, sr, { t0, f0: L.f * 0.9, f1: L.f * 0.5, pd: 0.02, d: 0.05, gain: L.gain * 0.35 * s });
    addNoise(out, sr, r, { t0, env: { a: 0.0008, d: 0.02 }, mode: 'lp', fc: 1200, gain: L.gain * 0.3 * s });
    addNoise(out, sr, r, { t0, env: { a: 0.0003, d: 0.008 }, mode: 'bp', fc: L.f * 4, q: 2, gain: L.gain * 0.15 * s });
  }
}

// ---------------------------------------------------------------------------------------------
// Loops

export interface DroneVoice {
  f: number;
  a: number;
  /** number of harmonics */
  harm: number;
  /** beating twin offset in Hz (quantised to the loop) */
  beat?: number;
  /** amplitude-modulation depth 0..1 (slow breathing / swelling) */
  am?: number;
}

/**
 * Seamlessly looping drone. Every frequency is quantised to a multiple of 1/loop Hz so all
 * partials complete whole cycles, and the noise bed is filtered circularly. Drones only hold
 * content below ~2.5 kHz, so they are synthesised at a quarter of `sr` and Hermite-upsampled
 * (circularly, so the loop stays seamless).
 */
export function renderDrone(
  sr: number,
  r: Rng,
  o: { loop: number; voices: readonly DroneVoice[]; noise?: ReadonlyArray<{ fc: number; q: number; a: number; mode: 'lp' | 'bp' }> },
): Float32Array {
  const N = Math.round(o.loop * sr);
  const F = N % 4 === 0 && sr / 4 >= 4000 ? 4 : 1;
  const si = sr / F;
  const Ni = N / F;
  const acc = new Float64Array(Ni);
  const q = (f: number) => Math.max(1, Math.round(f * o.loop)) / o.loop;
  const BLK = 64;
  for (const v of o.voices) {
    const base = q(v.f);
    const beat = v.beat ? Math.max(1, Math.round(v.beat * o.loop)) / o.loop : 0;
    for (let h = 1; h <= v.harm; h++) {
      const freq = base * h;
      if (freq > si * 0.4) break;
      const amp = v.a / Math.pow(h, 1.6);
      const amCycles = 1 + Math.floor(r() * 3);
      const amPh = r() * TAU;
      const am = v.am ?? 0.3;
      const freqs = beat && h <= 2 ? [freq, freq + beat * h] : [freq];
      for (let k = 0; k < freqs.length; k++) {
        const w = (TAU * freqs[k]) / si;
        const c = Math.cos(w);
        const s = Math.sin(w);
        const ph = r() * TAU;
        let x = Math.cos(ph);
        let y = Math.sin(ph);
        const g = amp * (k === 0 ? 1 : 0.6);
        // slow AM (a whole number of cycles per loop), evaluated at control rate
        const wa = (TAU * amCycles) / Ni;
        for (let i0 = 0; i0 < Ni; i0 += BLK) {
          const i1 = Math.min(Ni, i0 + BLK);
          const m0 = g * (1 - am * (0.5 + 0.5 * Math.sin(wa * i0 + amPh + k)));
          const m1 = g * (1 - am * (0.5 + 0.5 * Math.sin(wa * i1 + amPh + k)));
          const ms = (m1 - m0) / (i1 - i0);
          let m = m0;
          for (let i = i0; i < i1; i++) {
            const nx = c * x - s * y;
            y = s * x + c * y;
            x = nx;
            acc[i] += y * m;
            m += ms;
          }
          const nrm = 1 / Math.sqrt(x * x + y * y);
          x *= nrm;
          y *= nrm;
        }
      }
    }
  }
  if (o.noise) {
    const tab = noiseTable();
    for (const nz of o.noise) {
      let ni = Math.floor(r() * NOISE_N);
      const white = new Float64Array(Ni);
      for (let i = 0; i < Ni; i++) {
        white[i] = tab[ni];
        ni = (ni + 1) & NOISE_MASK;
        if ((i & 4095) === 4095) ni = Math.floor(r() * NOISE_N);
      }
      const gg = Math.tan((Math.PI * clamp(nz.fc, 10, si * 0.45)) / si);
      const kq = 1 / Math.max(nz.q, 0.05);
      const a1 = 1 / (1 + gg * (gg + kq));
      const a2 = gg * a1;
      const a3 = gg * a2;
      // the bed is level-matched to what full-band (sr) noise through the same filter would give
      const comp = noiseComp(nz.mode, nz.fc, nz.q, si / 2, false) * nz.a;
      const lpMode = nz.mode === 'lp';
      const wm = (TAU * 2) / Ni;
      let s1 = 0;
      let s2 = 0;
      // two passes: the second starts from the steady state the first ended in => circular
      for (let pass = 0; pass < 2; pass++) {
        for (let i0 = 0; i0 < Ni; i0 += 64) {
          const i1 = Math.min(Ni, i0 + 64);
          const m = 0.6 + 0.4 * Math.sin(wm * (i0 + 32) + nz.fc);
          for (let i = i0; i < i1; i++) {
            const v3 = white[i] - s2;
            const v1 = a1 * s1 + a2 * v3;
            const v2 = s2 + a2 * s1 + a3 * v3;
            s1 = 2 * v1 - s1;
            s2 = 2 * v2 - s2;
            if (pass === 1) acc[i] += (lpMode ? v2 : kq * v1) * comp * m;
          }
        }
      }
    }
  }
  const out = new Float32Array(N);
  if (F === 1) {
    for (let i = 0; i < N; i++) out[i] = acc[i];
    return out;
  }
  // circular 4-point Hermite upsampling by F
  for (let j = 0; j < Ni; j++) {
    const xm1 = acc[(j - 1 + Ni) % Ni];
    const x0 = acc[j];
    const x1 = acc[(j + 1) % Ni];
    const x2 = acc[(j + 2) % Ni];
    const c1 = 0.5 * (x1 - xm1);
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    for (let k = 0; k < F; k++) {
      const fr = k / F;
      out[j * F + k] = ((c3 * fr + c2) * fr + c1) * fr + x0;
    }
  }
  return out;
}

/** Stereo reverb impulse response: early reflections + exponentially decaying darkening noise. */
export function renderReverbIR(sr: number, r: Rng, dur = 2.4, rt60 = 2.1): [Float32Array, Float32Array] {
  const N = Math.round(dur * sr);
  const pre = Math.round(0.012 * sr);
  const chans: [Float32Array, Float32Array] = [new Float32Array(N), new Float32Array(N)];
  const tab = noiseTable();
  for (const ch of chans) {
    let lp = 0;
    let lpA = 0.5;
    let ni = Math.floor(r() * NOISE_N);
    const kEnv = Math.exp(-6.91 / rt60 / sr);
    let env = 1;
    for (let i = pre; i < N; i++) {
      const t = (i - pre) / sr;
      if (((i - pre) & 63) === 0) {
        // darkening tail: cutoff falls from ~10 kHz to ~1.4 kHz
        const fc = 9000 * Math.exp(-t / 0.7) + 1400;
        lpA = 1 - Math.exp((-TAU * fc) / sr);
      }
      lp += lpA * (tab[ni] - lp);
      ni = (ni + 1) & NOISE_MASK;
      if ((i & 4095) === 4095) ni = Math.floor(r() * NOISE_N);
      ch[i] = lp * env * Math.min(1, t / 0.004);
      env *= kEnv;
    }
    for (let k = 0; k < 7; k++) {
      const idx = pre + Math.round(rr(r, 0.004, 0.07) * sr);
      if (idx < N) ch[idx] += rr(r, -0.6, 0.6) * Math.exp(-k * 0.2);
    }
    let e = 0;
    for (let i = 0; i < N; i++) e += ch[i] * ch[i];
    const g = 1 / Math.sqrt(e + 1e-12);
    for (let i = 0; i < N; i++) ch[i] *= g;
  }
  return chans;
}

// ---------------------------------------------------------------------------------------------
// Finishing and measurement

/** One-pole DC blocker (high-pass at fc Hz), in place. */
export function dcBlock(buf: Float32Array, sr: number, fc = 15): void {
  const R = Math.exp((-TAU * fc) / sr);
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const y = x - x1 + R * y1;
    x1 = x;
    y1 = y;
    buf[i] = y;
  }
}

export function peakAbs(buf: Float32Array): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > p) p = a;
  }
  return p;
}

export function scale(buf: Float32Array, g: number): void {
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
}

/**
 * Rough short-term loudness: max RMS over 50 ms windows of a 60 Hz high-passed copy, in dBFS.
 * Good enough to balance SFX against each other.
 */
export function loudnessDb(buf: Float32Array, sr: number): number {
  const n = buf.length;
  const B = Math.max(1, Math.round(0.0125 * sr)); // 4 blocks = one 50 ms window
  const nb = Math.ceil(n / B);
  const blocks = new Float64Array(nb);
  const R = Math.exp((-TAU * 60) / sr);
  let x1 = 0;
  let y1 = 0;
  for (let b = 0; b < nb; b++) {
    const end = Math.min(n, (b + 1) * B);
    let e = 0;
    for (let i = b * B; i < end; i++) {
      const x = buf[i];
      const y = x - x1 + R * y1;
      x1 = x;
      y1 = y;
      e += y * y;
    }
    blocks[b] = e;
  }
  let best = 0;
  for (let b = 0; b < nb; b++) {
    const e = blocks[b] + (b >= 1 ? blocks[b - 1] : 0) + (b >= 2 ? blocks[b - 2] : 0) + (b >= 3 ? blocks[b - 3] : 0);
    if (e > best) best = e;
  }
  const rms = Math.sqrt(best / Math.min(4 * B, n));
  return 20 * Math.log10(rms + 1e-12);
}

/** Trims trailing near-silence (relative to the peak) and fades the new end; returns a view. */
export function trimTail(buf: Float32Array, sr: number, floorDb = -70, fadeMs = 12): Float32Array {
  const pk = peakAbs(buf);
  if (pk <= 0) return buf.subarray(0, Math.min(buf.length, 1));
  const thr = pk * dbToGain(floorDb);
  let last = buf.length - 1;
  while (last > 0 && Math.abs(buf[last]) < thr) last--;
  const end = Math.min(buf.length, last + Math.round(0.01 * sr) + 1);
  const out = buf.subarray(0, end);
  const fn = Math.min(end, Math.round((fadeMs / 1000) * sr));
  for (let i = 0; i < fn; i++) out[end - 1 - i] *= i / fn;
  return out;
}
