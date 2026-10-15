import { describe, expect, it } from 'vitest';
import { RollbackSession, NetChannel } from '../src/net/rollback';
import { createMatch, hashMatch, step } from '../src/sim/sim';
import { IN } from '../src/sim/defs';

class FakeNet {
  queue: { at: number; to: number; msg: unknown }[] = [];
  now = 0;
  ends: NetChannel[] = [];
  constructor(public minLat: number, public jitter: number, seed: number) {
    let x = seed;
    this.rand = () => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 4294967296);
    for (let i = 0; i < 2; i++) {
      const idx = i;
      this.ends.push({
        onMessage: null,
        send: (msg: unknown) => {
          const lat = this.minLat + Math.floor(this.rand() * this.jitter);
          this.queue.push({ at: this.now + lat, to: 1 - idx, msg: JSON.parse(JSON.stringify(msg)) });
        },
      });
    }
  }
  rand: () => number;
  deliver() {
    const due = this.queue.filter((q) => q.at <= this.now);
    this.queue = this.queue.filter((q) => q.at > this.now);
    // shuffle to simulate unordered delivery
    due.sort(() => this.rand() - 0.5);
    for (const q of due) this.ends[q.to].onMessage?.(q.msg);
  }
}

function masher(seed: number) {
  let x = seed >>> 0;
  const r = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0);
  const bits = [IN.UP, IN.DOWN, IN.LEFT, IN.RIGHT, IN.S, IN.H, IN.G, IN.D, IN.A, IN.X];
  let cur = 0, hold = 0;
  return () => {
    if (hold-- <= 0) {
      cur = 0;
      for (const b of bits) if ((r() & 7) === 0) cur |= b;
      hold = 2 + (r() % 8);
    }
    return cur;
  };
}

describe('rollback netcode', () => {
  for (const [lat, jit] of [[1, 2], [4, 6], [7, 4]]) {
    it(`converges to the reference simulation (latency ${lat}+${jit} frames)`, () => {
      const net = new FakeNet(lat, jit, 99 + lat);
      const cfg = { p1: 0, p2: 2, seed: 1234 };
      const a = new RollbackSession(cfg, 0, net.ends[0], 2);
      const b = new RollbackSession(cfg, 1, net.ends[1], 2);
      a.now = b.now = () => net.now * (1000 / 60);
      const ia = masher(3), ib = masher(4);
      for (let t = 0; t < 2500; t++) {
        net.now = t;
        net.deliver();
        a.tick(t < 2400 ? ia() : 0);
        b.tick(t < 2400 ? ib() : 0);
      }
      // drain
      for (let t = 2500; t < 2800; t++) {
        net.now = t;
        net.deliver();
        a.tick(0);
        b.tick(0);
      }
      // reference run with the exact inputs each side committed
      const ref = createMatch(cfg);
      const upto = Math.min(a.remoteKnown, b.remoteKnown, a.frame, b.frame) - 1;
      expect(upto).toBeGreaterThan(2300);
      const refHash: number[] = [];
      for (let fr = 0; fr <= upto; fr++) {
        step(ref, a.localIn[fr] ?? 0, b.localIn[fr] ?? 0);
        refHash.push(hashMatch(ref));
      }
      expect(a.stats.desync).toBe(false);
      expect(b.stats.desync).toBe(false);
      // resimulate each session's confirmed history to compare the final confirmed frame
      const ra = createMatch(cfg);
      for (let fr = 0; fr <= upto; fr++) step(ra, a.localIn[fr] ?? 0, a.remoteIn[fr] ?? 0);
      const rb = createMatch(cfg);
      for (let fr = 0; fr <= upto; fr++) step(rb, b.remoteIn[fr] ?? 0, b.localIn[fr] ?? 0);
      expect(hashMatch(ra)).toBe(refHash[upto]);
      expect(hashMatch(rb)).toBe(refHash[upto]);
      // and the live states agree with each other after draining
      expect(a.frame).toBe(b.frame);
      expect(hashMatch(a.state)).toBe(hashMatch(b.state));
    });
  }
});
