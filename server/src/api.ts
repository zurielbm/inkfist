// Arena API operations, shared by the REST routes and the MCP tools.
import { BOARDS, HumanClaim } from '../../game/src/arena/replay';
import { HOUSE_NAMES } from '../../game/src/arena/rating';
import { TECHNIQUES } from '../../game/src/arena/pilot';
import { fighterBrief } from '../../game/src/arena/observe';
import { CHARS } from '../../game/src/sim/chars';
import { MAX_WAIT } from './bout';
import { ApiError, BOUT_ID, Env, RESULT_ID, ok, sha256 } from './util';

export interface Ctx {
  env: Env;
  ip: string;
  origin: string;
  token: string | null;
}

export type Params = Record<string, unknown>;

async function tokenHash(ctx: Ctx): Promise<string | null> {
  const t = ctx.token?.trim();
  return t ? sha256(t) : null;
}

async function needToken(ctx: Ctx): Promise<string> {
  const h = await tokenHash(ctx);
  if (!h) throw new ApiError(401, 'no_token', 'Send your token: header "Authorization: Bearer <token>" (or ?token=). Register with POST /api/register.');
  return h;
}

function arena(ctx: Ctx) {
  return ctx.env.ARENA.getByName('main');
}

function boutId(id: unknown): string {
  const s = String(id ?? '');
  if (!BOUT_ID.test(s)) throw new ApiError(400, 'bad_bout_id', 'Bout ids look like b_xxxxxxxxxx.');
  return s;
}

export function parseFighter(v: unknown): number {
  if (v === undefined || v === null || v === '' || v === 'random') return -1;
  const s = String(v).toLowerCase().replace(/[^a-z0-9]/g, '');
  const i = CHARS.findIndex((c) => c.id === s || c.name.toLowerCase().replace(/[^a-z]/g, '').startsWith(s));
  if (i >= 0) return i;
  const n = Number(v);
  if (Number.isInteger(n) && n >= 0 && n < CHARS.length) return n;
  throw new ApiError(400, 'bad_fighter', `Unknown fighter "${v}". Use ${CHARS.map((c) => c.id).join(', ')} or random.`);
}

export function parseLevel(v: unknown): number {
  if (v === undefined || v === null || v === '') return 1;
  const s = String(v).toLowerCase();
  const i = HOUSE_NAMES.findIndex((n) => n.toLowerCase() === s);
  if (i >= 0) return i;
  const n = Number(v);
  if (Number.isInteger(n) && n >= 0 && n <= 3) return n;
  throw new ApiError(400, 'bad_level', `Unknown level "${v}". Use ${HOUSE_NAMES.map((n) => n.toLowerCase()).join(', ')}.`);
}

function actionsOf(p: Params): string[] {
  const a = p.actions ?? p.action;
  if (Array.isArray(a)) return a.map(String);
  if (typeof a === 'string') return a.split(',').map((x) => x.trim()).filter(Boolean);
  throw new ApiError(400, 'no_action', 'Send "action": a technique name from "legal" (or "actions": up to 3).');
}

// ---------------------------------------------------------------- operations
export async function register(ctx: Ctx, p: Params): Promise<unknown> {
  const human = p.human === true || p.human === 'true' || p.human === '1';
  const res = ok(await arena(ctx).register({ name: p.name, agent: p.agent, model: p.model, human, tokenHash: await tokenHash(ctx), ip: ctx.ip }));
  if (!res.token) return res;
  return {
    ...res,
    note: 'Keep this token secret and send it as "Authorization: Bearer <token>". Next: POST /api/bouts {"mode":"house","level":"master","fighter":"random"}',
  };
}

export async function startBout(ctx: Ctx, p: Params): Promise<unknown> {
  const h = await needToken(ctx);
  let mode = String(p.mode ?? 'house').toLowerCase();
  if (mode === 'duel') mode = 'challenge';
  if (mode !== 'house' && mode !== 'versus' && mode !== 'challenge') throw new ApiError(400, 'bad_mode', 'mode is "house", "versus" or "challenge" (agent duel).');
  const code = p.code ? String(p.code).toUpperCase().replace(/[^A-Z]/g, '') : null;
  if (code !== null && code.length !== 5) throw new ApiError(400, 'bad_code', 'Duel codes are 5 letters, e.g. KQZTA.');
  const { id } = ok(await arena(ctx).startBout({
    tokenHash: h, mode, level: parseLevel(p.level ?? p.difficulty), fighter: parseFighter(p.fighter), code, origin: ctx.origin,
  }));
  return ok(await ctx.env.BOUT.getByName(id).view(h, 0));
}

function waitOf(p: Params): number | undefined {
  if (p.wait === undefined || p.wait === '') return undefined;
  return Math.min(MAX_WAIT, Math.max(0, Number(p.wait) || 0));
}

export async function getBout(ctx: Ctx, id: unknown, p: Params): Promise<unknown> {
  return ok(await ctx.env.BOUT.getByName(boutId(id)).view(await tokenHash(ctx), waitOf(p) ?? 0));
}

export async function turn(ctx: Ctx, id: unknown, p: Params): Promise<unknown> {
  const h = await needToken(ctx);
  const say = p.say === undefined ? undefined : String(p.say);
  return ok(await ctx.env.BOUT.getByName(boutId(id)).turn(h, actionsOf(p), say, waitOf(p)));
}

export async function duel(ctx: Ctx, code: unknown): Promise<unknown> {
  const c = String(code ?? '').toUpperCase();
  if (!/^[A-Z]{5}$/.test(c)) throw new ApiError(400, 'bad_code', 'Duel codes are 5 letters, e.g. KQZTA.');
  return arena(ctx).duel(c);
}

export async function resign(ctx: Ctx, id: unknown): Promise<unknown> {
  return ok(await ctx.env.BOUT.getByName(boutId(id)).resign(await needToken(ctx)));
}

export async function replay(ctx: Ctx, id: unknown, p: Params): Promise<unknown> {
  const s = String(id ?? '');
  if (BOUT_ID.test(s)) return ok(await ctx.env.BOUT.getByName(s).replay(Math.max(0, Number(p.from ?? 0) || 0)));
  if (RESULT_ID.test(s)) return ok(await ctx.env.JUDGE.getByName(s).replay());
  throw new ApiError(400, 'bad_id', 'Replay ids look like b_xxxxxxxxxx or r_xxxxxxxxxx.');
}

export async function leaderboard(ctx: Ctx, p: Params): Promise<unknown> {
  const board = String(p.board ?? 'agent_house');
  if (!(BOARDS as readonly string[]).includes(board)) throw new ApiError(400, 'bad_board', `board is one of ${BOARDS.join(', ')}.`);
  const limit = Math.min(100, Math.max(1, Number(p.limit ?? 50) || 50));
  return arena(ctx).leaderboard(board, limit);
}

export async function listBouts(ctx: Ctx, p: Params): Promise<unknown> {
  const status = p.status === 'recent' ? 'recent' : p.status === 'open' ? 'open' : 'live';
  const limit = Math.min(50, Math.max(1, Number(p.limit ?? 20) || 20));
  return arena(ctx).listBouts(status, limit);
}

export async function me(ctx: Ctx): Promise<unknown> {
  return ok(await arena(ctx).me(await needToken(ctx)));
}

export async function submitResult(ctx: Ctx, p: Params): Promise<unknown> {
  const h = await needToken(ctx);
  return ok(await arena(ctx).submitResult(h, (p.claim ?? p) as HumanClaim));
}

export async function resultStatus(ctx: Ctx, id: unknown): Promise<unknown> {
  const s = String(id ?? '');
  if (!RESULT_ID.test(s)) throw new ApiError(400, 'bad_id', 'Result ids look like r_xxxxxxxxxx.');
  return ok(await arena(ctx).resultStatus(s, await tokenHash(ctx)));
}

export function fighters(): unknown {
  return {
    fighters: CHARS.map((c) => fighterBrief(c.id)),
    techniques: TECHNIQUES,
    houseLevels: HOUSE_NAMES.map((n) => n.toLowerCase()),
  };
}
