// Shared by the game client and the arena server: seeds, replay format and deterministic re-simulation.
import { PH } from '../sim/defs';
import { Match, createMatch, hashMatch, step } from '../sim/sim';
import { AIController, AISnapshot, Difficulty } from '../ai/ai';
import { rleDecode, rlePush } from './rle';

export const ARENA_STAGES = ['cloudpeak', 'bamboo'];
export const HOUSE_LEVELS = ['novice', 'adept', 'master', 'gosu'] as const;
export const BOARDS = ['agent_house', 'agent_agent', 'player_ai', 'player_player'] as const;
export type Board = (typeof BOARDS)[number];
/** No match may run longer than this (3 full rounds plus transitions is ~12k frames). */
export const MAX_MATCH_FRAMES = 20000;

export function stageFor(seed: number): string {
  return ARENA_STAGES[(seed >>> 0) % ARENA_STAGES.length];
}

/** Seed of the house AI on `side` for a match seed, identical on client and server. */
export function houseSeed(seed: number, side: number): number {
  return (Math.imul(seed >>> 0, 2654435761) + 0x9e37 + side * 0x632be5ab) >>> 0;
}

export interface TurnRecord {
  /** frame at which the choice was made */
  f: number;
  side: number;
  actions: string[];
  say?: string;
  /** the server chose for an agent that ran out of time */
  auto?: boolean;
}

/** Everything the replay viewer needs to re-run a bout exactly. */
export interface ReplayData {
  v: 1;
  id: string;
  board: Board;
  status: 'live' | 'done' | 'void';
  seed: number;
  p1: number;
  p2: number;
  stage: string;
  labels: [string, string];
  /** RLE input bits for each side, frames 1..n */
  inputs: [number[], number[]];
  frames: number;
  turns: TurnRecord[];
  winner: number;
  endedBy?: 'ko' | 'forfeit' | 'timeout';
  created: number;
  /** first frame (0-based) covered by `inputs` when fetching a live bout incrementally */
  from?: number;
}

/** A human match submitted by the game client. */
export interface HumanClaim {
  kind: 'ai' | 'pvp';
  seed: number;
  p1: number;
  p2: number;
  /** house AI level (kind 'ai'; the AI is always side 1 and seeded with houseSeed(seed, 1)) */
  level?: Difficulty;
  /** this player's side (pvp) */
  side?: number;
  /** RLE inputs: kind 'ai' sends only side 0; pvp sends both */
  inputs: number[][];
  /** frame on which the match ended (phase MATCH_END) */
  frames: number;
  winner: number;
  hash: number;
  /** pvp: the opponent's public entrant id */
  opponent?: string;
}

export interface VerifySnapshot {
  s: Match;
  ai: AISnapshot | null;
  out: [number[], number[]];
}

/** Chunked re-simulation of a human claim, so the server never exceeds its per-request CPU budget. */
export class VerifyJob {
  s: Match;
  ai: AIController | null;
  out: [number[], number[]];
  private in0: number[];
  private in1: number[] | null;

  constructor(public claim: HumanClaim, snap?: VerifySnapshot) {
    if (claim.frames > MAX_MATCH_FRAMES || claim.frames < 10) throw new Error('bad frame count');
    this.in0 = rleDecode(claim.inputs[0] ?? [], MAX_MATCH_FRAMES);
    this.in1 = claim.kind === 'pvp' ? rleDecode(claim.inputs[1] ?? [], MAX_MATCH_FRAMES) : null;
    if (snap) {
      this.s = snap.s;
      this.ai = snap.ai ? AIController.restore(snap.ai) : null;
      this.out = snap.out;
    } else {
      this.s = createMatch({ p1: claim.p1, p2: claim.p2, seed: claim.seed });
      this.ai = claim.kind === 'ai' ? new AIController(1, (claim.level ?? 0) as Difficulty, houseSeed(claim.seed, 1)) : null;
      this.out = [[], []];
    }
  }

  snapshot(): VerifySnapshot {
    return { s: this.s, ai: this.ai ? this.ai.snapshot() : null, out: this.out };
  }

  /** Simulate up to `n` frames. Returns true when finished. */
  run(n: number): boolean {
    const s = this.s;
    for (let k = 0; k < n; k++) {
      if (s.phase === PH.MATCH_END || s.frame >= this.claim.frames) return true;
      const f = s.frame;
      const a = this.in0[f] ?? 0;
      const b = this.ai ? this.ai.read(s) : (this.in1![f] ?? 0);
      rlePush(this.out[0], a);
      rlePush(this.out[1], b);
      step(s, a, b);
    }
    return s.phase === PH.MATCH_END || s.frame >= this.claim.frames;
  }

  /** After run() finished: does the replay agree with what the client claimed? */
  verdict(): { ok: boolean; reason?: string; winner: number } {
    const s = this.s;
    if (s.phase !== PH.MATCH_END) return { ok: false, reason: 'match did not finish', winner: -1 };
    if (s.frame !== this.claim.frames) return { ok: false, reason: `ended on frame ${s.frame}, claimed ${this.claim.frames}`, winner: s.matchWinner };
    if (s.matchWinner !== this.claim.winner) return { ok: false, reason: 'winner mismatch', winner: s.matchWinner };
    if (hashMatch(s) !== this.claim.hash >>> 0) return { ok: false, reason: 'state hash mismatch', winner: s.matchWinner };
    return { ok: true, winner: s.matchWinner };
  }
}

/** Client side: re-create the exact house AI used for a ranked Versus AI match. */
export function rankedHouseAI(seed: number, level: Difficulty): AIController {
  return new AIController(1, level, houseSeed(seed, 1));
}
