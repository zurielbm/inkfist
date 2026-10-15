// Arena: the single source of truth for entrants, ratings, bout index, agent matchmaking and human results (SQLite).
import { DurableObject } from 'cloudflare:workers';
import { HOUSE_NAMES, HOUSE_RATING, START_RATING, eloDelta } from '../../game/src/arena/rating';
import { HumanClaim, MAX_MATCH_FRAMES, houseSeed } from '../../game/src/arena/replay';
import { CHARS } from '../../game/src/sim/chars';
import type { BoutMeta, RatingChange, SideMeta } from './bout';
import { ENTRANT_ID, Env, Fail, cleanText, fail, isFail, randomCode, randomId, randomSeed, sha256 } from './util';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS entrants (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, agent TEXT, model TEXT,
     token_hash TEXT NOT NULL UNIQUE, created INTEGER NOT NULL, live_bout TEXT)`,
  `CREATE TABLE IF NOT EXISTS ratings (entrant TEXT NOT NULL, board TEXT NOT NULL, rating INTEGER NOT NULL, wins INTEGER NOT NULL,
     losses INTEGER NOT NULL, games INTEGER NOT NULL, streak INTEGER NOT NULL, best_streak INTEGER NOT NULL, top_wins INTEGER NOT NULL,
     updated INTEGER NOT NULL, PRIMARY KEY (entrant, board))`,
  `CREATE INDEX IF NOT EXISTS ratings_board ON ratings (board, rating DESC)`,
  `CREATE TABLE IF NOT EXISTS bouts (id TEXT PRIMARY KEY, board TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL,
     e1 TEXT, e2 TEXT, label1 TEXT, label2 TEXT, ch1 INTEGER, ch2 INTEGER, level INTEGER, code TEXT, winner INTEGER,
     ended_by TEXT, frames INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS bouts_status ON bouts (status, updated DESC)`,
  `CREATE INDEX IF NOT EXISTS bouts_code ON bouts (code)`,
  `CREATE TABLE IF NOT EXISTS queue (bout TEXT PRIMARY KEY, entrant TEXT NOT NULL, created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS results (id TEXT PRIMARY KEY, entrant TEXT NOT NULL, opponent TEXT, side INTEGER NOT NULL,
     board TEXT NOT NULL, level INTEGER, status TEXT NOT NULL, digest TEXT NOT NULL, pair TEXT, detail TEXT,
     rating_json TEXT, created INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS results_digest ON results (digest)`,
  `CREATE TABLE IF NOT EXISTS pvp_pending (key TEXT PRIMARY KEY, result TEXT NOT NULL, entrant TEXT NOT NULL, opponent TEXT NOT NULL,
     side INTEGER NOT NULL, frames INTEGER NOT NULL, winner INTEGER NOT NULL, hash INTEGER NOT NULL, created INTEGER NOT NULL)`,
];

const HOUR = 3600_000;
const MATCH_WAIT = 15 * 60_000;

interface EntrantRow {
  id: string;
  kind: 'agent' | 'human';
  name: string;
  agent: string | null;
  model: string | null;
  live_bout: string | null;
  created: number;
}

interface RatingRow {
  rating: number;
  wins: number;
  losses: number;
  games: number;
  streak: number;
  best_streak: number;
  top_wins: number;
}

export interface BoardEntry {
  rank: number;
  id: string;
  kind: string;
  name: string;
  agent: string | null;
  label: string;
  rating: number;
  wins: number;
  losses: number;
  bestStreak: number;
  topWins: number;
}

export interface BoutListItem {
  id: string;
  board: string;
  mode: string;
  status: string;
  labels: [string | null, string | null];
  fighters: [string | null, string | null];
  winner: number | null;
  endedBy: string | null;
  updated: number;
}

export interface StartParams {
  tokenHash: string;
  mode: 'house' | 'versus' | 'challenge';
  level: number;
  fighter: number;
  code: string | null;
  origin: string;
}

export function labelOf(e: { kind: string; name: string; agent: string | null }): string {
  return e.kind === 'agent' && e.agent ? `${e.name}: ${e.agent}` : e.name;
}

export class Arena extends DurableObject<Env> {
  private sql: SqlStorage;
  private hits = new Map<string, number[]>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const q of SCHEMA) this.sql.exec(q);
  }

  // ---------------------------------------------------------------- helpers
  private rows<T>(q: string, ...b: unknown[]): T[] {
    return this.sql.exec(q, ...b).toArray() as unknown as T[];
  }

  private row<T>(q: string, ...b: unknown[]): T | null {
    return this.rows<T>(q, ...b)[0] ?? null;
  }

  /** Sliding-window rate limit kept in memory (resets if the object is evicted, which is fine for abuse control). */
  private allow(key: string, max: number, windowMs: number): boolean {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 5000) this.hits.clear();
    return true;
  }

  private byToken(hash: string | null): EntrantRow | null {
    if (!hash) return null;
    return this.row<EntrantRow>('SELECT id, kind, name, agent, model, live_bout, created FROM entrants WHERE token_hash = ?', hash);
  }

  private entrant(id: string | null): EntrantRow | null {
    if (!id) return null;
    return this.row<EntrantRow>('SELECT id, kind, name, agent, model, live_bout, created FROM entrants WHERE id = ?', id);
  }

  private bout(id: string) {
    return this.env.BOUT.getByName(id);
  }

  private ratingRow(entrant: string, board: string): RatingRow | null {
    return this.row<RatingRow>('SELECT rating, wins, losses, games, streak, best_streak, top_wins FROM ratings WHERE entrant = ? AND board = ?', entrant, board);
  }

  /** Apply one game's result; `opp` is the opponent's rating before the game. */
  private rate(entrant: string, board: string, opp: number, score: number, topWin: boolean): RatingChange {
    const r = this.ratingRow(entrant, board) ?? { rating: START_RATING, wins: 0, losses: 0, games: 0, streak: 0, best_streak: 0, top_wins: 0 };
    const delta = eloDelta(r.rating, opp, score, r.games);
    const after = Math.max(100, r.rating + delta);
    const wins = r.wins + (score > 0.5 ? 1 : 0);
    const losses = r.losses + (score > 0.5 ? 0 : 1);
    const streak = score > 0.5 ? r.streak + 1 : 0;
    this.sql.exec(
      `INSERT INTO ratings (entrant, board, rating, wins, losses, games, streak, best_streak, top_wins, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (entrant, board) DO UPDATE SET rating = excluded.rating, wins = excluded.wins, losses = excluded.losses,
         games = excluded.games, streak = excluded.streak, best_streak = excluded.best_streak, top_wins = excluded.top_wins, updated = excluded.updated`,
      entrant, board, after, wins, losses, r.games + 1, streak, Math.max(r.best_streak, streak), r.top_wins + (topWin ? 1 : 0), Date.now(),
    );
    return { board, before: r.rating, after, delta: after - r.rating, wins, losses };
  }

  // ---------------------------------------------------------------- entrants
  async register(p: { name: unknown; agent: unknown; model: unknown; human: boolean; tokenHash: string | null; ip: string }): Promise<
    { id: string; token?: string; label: string; kind: string; updated?: boolean } | Fail
  > {
    const name = cleanText(p.name, 24);
    const agent = p.human ? null : cleanText(p.agent, 32) || null;
    const model = p.human ? null : cleanText(p.model, 64) || null;
    if (!name) return fail(400, 'name_required', 'Send "name": your human\'s name or handle (max 24 characters).');
    if (/^house\b/i.test(name)) return fail(400, 'name_reserved', 'Names starting with "House" are reserved.');
    if (!p.human && !agent) return fail(400, 'agent_required', 'Send "agent": the model you are, e.g. "Claude Opus 5.5" or "Gemini 3".');
    if (p.tokenHash) {
      const e = this.byToken(p.tokenHash);
      if (!e) return fail(401, 'bad_token', 'Unknown token.');
      this.sql.exec('UPDATE entrants SET name = ?, agent = ?, model = ? WHERE id = ?', name, e.kind === 'agent' ? agent ?? e.agent : null, model ?? e.model, e.id);
      const n = this.entrant(e.id)!;
      return { id: n.id, label: labelOf(n), kind: n.kind, updated: true };
    }
    if (!this.allow(`reg:${p.ip}`, 20, HOUR)) return fail(429, 'rate_limited', 'Too many registrations from your network. Try again later.');
    const id = randomId('e_');
    const token = randomId('ik_', 32);
    const kind = p.human ? 'human' : 'agent';
    this.sql.exec('INSERT INTO entrants (id, kind, name, agent, model, token_hash, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, kind, name, agent, model, await sha256(token), Date.now());
    return { id, token, label: labelOf({ kind, name, agent }), kind };
  }

  async me(tokenHash: string): Promise<unknown> {
    const e = this.byToken(tokenHash);
    if (!e) return fail(401, 'bad_token', 'Unknown or missing token.');
    const ratings = this.rows<RatingRow & { board: string }>('SELECT board, rating, wins, losses, games, streak, best_streak, top_wins FROM ratings WHERE entrant = ?', e.id);
    const live = e.live_bout ? this.row<{ id: string; status: string }>('SELECT id, status FROM bouts WHERE id = ?', e.live_bout) : null;
    return {
      id: e.id, kind: e.kind, name: e.name, agent: e.agent, label: labelOf(e),
      ratings: Object.fromEntries(ratings.map((r) => [r.board, { rating: r.rating, wins: r.wins, losses: r.losses, bestStreak: r.best_streak, topWins: r.top_wins }])),
      liveBout: live && (live.status === 'live' || live.status === 'matching') ? live.id : null,
    };
  }

  // ---------------------------------------------------------------- agent bouts
  async startBout(p: StartParams): Promise<{ id: string } | Fail> {
    const e = this.byToken(p.tokenHash);
    if (!e) return fail(401, 'bad_token', 'Unknown or missing token. Register first: POST /api/register.');
    if (e.kind !== 'agent') return fail(403, 'agents_only', 'Arena bouts are for AI agents. Humans: play in the game and your wins are ranked automatically.');
    if (e.live_bout) {
      const b = this.row<{ id: string; status: string }>('SELECT id, status FROM bouts WHERE id = ?', e.live_bout);
      if (b && (b.status === 'live' || b.status === 'matching')) {
        return fail(409, 'live_bout', `You already have a live bout (${b.id}). Continue it with GET /api/bouts/${b.id}, or POST /api/bouts/${b.id}/resign.`);
      }
    }
    if (!this.allow(`bout:${e.id}`, 60, HOUR)) return fail(429, 'rate_limited', 'Too many bouts this hour. Take a breath, master.');
    const label = labelOf(e);
    const me: SideMeta = { kind: 'agent', id: e.id, label, level: undefined, tokenHash: p.tokenHash, fighterPref: p.fighter };
    const now = Date.now();

    if (p.mode === 'house') {
      const id = randomId('b_');
      const seed = randomSeed();
      const p1 = p.fighter >= 0 ? p.fighter : seed % CHARS.length;
      const p2 = houseSeed(seed, 1) % CHARS.length;
      const house: SideMeta = { kind: 'house', id: null, label: `House AI · ${HOUSE_NAMES[p.level]}`, level: p.level as 0, tokenHash: null, fighterPref: p2 };
      const meta = newMeta(id, 'agent_house', 'house', seed, [me, house], p.origin, null);
      const r = await this.bout(id).setup(meta, { seed, p1, p2, sides: [stripSide(me), stripSide(house)] });
      if (isFail(r)) return r;
      this.sql.exec(
        `INSERT INTO bouts (id, board, mode, status, e1, e2, label1, label2, ch1, ch2, level, created, updated) VALUES (?, 'agent_house', 'house', 'live', ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        id, e.id, label, house.label, p1, p2, p.level, now, now,
      );
      this.sql.exec('UPDATE entrants SET live_bout = ? WHERE id = ?', id, e.id);
      return { id };
    }

    // versus queue / duel code: join an open bout if there is one
    const candidates = p.mode === 'versus'
      ? this.rows<{ bout: string }>('SELECT bout FROM queue WHERE entrant != ? AND created > ? ORDER BY created LIMIT 5', e.id, now - MATCH_WAIT)
      : p.code
        ? this.rows<{ bout: string }>(`SELECT id AS bout FROM bouts WHERE code = ? AND status = 'matching' AND e1 != ? ORDER BY created DESC LIMIT 3`, p.code, e.id)
        : [];
    for (const c of candidates) {
      const r = await this.bout(c.bout).join(me);
      this.sql.exec('DELETE FROM queue WHERE bout = ?', c.bout);
      if (isFail(r)) continue;
      this.sql.exec(`UPDATE bouts SET status = 'live', e2 = ?, label2 = ?, ch1 = ?, ch2 = ?, updated = ? WHERE id = ?`, e.id, label, r.p1, r.p2, now, c.bout);
      this.sql.exec('UPDATE entrants SET live_bout = ? WHERE id = ?', c.bout, e.id);
      return { id: c.bout };
    }
    // a duel code nobody is waiting on yet: this agent opens the room (both agents can send the identical request)
    if (p.mode === 'challenge' && p.code && this.row(`SELECT id FROM bouts WHERE code = ? AND status = 'live'`, p.code)) {
      return fail(409, 'code_in_use', `Duel ${p.code} is being fought right now. Ask your human for a new code, or watch it.`);
    }
    const id = randomId('b_');
    const code = p.mode === 'challenge' ? p.code ?? randomCode() : null;
    const meta = newMeta(id, 'agent_agent', p.mode, randomSeed(), [me], p.origin, code);
    const r = await this.bout(id).setup(meta, null);
    if (isFail(r)) return r;
    this.sql.exec(
      `INSERT INTO bouts (id, board, mode, status, e1, label1, code, created, updated) VALUES (?, 'agent_agent', ?, 'matching', ?, ?, ?, ?, ?)`,
      id, p.mode, e.id, label, code, now, now,
    );
    if (p.mode === 'versus') this.sql.exec('INSERT INTO queue (bout, entrant, created) VALUES (?, ?, ?)', id, e.id, now);
    this.sql.exec('UPDATE entrants SET live_bout = ? WHERE id = ?', id, e.id);
    return { id };
  }

  /** Called by a Bout when it ends (or expires). Returns each side's rating change. */
  async boutFinished(u: { id: string; status: 'done' | 'void'; winner: number; endedBy: string | null; frames: number }): Promise<{ ratings: (RatingChange | null)[] }> {
    const b = this.row<{ board: string; status: string; e1: string | null; e2: string | null; level: number | null }>(
      'SELECT board, status, e1, e2, level FROM bouts WHERE id = ?', u.id);
    const ratings: (RatingChange | null)[] = [null, null];
    if (!b) return { ratings };
    this.sql.exec('DELETE FROM queue WHERE bout = ?', u.id);
    this.sql.exec('UPDATE entrants SET live_bout = NULL WHERE live_bout = ?', u.id);
    if (b.status === 'done' || b.status === 'void') return { ratings };
    this.sql.exec('UPDATE bouts SET status = ?, winner = ?, ended_by = ?, frames = ?, updated = ? WHERE id = ?',
      u.status, u.winner, u.endedBy, u.frames, Date.now(), u.id);
    if (u.status !== 'done') return { ratings };
    if (b.board === 'agent_house' && b.e1) {
      const lvl = b.level ?? 0;
      ratings[0] = this.rate(b.e1, 'agent_house', HOUSE_RATING[lvl], u.winner === 0 ? 1 : 0, u.winner === 0 && lvl === 3);
    } else if (b.board === 'agent_agent' && b.e1 && b.e2) {
      const r1 = this.ratingRow(b.e1, 'agent_agent')?.rating ?? START_RATING;
      const r2 = this.ratingRow(b.e2, 'agent_agent')?.rating ?? START_RATING;
      ratings[0] = this.rate(b.e1, 'agent_agent', r2, u.winner === 0 ? 1 : 0, false);
      ratings[1] = this.rate(b.e2, 'agent_agent', r1, u.winner === 1 ? 1 : 0, false);
    }
    return { ratings };
  }

  // ---------------------------------------------------------------- public lists
  async leaderboard(board: string, limit: number): Promise<{ board: string; entries: BoardEntry[] }> {
    const rows = this.rows<{ id: string; kind: string; name: string; agent: string | null } & RatingRow>(
      `SELECT e.id, e.kind, e.name, e.agent, r.rating, r.wins, r.losses, r.games, r.best_streak, r.top_wins
       FROM ratings r JOIN entrants e ON e.id = r.entrant WHERE r.board = ? AND r.games > 0
       ORDER BY r.rating DESC, r.wins DESC, r.updated ASC LIMIT ?`, board, limit);
    return {
      board,
      entries: rows.map((r, i) => ({
        rank: i + 1, id: r.id, kind: r.kind, name: r.name, agent: r.agent, label: labelOf(r), rating: r.rating,
        wins: r.wins, losses: r.losses, bestStreak: r.best_streak, topWins: r.top_wins,
      })),
    };
  }

  async listBouts(status: 'live' | 'recent' | 'open', limit: number): Promise<{ bouts: BoutListItem[] }> {
    const now = Date.now();
    const q = {
      live: [`SELECT * FROM bouts WHERE status = 'live' AND updated > ? ORDER BY updated DESC LIMIT ?`, now - 30 * 60_000],
      recent: [`SELECT * FROM bouts WHERE status = 'done' AND updated > ? ORDER BY updated DESC LIMIT ?`, 0],
      // agents sitting in the public versus queue, waiting for a challenger
      open: [`SELECT * FROM bouts WHERE status = 'matching' AND mode = 'versus' AND created > ? ORDER BY created ASC LIMIT ?`, now - MATCH_WAIT],
    }[status] as [string, number];
    const rows = this.rows<{ id: string; board: string; mode: string; status: string; label1: string | null; label2: string | null; ch1: number | null; ch2: number | null; winner: number | null; ended_by: string | null; updated: number }>(
      q[0], q[1], limit);
    const ch = (i: number | null) => (i === null || i === undefined ? null : CHARS[i]?.id ?? null);
    return {
      bouts: rows.map((r) => ({
        id: r.id, board: r.board, mode: r.mode, status: r.status, labels: [r.label1, r.label2], fighters: [ch(r.ch1), ch(r.ch2)],
        winner: r.winner, endedBy: r.ended_by, updated: r.updated,
      })),
    };
  }

  /** The latest bout fought under a duel code (spectator lobby). */
  async duel(code: string): Promise<{ code: string; status: 'empty' | 'waiting' | 'live' | 'done'; bout: string | null; labels: (string | null)[]; fighters: (string | null)[]; winner: number | null }> {
    const b = this.row<{ id: string; status: string; label1: string | null; label2: string | null; ch1: number | null; ch2: number | null; winner: number | null }>(
      `SELECT id, status, label1, label2, ch1, ch2, winner FROM bouts WHERE code = ? AND status != 'void' ORDER BY created DESC LIMIT 1`, code);
    const ch = (i: number | null) => (i === null || i === undefined ? null : CHARS[i]?.id ?? null);
    if (!b) return { code, status: 'empty', bout: null, labels: [null, null], fighters: [null, null], winner: null };
    const status = b.status === 'matching' ? 'waiting' : b.status === 'live' ? 'live' : 'done';
    return { code, status, bout: b.id, labels: [b.label1, b.label2], fighters: [ch(b.ch1), ch(b.ch2)], winner: b.winner };
  }

  /** Bouts keep the index fresh so the Watch list shows activity. */
  async touchBout(id: string): Promise<void> {
    this.sql.exec('UPDATE bouts SET updated = ? WHERE id = ? AND status = ?', Date.now(), id, 'live');
  }

  // ---------------------------------------------------------------- human results
  async submitResult(tokenHash: string, claim: HumanClaim): Promise<{ id: string; status: string } | Fail> {
    const e = this.byToken(tokenHash);
    if (!e) return fail(401, 'bad_token', 'Unknown or missing token.');
    if (e.kind !== 'human') return fail(403, 'humans_only', 'Agents are ranked through arena bouts.');
    const bad = validateClaim(claim);
    if (bad) return fail(400, 'bad_claim', bad);
    if (!this.allow(`res:${e.id}`, 40, HOUR)) return fail(429, 'rate_limited', 'Too many results this hour.');
    const digest = await sha256(JSON.stringify([claim.seed, claim.p1, claim.p2, claim.inputs]));
    if (this.row('SELECT id FROM results WHERE digest = ? AND entrant = ?', digest, e.id)) return fail(409, 'duplicate', 'This match was already submitted.');
    const id = randomId('r_');
    const now = Date.now();
    if (claim.kind === 'ai') {
      const level = claim.level ?? 0;
      this.sql.exec(`INSERT INTO results (id, entrant, side, board, level, status, digest, created) VALUES (?, ?, 0, 'player_ai', ?, 'verifying', ?, ?)`,
        id, e.id, level, digest, now);
      await this.env.JUDGE.getByName(id).start(id, claim, {
        board: 'player_ai', labels: [labelOf(e), `House AI · ${HOUSE_NAMES[level]}`], created: now,
      });
      return { id, status: 'verifying' };
    }
    // player vs player: counts once both players submitted the same match
    const opp = String(claim.opponent ?? '');
    if (!ENTRANT_ID.test(opp) || opp === e.id) return fail(400, 'bad_claim', 'Missing opponent id.');
    const side = claim.side === 1 ? 1 : 0;
    const key = `${claim.seed}:${[e.id, opp].sort().join(':')}`;
    this.sql.exec('DELETE FROM pvp_pending WHERE created < ?', now - HOUR);
    const pend = this.row<{ result: string; entrant: string; opponent: string; side: number; frames: number; winner: number; hash: number }>(
      'SELECT result, entrant, opponent, side, frames, winner, hash FROM pvp_pending WHERE key = ?', key);
    if (!pend) {
      this.sql.exec('INSERT INTO pvp_pending (key, result, entrant, opponent, side, frames, winner, hash, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        key, id, e.id, opp, side, claim.frames, claim.winner, claim.hash >>> 0, now);
      this.sql.exec(`INSERT INTO results (id, entrant, opponent, side, board, status, digest, created) VALUES (?, ?, ?, ?, 'player_player', 'pending_opponent', ?, ?)`,
        id, e.id, opp, side, digest, now);
      return { id, status: 'pending_opponent' };
    }
    if (pend.entrant === e.id) return fail(409, 'duplicate', 'You already submitted this match.');
    this.sql.exec('DELETE FROM pvp_pending WHERE key = ?', key);
    const agree = pend.entrant === opp && pend.opponent === e.id && pend.side !== side && pend.frames === claim.frames &&
      pend.winner === claim.winner && pend.hash === claim.hash >>> 0;
    if (!agree) {
      this.sql.exec(`UPDATE results SET status = 'rejected', detail = 'players disagree' WHERE id = ?`, pend.result);
      return fail(409, 'mismatch', 'The two players reported different matches.');
    }
    this.sql.exec(`INSERT INTO results (id, entrant, opponent, side, board, status, digest, pair, created) VALUES (?, ?, ?, ?, 'player_player', 'verifying', ?, ?, ?)`,
      id, e.id, opp, side, digest, pend.result, now);
    this.sql.exec(`UPDATE results SET status = 'verifying', pair = ? WHERE id = ?`, id, pend.result);
    const other = this.entrant(opp);
    const labels: [string, string] = side === 0 ? [labelOf(e), other ? labelOf(other) : '?'] : [other ? labelOf(other) : '?', labelOf(e)];
    await this.env.JUDGE.getByName(id).start(id, claim, { board: 'player_player', labels, created: now });
    return { id, status: 'verifying' };
  }

  /** Called by the Judge after re-simulating a human match. */
  async resultVerified(id: string, v: { ok: boolean; reason?: string; winner: number; frames: number; labels: [string, string]; p1: number; p2: number }): Promise<void> {
    const r = this.row<{ entrant: string; opponent: string | null; side: number; board: string; level: number | null; status: string; pair: string | null }>(
      'SELECT entrant, opponent, side, board, level, status, pair FROM results WHERE id = ?', id);
    if (!r || r.status !== 'verifying') return;
    const ids = [id, ...(r.pair ? [r.pair] : [])];
    if (!v.ok) {
      for (const x of ids) this.sql.exec(`UPDATE results SET status = 'rejected', detail = ? WHERE id = ?`, v.reason ?? 'replay mismatch', x);
      return;
    }
    const now = Date.now();
    if (r.board === 'player_ai') {
      const lvl = r.level ?? 0;
      const ch = this.rate(r.entrant, 'player_ai', HOUSE_RATING[lvl], v.winner === 0 ? 1 : 0, v.winner === 0 && lvl === 3);
      this.sql.exec(`UPDATE results SET status = 'verified', rating_json = ? WHERE id = ?`, JSON.stringify(ch), id);
      this.sql.exec(`INSERT OR IGNORE INTO bouts (id, board, mode, status, e1, label1, label2, ch1, ch2, level, winner, ended_by, frames, created, updated)
        VALUES (?, 'player_ai', 'human', 'done', ?, ?, ?, ?, ?, ?, ?, 'ko', ?, ?, ?)`, id, r.entrant, v.labels[0], v.labels[1], v.p1, v.p2, lvl, v.winner, v.frames, now, now);
      return;
    }
    // pvp: side 0 / side 1 entrants
    const e0 = r.side === 0 ? r.entrant : r.opponent!;
    const e1 = r.side === 0 ? r.opponent! : r.entrant;
    const r0 = this.ratingRow(e0, 'player_player')?.rating ?? START_RATING;
    const r1 = this.ratingRow(e1, 'player_player')?.rating ?? START_RATING;
    const c0 = this.rate(e0, 'player_player', r1, v.winner === 0 ? 1 : 0, false);
    const c1 = this.rate(e1, 'player_player', r0, v.winner === 1 ? 1 : 0, false);
    for (const x of ids) {
      const owner = this.row<{ entrant: string }>('SELECT entrant FROM results WHERE id = ?', x)!.entrant;
      this.sql.exec(`UPDATE results SET status = 'verified', rating_json = ? WHERE id = ?`, JSON.stringify(owner === e0 ? c0 : c1), x);
    }
    this.sql.exec(`INSERT OR IGNORE INTO bouts (id, board, mode, status, e1, e2, label1, label2, ch1, ch2, winner, ended_by, frames, created, updated)
      VALUES (?, 'player_player', 'human', 'done', ?, ?, ?, ?, ?, ?, ?, 'ko', ?, ?, ?)`, id, e0, e1, v.labels[0], v.labels[1], v.p1, v.p2, v.winner, v.frames, now, now);
  }

  async resultStatus(id: string, tokenHash: string | null): Promise<unknown> {
    const r = this.row<{ entrant: string; board: string; status: string; detail: string | null; rating_json: string | null; pair: string | null }>(
      'SELECT entrant, board, status, detail, rating_json, pair FROM results WHERE id = ?', id);
    if (!r) return fail(404, 'not_found', 'No such result.');
    const e = this.byToken(tokenHash);
    const mine = !!e && e.id === r.entrant;
    // the replay lives with whichever submission was verified
    const replayId = r.status === 'verified' && r.pair && !this.row('SELECT id FROM bouts WHERE id = ?', id) ? r.pair : id;
    return { id, board: r.board, status: r.status, reason: r.detail, rating: mine && r.rating_json ? JSON.parse(r.rating_json) : null, replay: r.status === 'verified' ? replayId : null };
  }
}

function stripSide(s: SideMeta) {
  return { kind: s.kind, id: s.id, label: s.label, level: s.level };
}

function newMeta(id: string, board: 'agent_house' | 'agent_agent', mode: BoutMeta['mode'], seed: number, sides: SideMeta[], origin: string, code: string | null): BoutMeta {
  const now = Date.now();
  return {
    id, board, mode, status: sides.length === 2 ? 'live' : 'matching', code, created: now, updated: now, seed, sides,
    deadline: [0, 0], strikes: [0, 0], seen: [now, 0], chunks: 0, frames: 0, winner: -1, endedBy: null, ratings: [null, null], origin,
  };
}

function validateClaim(c: HumanClaim): string | null {
  if (!c || typeof c !== 'object') return 'missing claim';
  if (c.kind !== 'ai' && c.kind !== 'pvp') return 'kind must be ai or pvp';
  const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  if (!int(c.seed, 0, 0xffffffff)) return 'bad seed';
  if (!int(c.p1, 0, CHARS.length - 1) || !int(c.p2, 0, CHARS.length - 1)) return 'bad fighters';
  if (!int(c.frames, 10, MAX_MATCH_FRAMES)) return 'bad frame count';
  if (!int(c.winner, 0, 1)) return 'bad winner';
  if (!Number.isInteger(c.hash)) return 'bad hash';
  if (c.kind === 'ai' && !int(c.level, 0, 3)) return 'bad level';
  const need = c.kind === 'ai' ? 1 : 2;
  if (!Array.isArray(c.inputs) || c.inputs.length !== need) return 'bad inputs';
  for (const runs of c.inputs) {
    if (!Array.isArray(runs) || runs.length > 40000 || runs.length % 2) return 'bad inputs';
    for (const n of runs) if (!Number.isInteger(n) || n < 0 || n > 0xffff) return 'bad inputs';
  }
  return null;
}
