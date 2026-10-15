import { describe, expect, it } from 'vitest';
import { BoutCore, BoutSnapshot } from '../src/arena/bout';
import { TECH_NAMES } from '../src/arena/pilot';
import { rleDecode, rleEncode } from '../src/arena/rle';
import { HumanClaim, VerifyJob, houseSeed, rankedHouseAI } from '../src/arena/replay';
import { AIController } from '../src/ai/ai';
import { PH } from '../src/sim/defs';
import { createMatch, hashMatch, step } from '../src/sim/sim';

/** Tiny scripted agent: mostly sensible choices, deterministic for a seed. */
function scripted(seed: number) {
  let r = seed >>> 0 || 1;
  const rnd = () => {
    r ^= r << 13; r >>>= 0; r ^= r >>> 17; r ^= r << 5; r >>>= 0;
    return r / 4294967296;
  };
  return (legal: string[], dist: number, tags: string[]): string[] => {
    if (legal.includes('burst')) return [rnd() < 0.5 ? 'burst' : 'endure'];
    if (legal.includes('secret') && dist < 1.2) return ['secret'];
    if (tags.includes('opponent_open') || tags.includes('opponent_recovering')) return ['launcher_combo'];
    if (tags.includes('opponent_attacking')) return [rnd() < 0.5 ? 'deflect' : 'guard'];
    if (dist > 2.5) return rnd() < 0.5 ? ['dash_in'] : ['advance', 'advance'];
    const pool = legal.filter((a) => a !== 'wait');
    return [pool[(rnd() * pool.length) | 0]];
  };
}

function playBout(b: BoutCore, agents: ((l: string[], d: number, t: string[]) => string[])[], persist = false): { b: BoutCore; inputs: number[][]; decisions: number } {
  const inputs: number[][] = [[], []];
  const take = () => {
    const c = b.drainLog();
    expect(c.f0).toBe(inputs[0].length);
    inputs[0].push(...rleDecode(c.runs[0]));
    inputs[1].push(...rleDecode(c.runs[1]));
  };
  b.advance();
  take();
  let decisions = 0;
  let guard = 0;
  while (!b.finished && guard++ < 5000) {
    for (const side of b.awaiting()) {
      const v = b.view(side);
      expect(v.status).toBe('your_turn');
      b.submit(side, agents[side](v.legal, v.state.distance, v.state.tags), 'hm');
      decisions++;
    }
    take();
    if (persist) {
      // simulate the server persisting and reloading between every turn
      const snap: BoutSnapshot = JSON.parse(JSON.stringify(b.snapshot()));
      b = new BoutCore(snap.init, snap);
    }
  }
  return { b, inputs, decisions };
}

describe('arena', () => {
  it('rle round-trips', () => {
    const bits = [0, 0, 0, 5, 5, 64, 0, 0, 1];
    expect(rleDecode(rleEncode(bits))).toEqual(bits);
  });

  it('seeded house AI is deterministic', () => {
    const run = () => {
      const s = createMatch({ p1: 0, p2: 2, seed: 77 });
      const a = new AIController(0, 3, 5);
      const b = rankedHouseAI(77, 2);
      for (let i = 0; i < 3000; i++) step(s, a.read(s), b.read(s));
      return hashMatch(s);
    };
    expect(run()).toBe(run());
  });

  it('agent vs house bout finishes and replays exactly from its input log', () => {
    const b0 = new BoutCore({
      seed: 4242, p1: 0, p2: 1,
      sides: [{ kind: 'agent', id: 'e_a', label: 'A: Test' }, { kind: 'house', id: null, label: 'House', level: 2 }],
    });
    const { b, inputs, decisions } = playBout(b0, [scripted(9)]);
    expect(b.finished).toBe(true);
    expect(b.winner).toBeGreaterThanOrEqual(0);
    expect(decisions).toBeGreaterThan(20);
    // replay from inputs only
    const s = createMatch({ p1: 0, p2: 1, seed: 4242 });
    for (let f = 0; f < inputs[0].length; f++) step(s, inputs[0][f], inputs[1][f]);
    expect(hashMatch(s)).toBe(hashMatch(b.s));
    expect(s.matchWinner).toBe(b.winner);
  });

  it('persisting the bout between turns does not change the outcome', () => {
    const init = {
      seed: 99, p1: 2, p2: 0,
      sides: [{ kind: 'agent' as const, id: 'e_a', label: 'A' }, { kind: 'agent' as const, id: 'e_b', label: 'B' }] as [any, any],
    };
    const a = playBout(new BoutCore(init), [scripted(1), scripted(2)]);
    const b = playBout(new BoutCore(init), [scripted(1), scripted(2)], true);
    expect(a.b.finished && b.b.finished).toBe(true);
    expect(hashMatch(b.b.s)).toBe(hashMatch(a.b.s));
    expect(b.inputs).toEqual(a.inputs);
  });

  it('rejects illegal and out-of-turn actions', () => {
    const b = new BoutCore({
      seed: 5, p1: 0, p2: 1,
      sides: [{ kind: 'agent', id: 'x', label: 'X' }, { kind: 'house', id: null, label: 'H', level: 0 }],
    });
    b.advance();
    expect(b.view(0).status).toBe('your_turn');
    expect(() => b.submit(0, ['fly'])).toThrow(/not available/);
    expect(() => b.submit(0, ['secret'])).toThrow(/not available/);
    expect(b.view(0).legal).toEqual(TECH_NAMES.filter((n) => !['burst', 'art_n', 'art_f', 'art_d', 'secret'].includes(n)));
    b.submit(0, ['advance', 'poke']);
    expect(b.s.frame).toBeGreaterThan(230);
  });

  it('verifies an honest human-vs-AI claim in chunks and rejects a forged one', () => {
    const seed = 31337;
    const s = createMatch({ p1: 1, p2: 0, seed });
    const human = new AIController(0, 3, 1); // stand-in for a human's keyboard
    const house = rankedHouseAI(seed, 3);
    const bits: number[] = [];
    while (s.phase !== PH.MATCH_END) {
      const a = human.read(s);
      bits.push(a);
      step(s, a, house.read(s));
    }
    const claim: HumanClaim = { kind: 'ai', seed, p1: 1, p2: 0, level: 3, inputs: [rleEncode(bits)], frames: s.frame, winner: s.matchWinner, hash: hashMatch(s) };
    let job = new VerifyJob(claim);
    while (!job.run(800)) job = new VerifyJob(claim, JSON.parse(JSON.stringify(job.snapshot())));
    expect(job.verdict()).toEqual({ ok: true, winner: s.matchWinner });
    const forged = new VerifyJob({ ...claim, winner: 1 - s.matchWinner });
    while (!forged.run(5000));
    expect(forged.verdict().ok).toBe(false);
    expect(houseSeed(seed, 1)).not.toBe(houseSeed(seed, 0));
  });
});
