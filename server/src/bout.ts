// Bout: one agent match. Runs the authoritative simulation turn by turn, persists it, enforces deadlines, serves replays.
import { DurableObject } from 'cloudflare:workers';
import { BoutCore, BoutError, BoutInit, BoutSide, BoutSnapshot, LogChunk } from '../../game/src/arena/bout';
import { Board, ReplayData, TurnRecord, houseSeed, stageFor } from '../../game/src/arena/replay';
import { CHARS } from '../../game/src/sim/chars';
import { PH } from '../../game/src/sim/defs';
import { Env, Fail, fail, watchUrl } from './util';

/** Per-decision time limit when two agents fight, and how many timeouts forfeit. */
const VERSUS_DEADLINE = 120_000;
const MAX_STRIKES = 3;
/** An agent that stops playing against the house forfeits after this long. */
const HOUSE_IDLE = 20 * 60_000;
/** Versus / challenge bouts wait this long for an opponent. */
const MATCH_WAIT = 15 * 60_000;
/** How long POST /turn waits for the opponent by default in agent-vs-agent bouts (saves the agent a polling call). */
const TURN_WAIT = 20;
/** Longest any request may wait for the opponent. */
export const MAX_WAIT = 50;
/** A queued agent must have polled this recently to be paired. */
const SEEN_FRESH = 120_000;

export interface SideMeta extends BoutSide {
  tokenHash: string | null;
  /** chosen fighter index, -1 = random */
  fighterPref: number;
}

export interface RatingChange {
  board: string;
  before: number;
  after: number;
  delta: number;
  wins: number;
  losses: number;
}

export interface BoutMeta {
  id: string;
  board: Board;
  mode: 'house' | 'versus' | 'challenge';
  status: 'matching' | 'live' | 'done' | 'void';
  code: string | null;
  created: number;
  updated: number;
  seed: number;
  sides: SideMeta[];
  /** per side, epoch ms by which the agent must act (0 = none) */
  deadline: number[];
  strikes: number[];
  seen: number[];
  chunks: number;
  frames: number;
  winner: number;
  endedBy: string | null;
  ratings: (RatingChange | null)[];
  /** API origin the bout was created through (watch links) */
  origin: string;
}

export class Bout extends DurableObject<Env> {
  private meta: BoutMeta | null = null;
  private core: BoutCore | null = null;
  private loaded = false;
  private waiters = new Set<() => void>();
  private seenSaved = 0;

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.meta = (await this.ctx.storage.get<BoutMeta>('meta')) ?? null;
    const snap = this.meta ? await this.ctx.storage.get<BoutSnapshot>('core') : undefined;
    this.core = snap ? new BoutCore(snap.init, snap) : null;
    this.loaded = true;
  }

  private sideOf(tokenHash: string | null): number {
    if (!tokenHash || !this.meta) return -1;
    return this.meta.sides.findIndex((s) => s.tokenHash === tokenHash);
  }

  private async save(): Promise<void> {
    const m = this.meta!;
    m.updated = Date.now();
    const put: Record<string, unknown> = {};
    if (this.core) {
      const chunk = this.core.drainLog();
      if (chunk.runs[0].length || chunk.turns.length) {
        put[`log:${String(m.chunks).padStart(6, '0')}`] = chunk;
        m.chunks++;
      }
      put.core = this.core.snapshot();
      m.frames = this.core.s.frame;
    }
    put.meta = m;
    await this.ctx.storage.put(put);
    await this.schedule();
  }

  private async schedule(): Promise<void> {
    const m = this.meta!;
    let next = 0;
    if (m.status === 'matching') next = m.created + MATCH_WAIT;
    if (m.status === 'live') for (const d of m.deadline) if (d && (!next || d < next)) next = d;
    if (next) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }

  private notify(): void {
    for (const w of [...this.waiters]) w();
  }

  private waitChange(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.waiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  private arena() {
    return this.env.ARENA.getByName('main');
  }

  /** After any change: end the bout if it finished, refresh deadlines, persist, wake long-polls. */
  private async afterChange(): Promise<void> {
    const m = this.meta!;
    const c = this.core;
    if (c && m.status === 'live' && c.finished) {
      m.status = 'done';
      m.winner = c.winner;
      m.endedBy = c.forfeit >= 0 ? 'forfeit' : c.s.phase === PH.MATCH_END ? 'ko' : 'timeout';
      m.deadline = [0, 0];
      await this.save();
      const r = await this.arena().boutFinished({ id: m.id, status: 'done', winner: m.winner, endedBy: m.endedBy, frames: c.s.frame });
      m.ratings = r.ratings;
    } else if (c && m.status === 'live') {
      const now = Date.now();
      const waiting = c.awaiting();
      for (let i = 0; i < 2; i++) {
        if (m.sides[i]?.kind !== 'agent') continue;
        if (m.mode === 'house') m.deadline[i] = now + HOUSE_IDLE;
        else m.deadline[i] = waiting.includes(i) ? m.deadline[i] || now + VERSUS_DEADLINE : 0;
      }
      if (now - m.updated > 20_000) this.ctx.waitUntil(this.arena().touchBout(m.id));
    }
    await this.save();
    this.notify();
  }

  // ---------------------------------------------------------------- RPC
  async setup(meta: BoutMeta, init: BoutInit | null): Promise<{ ok: true } | Fail> {
    await this.load();
    if (this.meta) return fail(409, 'exists', 'Bout id collision; try again.');
    this.meta = meta;
    if (init) {
      this.core = new BoutCore(init);
      this.core.advance();
    }
    await this.afterChange();
    return { ok: true };
  }

  async join(side: SideMeta): Promise<{ p1: number; p2: number } | Fail> {
    await this.load();
    const m = this.meta;
    if (!m || m.status !== 'matching') return fail(409, 'gone', 'This bout is no longer open.');
    if (Date.now() - m.seen[0] > SEEN_FRESH) return fail(409, 'stale', 'The waiting agent went away.');
    m.sides.push(side);
    m.status = 'live';
    const pick = (i: number) => (m.sides[i].fighterPref >= 0 ? m.sides[i].fighterPref : houseSeed(m.seed, i) % CHARS.length);
    const strip = (s: SideMeta): BoutSide => ({ kind: s.kind, id: s.id, label: s.label });
    const init: BoutInit = { seed: m.seed, p1: pick(0), p2: pick(1), sides: [strip(m.sides[0]), strip(m.sides[1])] };
    this.core = new BoutCore(init);
    this.core.advance();
    m.seen[1] = Date.now();
    await this.afterChange();
    return { p1: init.p1, p2: init.p2 };
  }

  async view(tokenHash: string | null, waitSec: number): Promise<unknown> {
    await this.load();
    if (!this.meta) return fail(404, 'not_found', 'No such bout.');
    const side = this.sideOf(tokenHash);
    if (side < 0) return this.summary();
    this.markSeen(side);
    await this.waitWhileIdle(side, waitSec);
    return this.viewFor(side);
  }

  /** Hold the request while this side has nothing to do (no opponent yet, or the opponent is choosing). */
  private async waitWhileIdle(side: number, waitSec: number): Promise<void> {
    const idle = () => {
      const m = this.meta!;
      if (m.status === 'matching') return true;
      return m.status === 'live' && !!this.core && this.core.status(side) === 'waiting';
    };
    const until = Date.now() + Math.min(MAX_WAIT, Math.max(0, waitSec)) * 1000;
    while (idle() && Date.now() < until) {
      await this.waitChange(until - Date.now());
      this.markSeen(side);
    }
  }

  async turn(tokenHash: string | null, actions: string[], say: string | undefined, waitSec?: number): Promise<unknown> {
    await this.load();
    const m = this.meta;
    if (!m) return fail(404, 'not_found', 'No such bout.');
    const side = this.sideOf(tokenHash);
    if (side < 0) return fail(403, 'not_your_bout', 'Your token is not a fighter in this bout.');
    if (m.status === 'matching') return fail(409, 'matching', 'No opponent yet. Poll GET /api/bouts/' + m.id + '?wait=25.');
    if (m.status !== 'live' || !this.core) return fail(409, 'finished', 'The bout is over.');
    try {
      this.core.submit(side, actions, say);
    } catch (e) {
      if (e instanceof BoutError) return fail(e.status, e.code, e.message);
      throw e;
    }
    m.strikes[side] = 0;
    m.deadline[side] = 0;
    this.markSeen(side);
    await this.afterChange();
    // against another agent, answer with the next turn when it comes quickly rather than "waiting"
    await this.waitWhileIdle(side, waitSec ?? (m.mode === 'house' ? 0 : TURN_WAIT));
    return this.viewFor(side);
  }

  async resign(tokenHash: string | null): Promise<unknown> {
    await this.load();
    const m = this.meta;
    if (!m) return fail(404, 'not_found', 'No such bout.');
    const side = this.sideOf(tokenHash);
    if (side < 0) return fail(403, 'not_your_bout', 'Your token is not a fighter in this bout.');
    if (m.status === 'matching') {
      m.status = 'void';
      await this.save();
      await this.arena().boutFinished({ id: m.id, status: 'void', winner: -1, endedBy: null, frames: 0 });
      this.notify();
    } else if (m.status === 'live' && this.core) {
      this.core.resign(side);
      await this.afterChange();
    }
    return this.viewFor(side);
  }

  async alarm(): Promise<void> {
    await this.load();
    const m = this.meta;
    if (!m) return;
    const now = Date.now();
    if (m.status === 'matching') {
      if (now < m.created + MATCH_WAIT) return this.schedule();
      m.status = 'void';
      await this.save();
      await this.arena().boutFinished({ id: m.id, status: 'void', winner: -1, endedBy: null, frames: 0 });
      this.notify();
      return;
    }
    if (m.status !== 'live' || !this.core) return;
    for (let i = 0; i < 2; i++) {
      if (!m.deadline[i] || now < m.deadline[i]) continue;
      m.deadline[i] = 0;
      if (m.mode === 'house') {
        this.core.resign(i);
        continue;
      }
      m.strikes[i]++;
      if (m.strikes[i] >= MAX_STRIKES) this.core.resign(i);
      else if (this.core.awaiting().includes(i)) this.core.autoPlay(i);
    }
    await this.afterChange();
  }

  async replay(from: number): Promise<ReplayData | Fail> {
    await this.load();
    const m = this.meta;
    if (!m || m.sides.length < 2 || !this.core) return fail(404, 'not_found', 'No replay for this bout (yet).');
    const chunks = await this.ctx.storage.list<LogChunk>({ prefix: 'log:' });
    const inputs: [number[], number[]] = [[], []];
    const turns: TurnRecord[] = [];
    let start = -1;
    for (const c of chunks.values()) {
      if (c.f0 < from) continue;
      if (start < 0) start = c.f0;
      inputs[0].push(...c.runs[0]);
      inputs[1].push(...c.runs[1]);
      turns.push(...c.turns);
    }
    const init = this.core.init;
    return {
      v: 1, id: m.id, board: m.board, status: m.status === 'done' ? 'done' : m.status === 'void' ? 'void' : 'live',
      seed: m.seed, p1: init.p1, p2: init.p2, stage: stageFor(m.seed), labels: [m.sides[0].label, m.sides[1].label],
      inputs, frames: m.frames, turns, winner: m.winner, ...(m.endedBy ? { endedBy: m.endedBy as ReplayData['endedBy'] } : {}),
      created: m.created, from: start < 0 ? m.frames : start,
    };
  }

  async summary(): Promise<unknown> {
    await this.load();
    const m = this.meta;
    if (!m) return fail(404, 'not_found', 'No such bout.');
    const c = this.core;
    return {
      bout: m.id, mode: m.mode, board: m.board, status: m.status, labels: m.sides.map((s) => s.label),
      fighters: c ? [CHARS[c.init.p1].id, CHARS[c.init.p2].id] : null,
      round: c?.s.round ?? null, hp: c ? c.s.f.map((f) => Math.max(0, f.hp)) : null, roundsWon: c ? c.s.f.map((f) => f.rounds) : null,
      winner: m.winner >= 0 ? m.winner : null, endedBy: m.endedBy, frames: m.frames, watch: watchUrl(this.env, m.origin, m.id),
    };
  }

  // ---------------------------------------------------------------- views
  private markSeen(side: number): void {
    const m = this.meta!;
    const now = Date.now();
    m.seen[side] = now;
    // persist occasionally so pairing still works if the object is evicted between polls
    if (now - this.seenSaved > 20_000) {
      this.seenSaved = now;
      this.ctx.waitUntil(this.ctx.storage.put('meta', m));
    }
  }

  private viewFor(side: number): unknown {
    const m = this.meta!;
    const watch = watchUrl(this.env, m.origin, m.id);
    const opp = m.sides[1 - side];
    const base = { bout: m.id, mode: m.mode, board: m.board, you: side === 0 ? 'p1' : 'p2', opponent: opp ? opp.label : null, watch };
    if (m.status === 'matching') {
      return {
        ...base, status: 'matching', code: m.code,
        message: m.mode === 'challenge'
          ? `Waiting for the other agent in duel ${m.code} (it must send {"mode":"challenge","code":"${m.code}"}). Keep polling GET /api/bouts/${m.id}?wait=25; the room closes after 15 minutes.`
          : `Waiting for another agent to join the versus queue (you're listed in the Arena as waiting for a challenger). Keep polling GET /api/bouts/${m.id}?wait=25; the queue gives up after 15 minutes.`,
      };
    }
    if (m.status === 'void' || !this.core) {
      return { ...base, status: 'void', message: 'No opponent joined in time. Play a house bout ({"mode":"house"}) and try the queue again later.' };
    }
    const v = this.core.view(side);
    const out: Record<string, unknown> = {
      ...base, status: v.status, decision: v.decision, turn: v.turn, frame: v.frame, state: v.state, events: v.events, legal: v.legal,
    };
    if (v.status === 'your_turn') {
      if (m.mode !== 'house' && m.deadline[side]) out.secondsLeft = Math.max(0, Math.round((m.deadline[side] - Date.now()) / 1000));
      out.next = `POST /api/bouts/${m.id}/turn {"action":"<one of legal>"}`;
    } else if (v.status === 'waiting') {
      out.next = `The opponent is choosing. GET /api/bouts/${m.id}?wait=25`;
    } else {
      const won = v.winner === 'you';
      const me = m.sides[side].label;
      const foe = opp?.label ?? 'the house';
      const text = won
        ? `🤖🥋 ${me} just beat ${foe} in INKFIST. Think your AI agent fights better? Tell it to read the arena manual and prove it.`
        : `🤖🥋 ${me} fought ${foe} in INKFIST and lost… for now. Can your AI agent do better?`;
      out.result = {
        winner: v.winner, endedBy: m.endedBy, rating: m.ratings[side] ?? null, watch,
        share: { text: `${text} ${watch}`, x: `https://x.com/intent/post?text=${encodeURIComponent(`${text} #INKFIST #AIagents`)}&url=${encodeURIComponent(watch)}` },
        tellYourHuman: `Report the result, your rating change and this replay link: ${watch}`,
      };
    }
    return out;
  }
}
