import { describe, expect, it } from 'vitest';
import { createMatch, step, cloneMatch, hashMatch, Match } from '../src/sim/sim';
import { IN, PH, ST, m } from '../src/sim/defs';

function lcg(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x;
  };
}

/** Pseudo-random "mashing" inputs that hold for a few frames. */
function masher(seed: number) {
  const r = lcg(seed);
  let cur = 0;
  let hold = 0;
  const bits = [IN.UP, IN.DOWN, IN.LEFT, IN.RIGHT, IN.S, IN.H, IN.G, IN.D, IN.A, IN.X];
  return () => {
    if (hold-- <= 0) {
      cur = 0;
      for (const b of bits) if ((r() & 7) === 0) cur |= b;
      if ((r() & 3) === 0) cur |= r() & 1 ? IN.RIGHT : IN.LEFT;
      hold = 2 + (r() % 9);
    }
    return cur;
  };
}

function run(s: Match, frames: number, a: () => number, b: () => number, hashes?: number[]) {
  for (let i = 0; i < frames; i++) {
    step(s, a(), b());
    hashes?.push(hashMatch(s));
  }
}

describe('sim determinism', () => {
  for (const [p1, p2] of [[0, 1], [1, 2], [2, 0], [0, 0]]) {
    it(`same inputs => same states (${p1} vs ${p2})`, () => {
      const h1: number[] = [];
      const h2: number[] = [];
      run(createMatch({ p1, p2, seed: 42 }), 6000, masher(1), masher(2), h1);
      run(createMatch({ p1, p2, seed: 42 }), 6000, masher(1), masher(2), h2);
      expect(h1).toEqual(h2);
    });
  }

  it('clone + resume equals continuous run (rollback safety)', () => {
    const a1 = masher(5), b1 = masher(6);
    const ref: number[] = [];
    run(createMatch({ p1: 0, p2: 2, seed: 7 }), 4000, a1, b1, ref);
    const a2 = masher(5), b2 = masher(6);
    const s = createMatch({ p1: 0, p2: 2, seed: 7 });
    const got: number[] = [];
    let snap: Match | null = null;
    const inputs: [number, number][] = [];
    for (let i = 0; i < 4000; i++) {
      const ia = a2(), ib = b2();
      inputs.push([ia, ib]);
      if (i === 1500) snap = cloneMatch(s);
      step(s, ia, ib);
      got.push(hashMatch(s));
    }
    // resimulate from snapshot
    const r = snap!;
    for (let i = 1500; i < 4000; i++) step(r, inputs[i][0], inputs[i][1]);
    expect(hashMatch(r)).toEqual(ref[3999]);
    expect(got).toEqual(ref);
  });
});

describe('combat sanity', () => {
  function fightReady(p1 = 0, p2 = 0): Match {
    const s = createMatch({ p1, p2, seed: 1, skipIntro: true });
    for (let i = 0; i < 90 && s.phase !== PH.FIGHT; i++) step(s, 0, 0);
    expect(s.phase).toBe(PH.FIGHT);
    return s;
  }

  it('walks forward and jab connects at close range', () => {
    const s = fightReady();
    s.f[0].x = -m(0.35);
    s.f[1].x = m(0.35);
    const hp = s.f[1].hp;
    step(s, IN.S, 0);
    for (let i = 0; i < 12; i++) step(s, 0, 0);
    expect(s.f[1].hp).toBeLessThan(hp);
  });

  it('guard blocks a jab, focus crushes guard', () => {
    const s = fightReady();
    s.f[0].x = -m(0.35);
    s.f[1].x = m(0.35);
    for (let i = 0; i < 12; i++) step(s, 0, IN.G); // hold guard (past deflect window)
    const hp = s.f[1].hp;
    step(s, IN.S, IN.G);
    for (let i = 0; i < 12; i++) step(s, 0, IN.G);
    expect(s.f[1].hp).toBe(hp);
    // focus: hold heavy ~30 frames then release
    for (let i = 0; i < 30; i++) step(s, IN.H, IN.G);
    for (let i = 0; i < 20; i++) step(s, 0, IN.G);
    expect(s.f[1].hp).toBeLessThan(hp);
  });

  it('a tapped guard right before impact deflects and staggers the attacker', () => {
    const s = fightReady();
    s.f[0].x = -m(0.35);
    s.f[1].x = m(0.35);
    step(s, IN.H, 0); // heavy startup 14
    for (let i = 0; i < 9; i++) step(s, 0, 0);
    step(s, 0, IN.G); // press guard ~4 frames before impact
    let deflected = false;
    for (let i = 0; i < 10; i++) {
      step(s, 0, IN.G);
      if (s.events.some((e) => e.t === 'deflect')) deflected = true;
    }
    expect(deflected).toBe(true);
    expect(s.f[0].st).toBe(ST.STAGGER);
  });

  it('freestyle chain: jab -> cross -> launcher combo builds flow', () => {
    const s = fightReady();
    s.f[0].x = -m(0.35);
    s.f[1].x = m(0.35);
    const seq = [IN.S, 0, 0, 0, 0, 0, 0, IN.S, 0, 0, 0, 0, 0, 0, 0, IN.S | IN.UP];
    for (let i = 0; i < 20; i++) seq.push(i < 14 ? IN.UP : 0);
    for (const k of seq) step(s, k, 0);
    expect(s.f[1].comboHits).toBeGreaterThanOrEqual(3);
    expect(s.f[1].comboUnique).toBeGreaterThanOrEqual(3);
    expect(s.f[1].y).toBeGreaterThan(0);
  });

  it('UPMOD aims a launcher without ever jumping', () => {
    const s = fightReady();
    s.f[0].x = -m(0.35);
    s.f[1].x = m(0.35);
    for (let i = 0; i < 6; i++) step(s, IN.UPMOD, 0);
    expect(s.f[0].st).not.toBe(ST.JUMPSQUAT);
    expect(s.f[0].y).toBe(0);
    step(s, IN.UPMOD | IN.S, 0);
    for (let i = 0; i < 12; i++) step(s, IN.UPMOD, 0);
    expect(s.f[1].y).toBeGreaterThan(0); // launched by s_u
  });

  it('a full random match always terminates with a winner', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const s = createMatch({ p1: seed % 3, p2: (seed + 1) % 3, seed });
      const a = masher(seed * 11), b = masher(seed * 13);
      let n = 0;
      while (s.phase !== PH.MATCH_END && n < 60 * 60 * 6) {
        step(s, a(), b());
        n++;
      }
      expect(s.phase).toBe(PH.MATCH_END);
      expect(s.matchWinner === 0 || s.matchWinner === 1).toBe(true);
    }
  });
});
