import { describe, expect, it } from 'vitest';
import { createMatch, step } from '../src/sim/sim';
import { PH } from '../src/sim/defs';
import { AIController, Difficulty } from '../src/ai/ai';
import { CHARS } from '../src/sim/chars';

describe('AI vs AI', () => {
  for (let a = 0; a < CHARS.length; a++) {
    for (let b = 0; b < CHARS.length; b++) {
      it(`${CHARS[a].id} vs ${CHARS[b].id} finishes a match with real exchanges`, () => {
        const s = createMatch({ p1: a, p2: b, seed: 1000 + a * 7 + b });
        const x = new AIController(0, ((a + b) % 4) as Difficulty);
        const y = new AIController(1, 3);
        let hits = 0;
        let n = 0;
        while (s.phase !== PH.MATCH_END && n < 60 * 60 * 8) {
          step(s, x.read(s), y.read(s));
          hits += s.events.filter((e) => e.t === 'hit').length;
          n++;
        }
        expect(s.phase).toBe(PH.MATCH_END);
        expect(hits).toBeGreaterThan(10);
      });
    }
  }
});
