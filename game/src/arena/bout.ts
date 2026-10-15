// One arena bout: the authoritative simulation plus an agent pilot or house AI per side, advanced turn by turn.
// Pure logic (no I/O): the server wraps it with storage, auth and deadlines; tests drive it directly.
import { PH, ST } from '../sim/defs';
import { CHARS, MOVE_NAMES } from '../sim/chars';
import { Match, createMatch, moveOf, step } from '../sim/sim';
import { AIController, AISnapshot, Difficulty } from '../ai/ai';
import { DecisionKind, MAX_QUEUE, PILOT_REACTION, Pilot, PilotSnapshot, TECHNIQUES } from './pilot';
import { FighterView, Observation, eventText, fighterView, moveLabel, observation } from './observe';
import { rlePush } from './rle';
import { MAX_MATCH_FRAMES, TurnRecord, houseSeed, stageFor } from './replay';

export interface BoutSide {
  kind: 'agent' | 'house';
  /** entrant id (agents) */
  id: string | null;
  /** display label, e.g. "Alice: Gemini 3" or "House AI · Gosu" */
  label: string;
  level?: Difficulty;
}

export interface BoutInit {
  seed: number;
  p1: number;
  p2: number;
  sides: [BoutSide, BoutSide];
}

export type BoutStatus = 'your_turn' | 'waiting' | 'finished';

export interface AgentView {
  status: BoutStatus;
  /** what you are deciding: a normal turn, or whether to burst out of a combo */
  decision: DecisionKind | null;
  legal: string[];
  turn: number;
  frame: number;
  state: Observation;
  /** what happened since your last decision, oldest first */
  events: string[];
  winner: 'you' | 'opponent' | null;
}

interface HitAgg {
  atk: number;
  moves: string[];
  dmg: number;
  counter: boolean;
  idx: number;
}

export interface BoutSnapshot {
  init: BoutInit;
  s: Match;
  pilots: (PilotSnapshot | null)[];
  ais: (AISnapshot | null)[];
  need: (DecisionKind | null)[];
  pending: (string[] | null)[];
  says: (string | null)[];
  turns: number[];
  feed: string[][];
  agg: (HitAgg | null)[];
  forfeit: number;
  seen: FighterView[][];
}

export interface LogChunk {
  /** first frame (0-based index into the input log) */
  f0: number;
  runs: [number[], number[]];
  turns: TurnRecord[];
}

export class BoutError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

const FEED_MAX = 16;
/** Agents perceive their opponent this many frames late, like the house AI and a human's reflexes. */
export const PERCEPTION_DELAY = PILOT_REACTION;

export class BoutCore {
  init: BoutInit;
  s: Match;
  pilots: (Pilot | null)[];
  ais: (AIController | null)[];
  need: (DecisionKind | null)[] = [null, null];
  pending: (string[] | null)[] = [null, null];
  says: (string | null)[] = [null, null];
  turns = [0, 0];
  feed: string[][] = [[], []];
  agg: (HitAgg | null)[] = [null, null];
  /** side that forfeited, or -1 */
  forfeit = -1;
  /** both fighters as they looked over the last PERCEPTION_DELAY + 1 frames */
  seen: FighterView[][] = [];
  /** input log since the last drainLog() */
  private chunk: LogChunk;

  constructor(init: BoutInit, snap?: BoutSnapshot) {
    this.init = init;
    if (snap) {
      this.s = snap.s;
      this.s.events = [];
      this.pilots = snap.pilots.map((p) => (p ? Pilot.restore(p) : null));
      this.ais = snap.ais.map((a) => (a ? AIController.restore(a) : null));
      this.need = snap.need;
      this.pending = snap.pending;
      this.says = snap.says;
      this.turns = snap.turns;
      this.feed = snap.feed;
      this.agg = snap.agg;
      this.forfeit = snap.forfeit;
      this.seen = snap.seen ?? [];
    } else {
      this.s = createMatch({ p1: init.p1, p2: init.p2, seed: init.seed });
      this.pilots = init.sides.map((sd, i) => (sd.kind === 'agent' ? new Pilot(i) : null));
      this.ais = init.sides.map((sd, i) => (sd.kind === 'house' ? new AIController(i, sd.level ?? 0, houseSeed(init.seed, i)) : null));
    }
    this.chunk = { f0: this.s.frame, runs: [[], []], turns: [] };
  }

  get stage(): string {
    return stageFor(this.init.seed);
  }

  snapshot(): BoutSnapshot {
    return structuredClone({
      init: this.init, s: { ...this.s, events: [] }, pilots: this.pilots.map((p) => p?.snapshot() ?? null),
      ais: this.ais.map((a) => a?.snapshot() ?? null), need: this.need, pending: this.pending, says: this.says,
      turns: this.turns, feed: this.feed, agg: this.agg, forfeit: this.forfeit, seen: this.seen,
    });
  }

  /** Input log and turn records produced since the previous call. */
  drainLog(): LogChunk {
    const c = this.chunk;
    this.chunk = { f0: this.s.frame, runs: [[], []], turns: [] };
    return c;
  }

  get finished(): boolean {
    return this.s.phase === PH.MATCH_END || this.forfeit >= 0 || this.s.frame >= MAX_MATCH_FRAMES;
  }

  /** Winning side, or -1 while running. */
  get winner(): number {
    if (this.forfeit >= 0) return 1 - this.forfeit;
    if (this.s.phase === PH.MATCH_END) return this.s.matchWinner;
    if (this.s.frame >= MAX_MATCH_FRAMES) {
      const a = this.s.f[0], b = this.s.f[1];
      return a.rounds !== b.rounds ? (a.rounds > b.rounds ? 0 : 1) : a.hp >= b.hp ? 0 : 1;
    }
    return -1;
  }

  /** Sides that must submit an action before the fight can continue. */
  awaiting(): number[] {
    return [0, 1].filter((i) => this.need[i] && !this.pending[i]);
  }

  status(side: number): BoutStatus {
    if (this.finished) return 'finished';
    return this.need[side] && !this.pending[side] ? 'your_turn' : 'waiting';
  }

  /** Run the simulation until some agent must decide or the match ends. Returns frames simulated. */
  advance(budget = MAX_MATCH_FRAMES): number {
    const s = this.s;
    let n = 0;
    while (!this.finished && n < budget) {
      for (let i = 0; i < 2; i++) {
        const p = this.pilots[i];
        if (p && !this.need[i]) this.need[i] = p.decision(s);
      }
      if (this.need[0] || this.need[1]) break;
      const b0 = this.pilots[0] ? this.pilots[0].read(s) : this.ais[0]!.read(s);
      const b1 = this.pilots[1] ? this.pilots[1].read(s) : this.ais[1]!.read(s);
      const hp0 = s.f[0].hp, hp1 = s.f[1].hp;
      const sf0 = s.f[0].sf, sf1 = s.f[1].sf;
      step(s, b0, b1);
      rlePush(this.chunk.runs[0], b0);
      rlePush(this.chunk.runs[1], b1);
      n++;
      if (this.pilots[0] || this.pilots[1]) {
        this.seen.push([fighterView(s, 0), fighterView(s, 1)]);
        if (this.seen.length > PERCEPTION_DELAY + 1) this.seen.shift();
      }
      const missed = [0, 1].filter((i) => this.missed(i, i === 0 ? sf0 : sf1));
      if (s.events.length || missed.length) this.collect([hp0 - s.f[0].hp, hp1 - s.f[1].hp], missed);
    }
    return n;
  }

  /** The attack's active frames just ended without touching anything. */
  private missed(i: number, prevSf: number): boolean {
    const f = this.s.f[i];
    if (f.st !== ST.ATTACK || f.contact !== 0 || f.sf === prevSf) return false;
    const md = moveOf(f);
    return !!md && !md.projectile && !md.counter && f.sf === md.startup + md.active;
  }

  private push(side: number, line: string): void {
    this.feed[side].push(line);
    this.agg[side] = null;
  }

  private collect(dmg: number[], missed: number[]): void {
    const s = this.s;
    for (const i of missed) {
      const name = moveLabel(CHARS[s.f[i].ch].id, MOVE_NAMES[s.f[i].ch][s.f[i].mv]);
      for (let side = 0; side < 2; side++) {
        if (this.pilots[side]) this.push(side, i === side ? `Your ${name} missed` : `Their ${name} missed: they are recovering`);
      }
    }
    for (const e of s.events) {
      for (let side = 0; side < 2; side++) {
        if (!this.pilots[side]) continue;
        if (e.t === 'hit') {
          const name = moveLabel(CHARS[s.f[e.atk].ch].id, e.move);
          const a = this.agg[side];
          const feed = this.feed[side];
          if (a && a.atk === e.atk && a.idx === feed.length - 1) {
            a.moves.push(name);
            a.dmg += dmg[e.def];
            a.counter ||= e.counter;
            feed[a.idx] = this.hitLine(side, a);
          } else {
            const na: HitAgg = { atk: e.atk, moves: [name], dmg: dmg[e.def], counter: e.counter, idx: feed.length };
            this.agg[side] = na;
            feed.push(this.hitLine(side, na));
          }
          dmg[e.def] = 0;
          continue;
        }
        const line = eventText(e, s, side);
        if (line) this.push(side, line);
      }
    }
    for (let side = 0; side < 2; side++) {
      const f = this.feed[side];
      if (f.length > FEED_MAX) {
        const cut = f.length - FEED_MAX;
        f.splice(0, cut);
        const a = this.agg[side];
        if (a) a.idx -= cut;
        if (a && a.idx < 0) this.agg[side] = null;
      }
    }
  }

  private hitLine(side: number, a: HitAgg): string {
    const who = a.atk === side ? 'You hit them' : 'They hit you';
    const n = a.moves.length;
    return `${who}: ${a.moves.join(' → ')} (${n} hit${n > 1 ? 's' : ''}, ${a.dmg} damage${a.counter ? ', COUNTER' : ''})`;
  }

  /** Legal choices for `side` right now (empty unless it is that side's turn). */
  legal(side: number): string[] {
    const p = this.pilots[side];
    const k = this.need[side];
    return p && k ? p.legal(this.s, k) : [];
  }

  /**
   * An agent's move: one technique, or up to MAX_QUEUE to run back to back (the queue is dropped if you get hit).
   * Applies once every side the fight is waiting on has chosen, then advances.
   */
  submit(side: number, actions: string[], say?: string, auto = false): void {
    if (this.finished) throw new BoutError('finished', 'The bout is over.', 409);
    const kind = this.need[side];
    if (!this.pilots[side] || !kind) throw new BoutError('not_your_turn', 'Not your turn: poll GET until status is "your_turn".', 409);
    if (this.pending[side]) throw new BoutError('already_submitted', 'You already chose; waiting for the opponent.', 409);
    if (!Array.isArray(actions) || !actions.length) throw new BoutError('no_action', 'Send "action" (a technique name) or "actions" (up to 3).');
    const list = actions.map((a) => String(a).trim().toLowerCase()).slice(0, MAX_QUEUE);
    const legal = this.legal(side);
    if (!legal.includes(list[0])) {
      throw new BoutError('illegal_action', `"${list[0]}" is not available now. Legal: ${legal.join(', ')}`);
    }
    if (kind === 'free') {
      for (const a of list.slice(1)) {
        if (!TECHNIQUES[a] || a === 'burst') throw new BoutError('illegal_action', `Unknown queued technique "${a}".`);
      }
    }
    this.pending[side] = kind === 'combo' ? list.slice(0, 1) : list;
    this.says[side] = say ? String(say).replace(/[\u0000-\u001f]/g, ' ').slice(0, 80) : null;
    this.chunk.turns.push({ f: this.s.frame, side, actions: this.pending[side]!, ...(this.says[side] ? { say: this.says[side]! } : {}), ...(auto ? { auto } : {}) });
    if (this.awaiting().length) return;
    for (let i = 0; i < 2; i++) {
      const k = this.need[i];
      const p = this.pilots[i];
      if (!k || !p || !this.pending[i]) continue;
      p.assign(this.pending[i]!, this.s, k);
      this.turns[i]++;
      this.need[i] = null;
      this.pending[i] = null;
      this.feed[i] = [];
      this.agg[i] = null;
    }
    this.advance();
  }

  /** The default the server plays for an agent that ran out of time. */
  autoPlay(side: number): void {
    this.submit(side, [this.need[side] === 'combo' ? 'endure' : 'guard'], undefined, true);
  }

  resign(side: number): void {
    if (!this.finished) this.forfeit = side;
  }

  /** The opponent as `side` currently perceives them. */
  perceived(side: number): FighterView {
    const v = this.seen.length ? this.seen[Math.max(0, this.seen.length - 1 - PERCEPTION_DELAY)] : null;
    return v ? v[1 - side] : fighterView(this.s, 1 - side);
  }

  view(side: number): AgentView {
    const w = this.winner;
    return {
      status: this.status(side),
      decision: !this.finished && this.need[side] && !this.pending[side] ? this.need[side] : null,
      legal: this.finished || this.pending[side] ? [] : this.legal(side),
      turn: this.turns[side],
      frame: this.s.frame,
      state: observation(this.s, side, this.perceived(side)),
      events: this.feed[side].slice(),
      winner: w < 0 ? null : w === side ? 'you' : 'opponent',
    };
  }
}
