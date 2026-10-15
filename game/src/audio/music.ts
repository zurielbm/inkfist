/*
 * INKFIST procedural audio: Web Audio side of the generative music. Renders the instrument bank
 * lazily on the first music() call (in a worker, or time-sliced on the main thread), then drives
 * TrackGen generators with a lookahead scheduler (setInterval + AudioContext time).
 */

import type { MusicTrack } from './audio';
import { midiToHz, mulberry32 } from './dsp';
import type { Rng } from './dsp';
import { DRUM_NAMES, NOTE_COUNT, SCALE_MIDI } from './instruments';
import type { DroneName, DrumName, GongKind } from './instruments';
import { renderInBackground, toBuffer } from './render-client';
import type { RenderWhere } from './render-client';
import type { RenderJob } from './render-jobs';
import { MIX, createTrack } from './music-gen';
import type { FluteNote, MusicOut, PluckOpts, TrackGen } from './music-gen';

const LOOKAHEAD = 0.12;
const TICK_MS = 25;
const PAN_POS = [-0.4, 0, 0.4];

interface Bank {
  pluck: (AudioBuffer | null)[];
  drum: Partial<Record<DrumName, AudioBuffer>>;
  gong: Partial<Record<GongKind, AudioBuffer>>;
  drone: Partial<Record<DroneName, AudioBuffer>>;
  breath: AudioBuffer | null;
}

function panIndex(pan: number): number {
  return pan < -0.15 ? 0 : pan > 0.15 ? 2 : 1;
}

class Player implements MusicOut {
  readonly gain: GainNode;
  endTime = Infinity;
  private readonly ctx: AudioContext;
  private readonly eng: MusicEngine;
  private readonly bank: Bank;
  private readonly gen: TrackGen;
  private readonly rnd: Rng;
  private readonly strings: BiquadFilterNode;
  private readonly stringPans: AudioNode[] = [];
  private readonly drumPans: AudioNode[] = [];
  private drone: AudioBufferSourceNode | null = null;
  private nextTime: number;
  private stepIdx = 0;

  constructor(ctx: AudioContext, eng: MusicEngine, bank: Bank, gen: TrackGen, rnd: Rng, out: AudioNode, now: number, fade: number) {
    this.ctx = ctx;
    this.eng = eng;
    this.bank = bank;
    this.gen = gen;
    this.rnd = rnd;
    this.gain = ctx.createGain();
    this.gain.gain.setValueAtTime(0, now);
    this.gain.gain.linearRampToValueAtTime(MIX.track * gen.level, now + fade);
    this.gain.connect(out);
    this.strings = ctx.createBiquadFilter();
    this.strings.type = 'lowpass';
    this.strings.frequency.value = 3000;
    this.strings.Q.value = 0.5;
    this.strings.connect(this.gain);
    const stereo = typeof ctx.createStereoPanner === 'function';
    for (const p of PAN_POS) {
      for (const [list, dest] of [
        [this.stringPans, this.strings],
        [this.drumPans, this.gain],
      ] as const) {
        let node: AudioNode;
        if (stereo) {
          const sp = ctx.createStereoPanner();
          sp.pan.value = p;
          node = sp;
        } else node = ctx.createGain();
        node.connect(dest);
        list.push(node);
      }
    }
    const dbuf = gen.drone ? bank.drone[gen.drone] : undefined;
    if (dbuf) {
      const src = ctx.createBufferSource();
      src.buffer = dbuf;
      src.loop = true;
      src.playbackRate.value = eng.rate;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(gen.droneGain, now + Math.max(fade, 2.5));
      src.connect(g);
      g.connect(this.gain);
      src.start(now, rnd() * dbuf.duration);
      this.drone = src;
    }
    this.nextTime = now + 0.06;
  }

  schedule(now: number, until: number): void {
    // fell far behind (throttled background tab): skip ahead instead of bursting notes
    if (this.nextTime < now - 0.25) this.nextTime = now + 0.03;
    let guard = 0;
    while (this.nextTime < until && this.nextTime < this.endTime && guard++ < 64) {
      const sd = 60 / this.gen.bpm / this.gen.stepsPerBeat / Math.max(0.05, this.eng.rate);
      try {
        this.gen.step(this, this.stepIdx, this.nextTime, sd);
      } catch (e) {
        console.warn('[audio] music step failed', e);
      }
      this.stepIdx++;
      this.nextTime += sd;
    }
  }

  fadeOut(now: number, fade: number): void {
    const g = this.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + fade);
    this.endTime = now + fade + 0.05;
    if (this.drone) {
      try {
        this.drone.stop(this.endTime + 0.05);
      } catch {
        /* already stopped */
      }
    }
  }

  setRate(rate: number, now: number): void {
    if (this.drone) this.drone.playbackRate.setTargetAtTime(rate, now, 0.12);
  }

  dispose(): void {
    try {
      this.gain.disconnect();
      this.drone?.disconnect();
    } catch {
      /* ignore */
    }
  }

  // ---- MusicOut

  pluck(t: number, idx: number, vel: number, o?: PluckOpts): void {
    const i = Math.round(idx);
    const buf = this.bank.pluck[i];
    if (!buf || !(vel > 0)) return;
    const ctx = this.ctx;
    const rate = this.eng.rate * (1 + (this.rnd() - 0.5) * 0.003);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const pr = src.playbackRate;
    pr.setValueAtTime(rate, t);
    const bend = o?.bend;
    let durScale = 1;
    if (bend === 'up') {
      const semis = i < NOTE_COUNT - 1 ? SCALE_MIDI[i + 1] - SCALE_MIDI[i] : 2;
      pr.setValueAtTime(rate, t + 0.12);
      pr.linearRampToValueAtTime(rate * Math.pow(2, semis / 12), t + 0.3);
      durScale = 0.85;
    } else if (bend === 'fall') {
      pr.setValueAtTime(rate, t + 0.3);
      pr.linearRampToValueAtTime(rate * Math.pow(2, -1 / 12), t + 0.75);
      durScale = 1.06;
    } else if (bend === 'vib') {
      pr.setValueAtTime(rate, t + 0.2);
      for (let k = 1; k <= 10; k++) {
        const depth = 0.06 + 0.025 * k;
        pr.linearRampToValueAtTime(rate * Math.pow(2, ((k % 2 ? 1 : -1) * depth) / 12), t + 0.2 + k * 0.1);
      }
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(vel * MIX.pluck, t);
    let stopAt = t + (buf.duration / rate) * durScale + 0.05;
    if (o?.len !== undefined) {
      g.gain.setTargetAtTime(0, t + o.len, 0.035);
      stopAt = Math.min(stopAt, t + o.len + 0.3);
    }
    src.connect(g);
    g.connect(this.stringPans[panIndex(o?.pan ?? 0)]);
    src.onended = () => {
      src.disconnect();
      g.disconnect();
    };
    src.start(t);
    src.stop(stopAt);
  }

  drum(t: number, d: DrumName, vel: number): void {
    const buf = this.bank.drum[d];
    if (!buf || !(vel > 0)) return;
    const pan = d === 'buk' ? -0.3 : d === 'ka' || d === 'wbHi' || d === 'wbLo' || d === 'kkwaeng' ? 0.3 : 0;
    this.oneShot(buf, t, vel * MIX.drum[d], this.drumPans[panIndex(pan)], 0.02);
  }

  gong(t: number, kind: GongKind, vel: number): void {
    const buf = this.bank.gong[kind];
    if (!buf || !(vel > 0)) return;
    this.oneShot(buf, t, vel * MIX.gong, this.drumPans[1], 0.004);
  }

  tone(t: number, cutoff: number): void {
    this.strings.frequency.setTargetAtTime(cutoff, t, 0.8);
  }

  flute(t: number, notes: readonly FluteNote[], vel: number): void {
    if (!notes.length || !(vel > 0)) return;
    const ctx = this.ctx;
    const rate = this.eng.rate;
    const level = vel * MIX.flute;
    const total = notes.reduce((a, n) => a + n.dur, 0);
    const end = t + total;
    const o1 = ctx.createOscillator();
    o1.type = 'sine';
    const o2 = ctx.createOscillator();
    o2.type = 'triangle';
    const o2g = ctx.createGain();
    o2g.gain.value = 0.3;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 4.6 + this.rnd() * 0.9;
    const lfoG = ctx.createGain();
    lfoG.gain.setValueAtTime(0, t);
    lfoG.gain.linearRampToValueAtTime(20, t + Math.min(0.6, total * 0.5));
    lfo.connect(lfoG);
    lfoG.connect(o1.detune);
    lfoG.connect(o2.detune);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, t);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3400;
    o1.connect(amp);
    o2.connect(o2g);
    o2g.connect(amp);
    const nodes: AudioNode[] = [o1, o2, o2g, lfo, lfoG, amp, lp];
    let nz: AudioBufferSourceNode | null = null;
    let bp: BiquadFilterNode | null = null;
    if (this.bank.breath) {
      nz = ctx.createBufferSource();
      nz.buffer = this.bank.breath;
      nz.loop = true;
      bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 0.9;
      const nzg = ctx.createGain();
      nzg.gain.value = 0.35;
      nz.connect(bp);
      bp.connect(nzg);
      nzg.connect(amp);
      nodes.push(nz, bp, nzg);
    }
    amp.connect(lp);
    lp.connect(this.stringPans[2]);
    let tt = t;
    let prevF = 0;
    notes.forEach((n, k) => {
      const f = midiToHz(SCALE_MIDI[Math.max(0, Math.min(NOTE_COUNT - 1, Math.round(n.idx)))]) * rate;
      if (k === 0) {
        o1.frequency.setValueAtTime(f, t);
        o2.frequency.setValueAtTime(f, t);
        bp?.frequency.setValueAtTime(f * 2, t);
        amp.gain.linearRampToValueAtTime(level * 1.15, t + 0.07);
        amp.gain.linearRampToValueAtTime(level, t + 0.2);
      } else {
        const gl = Math.min(0.08, n.dur * 0.3);
        for (const p of [o1.frequency, o2.frequency]) {
          p.setValueAtTime(prevF, tt);
          p.exponentialRampToValueAtTime(f, tt + gl);
        }
        bp?.frequency.setValueAtTime(prevF * 2, tt);
        bp?.frequency.exponentialRampToValueAtTime(f * 2, tt + gl);
        amp.gain.linearRampToValueAtTime(level * 0.75, tt + 0.02);
        amp.gain.linearRampToValueAtTime(level, tt + 0.09);
      }
      prevF = f;
      tt += n.dur;
    });
    amp.gain.linearRampToValueAtTime(level * 0.9, Math.max(end - 0.06, t + 0.21));
    amp.gain.linearRampToValueAtTime(0, end + 0.25);
    const stopAt = end + 0.35;
    for (const s of [o1, o2, lfo]) {
      s.start(t);
      s.stop(stopAt);
    }
    if (nz) {
      nz.start(t, this.rnd() * 0.5);
      nz.stop(stopAt);
    }
    o1.onended = () => {
      for (const nd of nodes) {
        try {
          nd.disconnect();
        } catch {
          /* ignore */
        }
      }
    };
  }

  private oneShot(buf: AudioBuffer, t: number, level: number, dest: AudioNode, detune: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const rate = this.eng.rate * (1 + (this.rnd() - 0.5) * detune);
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = level;
    src.connect(g);
    g.connect(dest);
    src.onended = () => {
      src.disconnect();
      g.disconnect();
    };
    src.start(t);
  }
}

export class MusicEngine {
  /** playback-rate multiplier for slow motion (pitch and tempo) */
  rate = 1;
  renderMs = 0;
  renderWhere: RenderWhere | null = null;
  private readonly ctx: AudioContext;
  private readonly out: AudioNode;
  private bank: Bank | null = null;
  private loading = false;
  private want: { track: MusicTrack; fade: number } | null = null;
  private current: Player | null = null;
  private currentName: MusicTrack = null;
  private players: Player[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly rnd: Rng = mulberry32((Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0);

  constructor(ctx: AudioContext, out: AudioNode) {
    this.ctx = ctx;
    this.out = out;
  }

  get ready(): boolean {
    return this.bank !== null;
  }

  get track(): MusicTrack {
    return this.bank ? this.currentName : (this.want?.track ?? null);
  }

  play(track: MusicTrack, fade: number): void {
    if (!this.bank) {
      this.want = { track, fade };
      if (track) this.load();
      return;
    }
    if (track === this.currentName && (track === null || this.current)) return;
    const now = this.ctx.currentTime;
    const f = Math.max(0.03, fade);
    if (this.current) this.current.fadeOut(now, f);
    this.current = null;
    this.currentName = track;
    if (track) {
      const p = new Player(this.ctx, this, this.bank, createTrack(track, this.rnd), this.rnd, this.out, now, f);
      this.players.push(p);
      this.current = p;
      p.schedule(now, now + LOOKAHEAD);
    }
    this.ensureTimer();
  }

  setRate(rate: number): void {
    this.rate = rate;
    const now = this.ctx.currentTime;
    for (const p of this.players) p.setRate(rate, now);
  }

  private ensureTimer(): void {
    if (this.timer !== null || !this.players.length) return;
    this.timer = setInterval(this.tick, TICK_MS);
  }

  private readonly tick = (): void => {
    const now = this.ctx.currentTime;
    for (const p of this.players) p.schedule(now, now + LOOKAHEAD);
    const keep: Player[] = [];
    for (const p of this.players) {
      if (p.endTime <= now) p.dispose();
      else keep.push(p);
    }
    this.players = keep;
    if (!keep.length && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  };

  private load(): void {
    if (this.loading) return;
    this.loading = true;
    const ctx = this.ctx;
    const bank: Bank = { pluck: new Array<AudioBuffer | null>(NOTE_COUNT).fill(null), drum: {}, gong: {}, drone: {}, breath: null };
    // drone first, then the mid strings outwards (gongs and drones render at half rate)
    const jobs: RenderJob[] = [{ kind: 'drone', drone: 'menu' }];
    const order = Array.from({ length: NOTE_COUNT }, (_, i) => i).sort((a, b) => Math.abs(a - 12) - Math.abs(b - 12));
    for (const idx of order) jobs.push({ kind: 'pluck', idx });
    for (const name of DRUM_NAMES) jobs.push({ kind: 'drum', name });
    jobs.push({ kind: 'gong', gong: 'hit' }, { kind: 'gong', gong: 'swell' }, { kind: 'drone', drone: 'tension' }, { kind: 'breath' });
    renderInBackground(
      ctx.sampleRate,
      jobs,
      (job, r) => {
        const buf = toBuffer(ctx, r.chans[0], r.rate);
        if (job.kind === 'pluck') bank.pluck[job.idx] = buf;
        else if (job.kind === 'drum') bank.drum[job.name] = buf;
        else if (job.kind === 'gong') bank.gong[job.gong] = buf;
        else if (job.kind === 'drone') bank.drone[job.drone] = buf;
        else if (job.kind === 'breath') bank.breath = buf;
      },
      (cpu, where) => {
        this.renderMs = cpu;
        this.renderWhere = where;
        this.bank = bank;
        const w = this.want;
        this.want = null;
        if (w) this.play(w.track, w.fade);
      },
    );
  }
}
