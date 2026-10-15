// GGPO-style rollback session over an abstract message channel.
import { Match, MatchConfig, cloneMatch, createMatch, hashMatch, step } from '../sim/sim';
import { SimEvent } from '../sim/defs';

export interface NetChannel {
  send(msg: unknown): void;
  onMessage: ((msg: any) => void) | null;
}

export interface RollbackStats {
  rtt: number;
  rollbacks: number;
  maxRollback: number;
  stalls: number;
  delay: number;
  adv: number;
  desync: boolean;
}

const MAX_PRED = 9;
const HIST = 64;

export class RollbackSession {
  state: Match;
  frame = 0; // number of frames simulated == state.frame
  local: number;
  delay: number;
  localIn: number[] = [];
  remoteIn: number[] = [];
  remoteKnown = -1; // highest contiguous confirmed remote frame
  remoteSeenMax = -1;
  lastRemote = 0; // last confirmed remote input (prediction)
  usedRemote: number[] = []; // remote inputs actually used when simulating each frame
  saved: (Match | null)[] = new Array(HIST).fill(null);
  ackedByRemote = -1;
  remoteFrame = 0;
  lastRecv = performance.now();
  rttMs = 80;
  advAvg = 0;
  stats: RollbackStats = { rtt: 0, rollbacks: 0, maxRollback: 0, stalls: 0, delay: 0, adv: 0, desync: false };
  pingSeq = 0;
  pings = new Map<number, number>();
  hashes = new Map<number, number>();
  remoteHashes = new Map<number, number>();
  confirmedSim = -1;
  onDesync: (() => void) | null = null;
  remoteAdv = 0;
  now: () => number = () => performance.now();

  constructor(cfg: MatchConfig, localSide: number, public ch: NetChannel, delay = 2) {
    this.state = createMatch(cfg);
    this.local = localSide;
    this.delay = delay;
    this.stats.delay = delay;
    ch.onMessage = (m) => this.recv(m);
  }

  private recv(m: any): void {
    this.lastRecv = this.now();
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'i': {
        const first: number = m.f;
        const arr: number[] = m.i;
        for (let k = 0; k < arr.length; k++) {
          const fr = first + k;
          if (this.remoteIn[fr] === undefined) this.remoteIn[fr] = arr[k];
        }
        while (this.remoteIn[this.remoteKnown + 1] !== undefined) this.remoteKnown++;
        if (this.remoteKnown >= 0) this.lastRemote = this.remoteIn[this.remoteKnown];
        this.ackedByRemote = Math.max(this.ackedByRemote, m.a);
        this.remoteFrame = Math.max(this.remoteFrame, m.c);
        if (typeof m.v === 'number') this.remoteAdv = m.v;
        break;
      }
      case 'ping':
        this.ch.send({ t: 'pong', s: m.s });
        break;
      case 'pong': {
        const t0 = this.pings.get(m.s);
        if (t0 !== undefined) {
          const rtt = this.now() - t0;
          this.rttMs = this.rttMs * 0.8 + rtt * 0.2;
          this.stats.rtt = Math.round(this.rttMs);
          this.pings.delete(m.s);
        }
        break;
      }
      case 'h':
        this.remoteHashes.set(m.f, m.h);
        this.checkHash(m.f);
        break;
    }
  }

  private checkHash(f: number): void {
    const a = this.hashes.get(f);
    const b = this.remoteHashes.get(f);
    if (a !== undefined && b !== undefined && a !== b && !this.stats.desync) {
      this.stats.desync = true;
      console.warn('[rollback] desync at frame', f, a, b);
      this.onDesync?.();
    }
  }

  private remoteFor(fr: number): number {
    const v = this.remoteIn[fr];
    return v !== undefined ? v : this.lastRemote;
  }

  private simulate(fr: number, collect: boolean): SimEvent[] | null {
    this.saved[fr % HIST] = cloneMatch(this.state);
    const li = this.localIn[fr] ?? 0;
    const ri = this.remoteFor(fr);
    this.usedRemote[fr] = ri;
    if (this.local === 0) step(this.state, li, ri);
    else step(this.state, ri, li);
    this.frame = this.state.frame;
    // confirmed-state hashing for desync detection
    if (fr <= this.remoteKnown && fr > this.confirmedSim) {
      this.confirmedSim = fr;
      if (fr % 60 === 0) {
        const h = hashMatch(this.state);
        this.hashes.set(fr, h);
        this.ch.send({ t: 'h', f: fr, h });
        this.checkHash(fr);
        if (this.hashes.size > 40) {
          const k = this.hashes.keys().next().value as number;
          this.hashes.delete(k);
          this.remoteHashes.delete(k);
        }
      }
    }
    return collect ? this.state.events.slice() : null;
  }

  /** Called once per 60 Hz tick with the local hardware input. Returns events to present (may be empty). */
  tick(localBits: number): { events: SimEvent[]; advanced: number } {
    const cur = this.frame; // next frame to simulate
    // 1. store delayed local input
    if (this.localIn[cur + this.delay] === undefined) this.localIn[cur + this.delay] = localBits;
    for (let k = 0; k < this.delay; k++) if (this.localIn[k] === undefined) this.localIn[k] = 0;
    // 2. send inputs (redundant window)
    const from = Math.max(0, this.ackedByRemote + 1, cur + this.delay - 40);
    const arr: number[] = [];
    for (let fr = from; fr <= cur + this.delay; fr++) arr.push(this.localIn[fr] ?? 0);
    this.ch.send({ t: 'i', f: from, i: arr, a: this.remoteKnown, c: cur, v: Math.round(this.advAvg * 10) / 10 });
    if (cur % 30 === 0) {
      const s = ++this.pingSeq;
      this.pings.set(s, this.now());
      this.ch.send({ t: 'ping', s });
    }
    // 3. rollback if any mispredicted frame got confirmed
    let firstBad = -1;
    for (let fr = Math.max(0, cur - HIST + 1); fr < cur; fr++) {
      const real = this.remoteIn[fr];
      if (real !== undefined && this.usedRemote[fr] !== undefined && this.usedRemote[fr] !== real) {
        firstBad = fr;
        break;
      }
    }
    if (firstBad >= 0) {
      const snap = this.saved[firstBad % HIST];
      if (snap && snap.frame === firstBad) {
        this.state = cloneMatch(snap);
        const n = cur - firstBad;
        this.stats.rollbacks++;
        this.stats.maxRollback = Math.max(this.stats.maxRollback, n);
        for (let fr = firstBad; fr < cur; fr++) this.simulate(fr, false);
      }
    }
    // 4. time sync: don't run too far ahead of the remote
    const rttFrames = this.rttMs / 2 / (1000 / 60);
    const adv = cur - (this.remoteFrame + rttFrames);
    this.advAvg = this.advAvg * 0.95 + adv * 0.05;
    this.stats.adv = Math.round(this.advAvg * 10) / 10;
    if (cur - this.remoteKnown > MAX_PRED) {
      this.stats.stalls++;
      return { events: [], advanced: 0 };
    }
    // GGPO-style: only the side that is genuinely ahead waits (symmetric estimate errors cancel out)
    const lead = (this.advAvg - this.remoteAdv) / 2;
    if (lead > 1 && cur % 6 === 0) {
      this.stats.stalls++;
      return { events: [], advanced: 0 };
    }
    // 5. simulate the new frame
    const events = this.simulate(cur, true) ?? [];
    return { events, advanced: 1 };
  }

  /** seconds since we heard from the peer */
  silence(): number {
    return (this.now() - this.lastRecv) / 1000;
  }
}
