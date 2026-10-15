/*
 * INKFIST 墨拳: procedural audio engine (public API).
 *
 * No audio files: every SFX is synthesised in JS (sfx-defs.ts / dsp.ts) into AudioBuffers right
 * after unlock(), in a Web Worker (render-worker.ts) with a time-sliced main-thread fallback; music
 * instruments are rendered the same way, lazily on the first music() call (instruments.ts), and
 * driven by generative track logic (music-gen.ts, music.ts). A sound requested before its
 * background render arrived is rendered synchronously on the spot.
 *
 * Graph:
 *   voices -> [lowpass] -> [pan] -> sfxBus ------------------------------\
 *                          \-> send -> sfxSend --\                         \
 *   tracks -> musicVol -> duck -> slowmoFilter ---+-> reverb -> return ---+-> master -> compressor -> soft clip -> out
 *                                     \---------------------------------/
 *
 * Every public method is safe to call before unlock() and when Web Audio is unavailable.
 */

import { clamp, dbToGain, mulberry32 } from './dsp';
import { MusicEngine } from './music';
import { renderInBackground, toBuffer } from './render-client';
import type { RenderWhere } from './render-client';
import { nowMs } from './render-jobs';
import type { RenderJob } from './render-jobs';
import { DEFAULT_INTENSITY, SFX_DEFS, SFX_IDS, heavyGainFor, renderSfx } from './sfx-defs';

export type SfxId =
  | 'whoosh_light' | 'whoosh_heavy'      // attack swings (sleeve/fist through air)
  | 'hit_light' | 'hit_heavy'            // flesh/cloth impacts (punchy, low-end thump + crack)
  | 'hit_focus'                          // huge unblockable hit: deep boom + crack + ring
  | 'block'                              // dull guarded impact (wood/cloth thud)
  | 'deflect'                            // bright metallic "TING" parry clang with shimmer tail
  | 'guard_crush'                        // guard broken: cracking + low hit
  | 'dash' | 'jump' | 'land'             // movement foley (cloth swish, light thump)
  | 'slam' | 'crater'                    // ground slam / earth-shattering crater (rumble + debris rattle)
  | 'qi_charge'                          // rising airy energy hum (≈0.8 s)
  | 'qi_ready'                           // short sparkle chime when a Qi bar fills
  | 'qi_burst'                           // explosive wind burst
  | 'art_cast'                           // special-technique cast (wind + pitched swell)
  | 'projectile'                         // sleeve lash / palm wave travelling
  | 'secret_start'                       // cinematic ultimate begins: big taiko hit + gong swell
  | 'secret_hit'                         // ultimate final blow: massive boom
  | 'ko'                                 // knockout: gong + slowed boom
  | 'round_call'                         // round start: temple bell / gong
  | 'fight_call'                         // fight begins: two sharp taiko hits
  | 'ui_move' | 'ui_select' | 'ui_back'  // menu: soft woodblock / pluck
  | 'victory' | 'defeat'                 // short musical stingers (pentatonic)
  | 'countdown';                         // timer tick under 10 s (woodblock)

export interface PlayOpts {
  volume?: number;     // 0..1 multiplier (default 1)
  pitch?: number;      // playback-rate multiplier (default 1); add slight random variance automatically
  pan?: number;        // -1..1 stereo pan
  intensity?: number;  // 0..1, scales loudness/brightness/length of impacts (bigger combos sound bigger)
}

export type MusicTrack = 'menu' | 'battle' | 'tension' | null;

export interface AudioEngine {
  unlock(): Promise<void>;                    // call from first user gesture; resumes/creates AudioContext; must work on iOS Safari
  readonly ready: boolean;
  play(id: SfxId, opts?: PlayOpts): void;    // no-op (no throw) if not unlocked yet
  music(track: MusicTrack, fadeSeconds?: number): void;  // crossfade to a generative track; null = fade out
  setVolume(kind: 'master' | 'sfx' | 'music', v: number): void;  // persisted to localStorage key 'inkfist.audio'
  getVolume(kind: 'master' | 'sfx' | 'music'): number;
  /** Temporarily lower music: it is multiplied by `amount` (0 = silent, 1 = no duck) for `seconds`. */
  duck(amount: number, seconds: number): void; // temporarily lower music (e.g. 0.3 for ultimate cinematic)
  setSlowmo(rate: number): void;              // 1 = normal; e.g. 0.4 during KO slow-motion: lowers pitch of newly started SFX and music playback
}

type VolKind = 'master' | 'sfx' | 'music';

const STORAGE_KEY = 'inkfist.audio';
const DEFAULT_VOLUME: Readonly<Record<VolKind, number>> = { master: 0.85, sfx: 1, music: 0.7 };
const VOL_KINDS: readonly VolKind[] = ['master', 'sfx', 'music'];
const MAX_VOICES = 40;
const MAX_PER_ID = 6;
/** identical SFX started closer together than this are merged */
const RETRIGGER_GAP = 0.025;
const DEFAULT_FADE = 1.5;

/** Render order after unlock: things needed first (menus, round intro, basic combat) go first. */
const PRIORITY: readonly SfxId[] = [
  'ui_move', 'ui_select', 'ui_back', 'countdown', 'round_call', 'fight_call',
  'whoosh_light', 'hit_light', 'block', 'whoosh_heavy', 'hit_heavy', 'deflect', 'dash', 'jump', 'land',
];

interface SfxSet {
  main: (AudioBuffer | null)[];
  heavy: (AudioBuffer | null)[];
}

interface Voice {
  id: SfxId;
  end: number;
  srcs: AudioBufferSourceNode[];
  vg: GainNode;
  nodes: AudioNode[];
}

/** Perceptual slider curve. */
const volGain = (v: number): number => v * v;

function finite(x: unknown, fallback: number): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : fallback;
}

function loadVolumes(): Record<VolKind, number> {
  const v: Record<VolKind, number> = { ...DEFAULT_VOLUME };
  try {
    if (typeof localStorage === 'undefined') return v;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return v;
    const o = JSON.parse(raw) as Partial<Record<VolKind, unknown>> | null;
    if (!o || typeof o !== 'object') return v;
    for (const k of VOL_KINDS) {
      const x = o[k];
      if (typeof x === 'number' && Number.isFinite(x)) v[k] = clamp(x, 0, 1);
    }
  } catch {
    /* storage blocked (private mode, sandboxed iframe) */
  }
  return v;
}

function saveVolumes(v: Record<VolKind, number>): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

/** Linear up to 0.8, then tanh knee towards ~0.95: a last-resort safety clipper after the compressor. */
function softClipCurve() {
  const n = 4096;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    c[i] = a <= 0.8 ? x : Math.sign(x) * (0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2));
  }
  return c;
}

export interface AudioDebugInfo {
  supported: boolean;
  state: string;
  sampleRate: number;
  sfxRendered: number;
  sfxTotal: number;
  /** CPU time spent pre-rendering SFX (sum over jobs, wherever they ran) */
  sfxRenderMs: number;
  /** where the background SFX render ran ('worker' | 'main'), null while still running */
  sfxRenderWhere: RenderWhere | null;
  musicReady: boolean;
  musicRenderMs: number;
  musicRenderWhere: RenderWhere | null;
  /** main-thread time spent inside unlock() creating the context and graph */
  unlockMs: number;
  musicTrack: MusicTrack;
  voices: number;
  slowmo: number;
}

class Engine implements AudioEngine {
  private ctx: AudioContext | null = null;
  private supported = true;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private sfxSend: GainNode | null = null;
  private musicVol: GainNode | null = null;
  private duckGain: GainNode | null = null;
  private musicFilter: BiquadFilterNode | null = null;
  private convolver: ConvolverNode | null = null;
  private musicEngine: MusicEngine | null = null;
  private hasPanner = false;
  private readonly vol = loadVolumes();
  private slowmo = 1;
  private readonly sets = new Map<SfxId, SfxSet>();
  private voices: Voice[] = [];
  private readonly lastVariant = new Map<SfxId, number>();
  private readonly lastStart = new Map<SfxId, number>();
  private wantMusic: { track: MusicTrack; fade: number } | null = null;
  private duckUntil = 0;
  private duckLevel = 1;
  private hiddenSuspended = false;
  private warned = false;
  private sfxRenderMs = 0;
  private sfxRendered = 0;
  private sfxRenderWhere: RenderWhere | null = null;
  private unlockMs = 0;
  private readonly sfxTotal = SFX_IDS.reduce((a, id) => a + SFX_DEFS[id].variants, 0);
  private readonly rnd = mulberry32((Date.now() ^ 0x5eed) >>> 0);

  get ready(): boolean {
    return this.ctx !== null && this.master !== null && this.ctx.state === 'running';
  }

  unlock(): Promise<void> {
    try {
      if (!this.ctx) {
        const t0 = nowMs();
        const ok = this.create();
        this.unlockMs = nowMs() - t0;
        if (!ok) return Promise.resolve();
      }
      const ctx = this.ctx;
      if (!ctx || ctx.state === 'closed') return Promise.resolve();
      this.kick(ctx);
      if (ctx.state === 'running') return Promise.resolve();
      const p = ctx.resume() as Promise<void> | undefined; // very old WebKit returned nothing
      return p ? p.then(
        () => undefined,
        () => undefined,
      ) : Promise.resolve();
    } catch (e) {
      this.warn(e);
      return Promise.resolve();
    }
  }

  play(id: SfxId, opts?: PlayOpts): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxBus || ctx.state !== 'running') return;
    try {
      this.playVoice(ctx, this.sfxBus, id, opts ?? {});
    } catch (e) {
      this.warn(e);
    }
  }

  music(track: MusicTrack, fadeSeconds?: number): void {
    const fade = clamp(finite(fadeSeconds, DEFAULT_FADE), 0, 30);
    const t: MusicTrack = track === 'menu' || track === 'battle' || track === 'tension' ? track : null;
    if (!this.musicEngine) {
      this.wantMusic = { track: t, fade };
      return;
    }
    try {
      this.musicEngine.play(t, fade);
    } catch (e) {
      this.warn(e);
    }
  }

  setVolume(kind: VolKind, v: number): void {
    if (!VOL_KINDS.includes(kind)) return;
    this.vol[kind] = clamp(finite(v, 0), 0, 1);
    saveVolumes(this.vol);
    this.applyVolume(kind);
  }

  getVolume(kind: VolKind): number {
    return VOL_KINDS.includes(kind) ? this.vol[kind] : 0;
  }

  duck(amount: number, seconds: number): void {
    const ctx = this.ctx;
    const node = this.duckGain;
    if (!ctx || !node) return;
    try {
      const now = ctx.currentTime;
      const lvl = clamp(finite(amount, 1), 0, 1);
      const secs = clamp(finite(seconds, 0), 0, 120);
      this.duckLevel = now < this.duckUntil ? Math.min(this.duckLevel, lvl) : lvl;
      this.duckUntil = Math.max(this.duckUntil, now + secs);
      const p = node.gain;
      const cur = p.value;
      p.cancelScheduledValues(now);
      p.setValueAtTime(cur, now);
      p.setTargetAtTime(this.duckLevel, now, 0.06);
      p.setTargetAtTime(1, this.duckUntil, 0.35);
    } catch (e) {
      this.warn(e);
    }
  }

  setSlowmo(rate: number): void {
    const r = finite(rate, 1);
    this.slowmo = r > 0 ? clamp(r, 0.1, 2) : 1;
    this.applySlowmo();
  }

  debug(): AudioDebugInfo {
    return {
      supported: this.supported,
      state: this.ctx ? this.ctx.state : 'none',
      sampleRate: this.ctx ? this.ctx.sampleRate : 0,
      sfxRendered: this.sfxRendered,
      sfxTotal: this.sfxTotal,
      sfxRenderMs: Math.round(this.sfxRenderMs),
      sfxRenderWhere: this.sfxRenderWhere,
      musicReady: this.musicEngine?.ready ?? false,
      musicRenderMs: Math.round(this.musicEngine?.renderMs ?? 0),
      musicRenderWhere: this.musicEngine?.renderWhere ?? null,
      unlockMs: Math.round(this.unlockMs),
      musicTrack: this.musicEngine ? this.musicEngine.track : (this.wantMusic?.track ?? null),
      voices: this.voices.length,
      slowmo: this.slowmo,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // setup

  private create(): boolean {
    if (typeof window === 'undefined') {
      this.supported = false;
      return false;
    }
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) {
      this.supported = false;
      return false;
    }
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      ctx = new Ctor();
    }
    this.ctx = ctx;
    try {
      this.buildGraph(ctx);
    } catch (e) {
      this.warn(e);
      this.ctx = null;
      this.master = null;
      this.sfxBus = null;
      this.musicEngine = null;
      void ctx.close().catch(() => undefined);
      this.supported = false;
      return false;
    }
    this.installListeners(ctx);
    this.startBackgroundRender(ctx);
    const want = this.wantMusic;
    this.wantMusic = null;
    if (want && this.musicEngine) this.musicEngine.play(want.track, want.fade);
    return true;
  }

  private buildGraph(ctx: AudioContext): void {
    const master = ctx.createGain();
    master.gain.value = volGain(this.vol.master);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 6;
    comp.ratio.value = 10;
    comp.attack.value = 0.002;
    comp.release.value = 0.2;
    const clip = ctx.createWaveShaper();
    clip.curve = softClipCurve();
    master.connect(comp);
    comp.connect(clip);
    clip.connect(ctx.destination);

    const sfxBus = ctx.createGain();
    sfxBus.gain.value = volGain(this.vol.sfx);
    sfxBus.connect(master);

    const reverbIn = ctx.createGain();
    const conv = ctx.createConvolver();
    conv.normalize = false;
    const ret = ctx.createGain();
    ret.gain.value = 0.5;
    reverbIn.connect(conv);
    conv.connect(ret);
    ret.connect(master);

    const sfxSend = ctx.createGain();
    sfxSend.gain.value = volGain(this.vol.sfx);
    sfxSend.connect(reverbIn);

    const musicVol = ctx.createGain();
    musicVol.gain.value = volGain(this.vol.music);
    const duck = ctx.createGain();
    const mf = ctx.createBiquadFilter();
    mf.type = 'lowpass';
    mf.frequency.value = Math.min(20000, ctx.sampleRate * 0.45);
    mf.Q.value = 0.5;
    musicVol.connect(duck);
    duck.connect(mf);
    mf.connect(master);
    const musicSend = ctx.createGain();
    musicSend.gain.value = 0.22;
    mf.connect(musicSend);
    musicSend.connect(reverbIn);

    this.master = master;
    this.sfxBus = sfxBus;
    this.sfxSend = sfxSend;
    this.musicVol = musicVol;
    this.duckGain = duck;
    this.musicFilter = mf;
    this.convolver = conv;
    this.hasPanner = typeof ctx.createStereoPanner === 'function';
    this.musicEngine = new MusicEngine(ctx, musicVol);
    this.applySlowmo();
  }

  private installListeners(ctx: AudioContext): void {
    if (typeof document === 'undefined') return;
    // iOS / Safari can leave the context 'suspended' or 'interrupted' (calls, app switch):
    // retry resume on later gestures.
    const resume = (): void => {
      if (this.hiddenSuspended || ctx.state === 'running' || ctx.state === 'closed') return;
      this.kick(ctx);
      void ctx.resume().catch(() => undefined);
    };
    for (const ev of ['pointerdown', 'touchend', 'mousedown', 'keydown']) {
      document.addEventListener(ev, resume, { capture: true, passive: true });
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (ctx.state === 'running') {
          this.hiddenSuspended = true;
          void ctx.suspend().catch(() => undefined);
        }
      } else if (this.hiddenSuspended) {
        this.hiddenSuspended = false;
        void ctx.resume().catch(() => undefined);
      }
    });
  }

  /** Plays a 1-sample silent buffer: unlocks audio output on iOS when called inside a gesture. */
  private kick(ctx: AudioContext): void {
    try {
      const b = ctx.createBuffer(1, 1, ctx.sampleRate);
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.connect(ctx.destination);
      s.start(0);
      s.onended = () => s.disconnect();
    } catch {
      /* ignore */
    }
  }

  private startBackgroundRender(ctx: AudioContext): void {
    const jobs: RenderJob[] = [{ kind: 'ir' }];
    const order: SfxId[] = [...PRIORITY, ...SFX_IDS.filter((id) => !PRIORITY.includes(id))];
    for (const id of order) {
      for (let v = 0; v < SFX_DEFS[id].variants; v++) jobs.push({ kind: 'sfx', id, v });
    }
    renderInBackground(
      ctx.sampleRate,
      jobs,
      (job, r) => {
        if (job.kind === 'ir') {
          const [l, rch] = r.chans;
          const b = ctx.createBuffer(2, l.length, r.rate);
          b.getChannelData(0).set(l);
          b.getChannelData(1).set(rch ?? l);
          if (this.convolver) this.convolver.buffer = b;
        } else if (job.kind === 'sfx') {
          this.storeVariant(ctx, job.id, job.v, r.chans[0], r.heavy, r.rate, r.ms);
        }
      },
      (_cpu, where) => {
        this.sfxRenderWhere = where;
      },
    );
  }

  private getSet(id: SfxId): SfxSet {
    let s = this.sets.get(id);
    if (!s) {
      const n = SFX_DEFS[id].variants;
      s = { main: new Array<AudioBuffer | null>(n).fill(null), heavy: new Array<AudioBuffer | null>(n).fill(null) };
      this.sets.set(id, s);
    }
    return s;
  }

  /** Synchronous render on the main thread (only for sounds requested before they arrived). */
  private renderVariant(ctx: AudioContext, id: SfxId, v: number): void {
    if (this.getSet(id).main[v]) return;
    const t0 = nowMs();
    const out = renderSfx(id, ctx.sampleRate, v);
    this.storeVariant(ctx, id, v, out.main, out.heavy, out.rate, nowMs() - t0);
  }

  private storeVariant(ctx: AudioContext, id: SfxId, v: number, main: Float32Array, heavy: Float32Array | null, rate: number, ms: number): void {
    const set = this.getSet(id);
    if (set.main[v]) return;
    set.main[v] = toBuffer(ctx, main, rate);
    set.heavy[v] = heavy ? toBuffer(ctx, heavy, rate) : null;
    this.sfxRenderMs += ms;
    this.sfxRendered++;
  }

  // ---------------------------------------------------------------------------------------------
  // SFX voices

  private playVoice(ctx: AudioContext, bus: GainNode, id: SfxId, o: PlayOpts): void {
    const d = SFX_DEFS[id];
    if (!d) return;
    const now = ctx.currentTime;
    const last = this.lastStart.get(id);
    if (last !== undefined && now >= last && now - last < RETRIGGER_GAP) return;
    this.lastStart.set(id, now);

    const set = this.getSet(id);
    const avail: number[] = [];
    for (let i = 0; i < set.main.length; i++) if (set.main[i]) avail.push(i);
    if (!avail.length) {
      this.renderVariant(ctx, id, 0); // not pre-rendered yet: render synchronously
      avail.push(0);
    }
    const prev = this.lastVariant.get(id);
    const choices = avail.length > 1 ? avail.filter((i) => i !== prev) : avail;
    const v = choices[Math.floor(this.rnd() * choices.length)];
    this.lastVariant.set(id, v);
    const main = set.main[v];
    if (!main) return;
    // heavy layers are shared between variations: pick any rendered one
    let heavy: AudioBuffer | null = null;
    if (d.dyn) {
      const hs = set.heavy.filter((b): b is AudioBuffer => b !== null);
      if (hs.length) heavy = hs[Math.floor(this.rnd() * hs.length)];
    }

    const intensity = clamp(finite(o.intensity, DEFAULT_INTENSITY), 0, 1);
    let gain = clamp(finite(o.volume, 1), 0, 4) * dbToGain((this.rnd() - 0.5) * 1.6);
    let rate = clamp(finite(o.pitch, 1), 0.25, 4) * Math.pow(2, ((this.rnd() * 2 - 1) * d.jitter) / 1200);
    if (d.slowmo) rate *= this.slowmo;
    let heavyGain = 0;
    let cutoff = 0;
    if (d.dyn) {
      gain *= 0.55 + 0.7 * intensity;
      heavyGain = heavy ? heavyGainFor(intensity) : 0;
      rate *= 1.06 - 0.12 * intensity;
      const u = 1 - intensity;
      cutoff = d.brightMin * Math.pow(20000 / d.brightMin, 1 - u * u);
    }
    if (gain < 1e-4) return;
    rate = clamp(rate, 0.0625, 8);

    this.pruneVoices(now);
    this.stealIfNeeded(id, now);

    const vg = ctx.createGain();
    vg.gain.value = gain;
    const nodes: AudioNode[] = [vg];
    const srcs: AudioBufferSourceNode[] = [];
    const src = ctx.createBufferSource();
    src.buffer = main;
    src.playbackRate.value = rate;
    src.connect(vg);
    srcs.push(src);
    let longest = src;
    let dur = main.duration;
    if (heavy && heavyGain > 0.01) {
      const hs = ctx.createBufferSource();
      hs.buffer = heavy;
      hs.playbackRate.value = rate;
      const hg = ctx.createGain();
      hg.gain.value = heavyGain;
      hs.connect(hg);
      hg.connect(vg);
      srcs.push(hs);
      nodes.push(hg);
      if (heavy.duration > dur) {
        dur = heavy.duration;
        longest = hs;
      }
    }
    let tail: AudioNode = vg;
    if (cutoff > 0 && cutoff < 17000) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = cutoff;
      f.Q.value = 0.6;
      tail.connect(f);
      tail = f;
      nodes.push(f);
    }
    const pan = clamp(finite(o.pan, 0), -1, 1);
    if (pan !== 0 && this.hasPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      tail.connect(p);
      tail = p;
      nodes.push(p);
    }
    tail.connect(bus);
    if (d.reverb > 0 && this.sfxSend) {
      const s = ctx.createGain();
      s.gain.value = d.reverb;
      tail.connect(s);
      s.connect(this.sfxSend);
      nodes.push(s);
    }
    const voice: Voice = { id, end: now + dur / rate, srcs, vg, nodes };
    longest.onended = () => {
      for (const s of srcs) s.disconnect();
      for (const n of nodes) n.disconnect();
    };
    for (const s of srcs) s.start(now);
    this.voices.push(voice);
  }

  private pruneVoices(now: number): void {
    if (this.voices.length) this.voices = this.voices.filter((v) => v.end > now);
  }

  private stealIfNeeded(id: SfxId, now: number): void {
    let same = 0;
    for (const v of this.voices) if (v.id === id) same++;
    if (same >= MAX_PER_ID) {
      const i = this.voices.findIndex((v) => v.id === id);
      if (i >= 0) this.stopVoice(this.voices.splice(i, 1)[0], now);
    }
    while (this.voices.length >= MAX_VOICES) {
      const v = this.voices.shift();
      if (v) this.stopVoice(v, now);
    }
  }

  private stopVoice(v: Voice, now: number): void {
    try {
      v.vg.gain.cancelScheduledValues(now);
      v.vg.gain.setTargetAtTime(0, now, 0.015);
      for (const s of v.srcs) s.stop(now + 0.1);
    } catch {
      /* already stopped */
    }
  }

  // ---------------------------------------------------------------------------------------------
  // parameters

  private applyVolume(kind: VolKind): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const g = volGain(this.vol[kind]);
    const now = ctx.currentTime;
    const targets: (GainNode | null)[] =
      kind === 'master' ? [this.master] : kind === 'sfx' ? [this.sfxBus, this.sfxSend] : [this.musicVol];
    for (const n of targets) n?.gain.setTargetAtTime(g, now, 0.03);
  }

  private applySlowmo(): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicFilter) return;
    const r = this.slowmo;
    const now = ctx.currentTime;
    const top = Math.min(20000, ctx.sampleRate * 0.45);
    this.musicFilter.frequency.setTargetAtTime(r < 0.999 ? Math.min(top, 500 + 9000 * r * r) : top, now, 0.12);
    this.musicEngine?.setRate(r);
  }

  private warn(e: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn('[audio] disabled feature after error:', e);
  }
}

const engine = new Engine();

export const audio: AudioEngine = engine;

/** Dev/diagnostics only (audio-test page): render timings, context state, voice count. */
export function audioDebugInfo(): AudioDebugInfo {
  return engine.debug();
}
