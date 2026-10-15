import { describe, expect, it } from 'vitest';
import { createMatch, step } from '../src/sim/sim';
import { IN, PH, ST, m } from '../src/sim/defs';
import { CHARS } from '../src/sim/chars';

describe('secret arts', () => {
  for (let ch = 0; ch < CHARS.length; ch++) {
    it(`${CHARS[ch].id}: secret connects, runs its cinematic once and ends`, () => {
      const s = createMatch({ p1: ch, p2: 2, seed: 3, skipIntro: true });
      for (let i = 0; i < 90 && s.phase !== PH.FIGHT; i++) step(s, 0, 0);
      s.f[0].x = -m(0.6);
      s.f[1].x = m(0.6);
      s.f[0].qi = 300;
      step(s, IN.X, 0);
      let hits = 0;
      let maxHitsPerFrame = 0;
      let connected = false;
      let finished = false;
      for (let i = 0; i < 400; i++) {
        step(s, 0, 0);
        const h = s.events.filter((e) => e.t === 'hit').length;
        hits += h;
        maxHitsPerFrame = Math.max(maxHitsPerFrame, h);
        if (s.events.some((e) => e.t === 'secret' && e.phase === 'connect')) connected = true;
        if (s.events.some((e) => e.t === 'secret' && e.phase === 'finish')) finished = true;
      }
      expect(connected).toBe(true);
      expect(finished).toBe(true);
      expect(maxHitsPerFrame).toBeLessThanOrEqual(1);
      const md = CHARS[ch].moves.secret;
      expect(hits).toBe(md.cine!.hitFrames.length + 1);
      expect(s.cine).toBe(-1);
      expect(s.f[0].st).not.toBe(ST.ATTACK);
    });
  }
});
