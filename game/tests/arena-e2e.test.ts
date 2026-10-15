// End-to-end test against a running arena server: ARENA_URL=http://127.0.0.1:8787 npx vitest run tests/arena-e2e.test.ts
import { describe, expect, it } from 'vitest';
import { AIController } from '../src/ai/ai';
import { rleDecode, rleEncode } from '../src/arena/rle';
import { HumanClaim, ReplayData, rankedHouseAI } from '../src/arena/replay';
import { PH } from '../src/sim/defs';
import { createMatch, hashMatch, step } from '../src/sim/sim';

const API: string = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.ARENA_URL ?? '';

async function call(path: string, opts: { token?: string; body?: unknown; method?: string } = {}): Promise<any> {
  const res = await fetch(API + path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, ...data };
}

/** A plain heuristic agent, like an LLM following agents.md would play. */
function choose(v: any): string[] {
  const legal: string[] = v.legal;
  const t: string[] = v.state.tags;
  const d: number = v.state.distance;
  if (v.decision === 'combo') return ['burst'];
  if (legal.includes('secret') && d < 1.1) return ['secret'];
  if (t.includes('opponent_open') || t.includes('opponent_recovering')) return [d < 1 ? 'launcher_combo' : 'lunge'];
  if (t.includes('opponent_charging_focus')) return ['poke'];
  if (t.includes('opponent_attacking')) return ['deflect'];
  if (d > 2.2) return ['dash_in'];
  if (d > 1) return ['advance'];
  return [['strike_chain', 'sweep', 'guard', 'launcher_combo', 'focus'][v.turn % 5]];
}

async function play(token: string, first: any, stats = { turns: 0, polls: 0 }): Promise<any> {
  let v = first;
  let n = 0;
  while (v.status !== 'finished' && n++ < 2000) {
    if (v.status === 'your_turn') {
      stats.turns++;
      v = await call(`/api/bouts/${v.bout}/turn`, { token, body: { actions: choose(v), say: 'Hyah!' } });
      expect(v.error).toBeUndefined();
    } else {
      stats.polls++;
      v = await call(`/api/bouts/${v.bout}?wait=10`, { token });
    }
  }
  return v;
}

async function replayHash(id: string): Promise<{ hash: number; winner: number; data: ReplayData }> {
  const r: ReplayData = await call(`/api/replays/${id}`);
  const a = rleDecode(r.inputs[0]);
  const b = rleDecode(r.inputs[1]);
  const s = createMatch({ p1: r.p1, p2: r.p2, seed: r.seed });
  for (let f = 0; f < a.length; f++) step(s, a[f], b[f]);
  return { hash: hashMatch(s), winner: s.matchWinner, data: r };
}

function humanMatch(seed: number, level: 0 | 1 | 2 | 3, p1: number, p2: number) {
  const s = createMatch({ p1, p2, seed });
  const human = new AIController(0, 3, seed ^ 1);
  const house = rankedHouseAI(seed, level);
  const bits: number[] = [];
  while (s.phase !== PH.MATCH_END) {
    const a = human.read(s);
    bits.push(a);
    step(s, a, house.read(s));
  }
  return { s, bits };
}

describe.skipIf(!API)('arena server e2e', () => {
  const tag = Math.random().toString(36).slice(2, 6);

  it('serves the agent manual', async () => {
    const res = await fetch(API + '/agents.md');
    const text = await res.text();
    expect(text).toContain('INKFIST Arena');
    expect(text).toContain(`API=${API}`);
  });

  it('agent vs house: full bout, rating and exact replay', async () => {
    const reg = await call('/api/register', { body: { name: `Tester${tag}`, agent: 'Heuristic 1' } });
    expect(reg.token).toMatch(/^ik_/);
    const start = await call('/api/bouts', { token: reg.token, body: { mode: 'house', level: 'novice', fighter: 'mujin' } });
    expect(start.status).toBe('your_turn');
    const again = await call('/api/bouts', { token: reg.token, body: { mode: 'house' } });
    expect(again.error).toBe('live_bout');
    const end = await play(reg.token, start);
    expect(end.result.rating.board).toBe('agent_house');
    const r = await replayHash(end.bout);
    expect(r.winner).toBe(end.result.winner === 'you' ? 0 : 1);
    expect(r.data.turns.length).toBeGreaterThan(10);
    const lb = await call('/api/leaderboard?board=agent_house');
    expect(lb.entries.some((e: any) => e.id === reg.id && e.label === `Tester${tag}: Heuristic 1`)).toBe(true);
  }, 120_000);

  it('agent vs agent through the versus queue', async () => {
    const a = await call('/api/register', { body: { name: `Ann${tag}`, agent: 'Bot A' } });
    const b = await call('/api/register', { body: { name: `Ben${tag}`, agent: 'Bot B' } });
    const qa = await call('/api/bouts', { token: a.token, body: { mode: 'versus', fighter: 'seolhwa' } });
    expect(qa.status).toBe('matching');
    const qb = await call('/api/bouts', { token: b.token, body: { mode: 'versus', fighter: 'hyeongong' } });
    expect(qb.bout).toBe(qa.bout);
    const [ea, eb] = await Promise.all([play(a.token, await call(`/api/bouts/${qa.bout}`, { token: a.token })), play(b.token, qb)]);
    expect([ea.result.winner, eb.result.winner].sort()).toEqual(['opponent', 'you']);
    expect(ea.result.rating.board).toBe('agent_agent');
    const r = await replayHash(qa.bout);
    expect(r.winner).toBe(ea.result.winner === 'you' ? 0 : 1);
  }, 180_000);

  it('challenge codes', async () => {
    const a = await call('/api/register', { body: { name: `Cat${tag}`, agent: 'Bot C' } });
    const b = await call('/api/register', { body: { name: `Dan${tag}`, agent: 'Bot D' } });
    const ca = await call('/api/bouts', { token: a.token, body: { mode: 'challenge' } });
    expect(ca.code).toMatch(/^[A-Z]{5}$/);
    const cb = await call('/api/bouts', { token: b.token, body: { mode: 'challenge', code: ca.code } });
    expect(cb.bout).toBe(ca.bout);
    const res = await call(`/api/bouts/${ca.bout}/resign`, { token: a.token, body: {} });
    expect(res.result.winner).toBe('opponent');
    expect(res.result.endedBy ?? res.result.endedBy).toBe('forfeit');
  }, 60_000);

  it('agent duel: both agents send the identical request, spectators follow the room', async () => {
    const code = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[(Math.random() * 24) | 0]).join('');
    const a = await call('/api/register', { body: { name: `Eve${tag}`, agent: 'Claude Opus 5.5' } });
    const b = await call('/api/register', { body: { name: `Finn${tag}`, agent: 'Gemini 3' } });
    const empty = await call(`/api/duels/${code}`);
    expect(empty.status).toBe('empty');
    const da = await call('/api/bouts', { token: a.token, body: { mode: 'challenge', code } });
    expect(da.status).toBe('matching');
    expect(da.code).toBe(code);
    const waiting = await call(`/api/duels/${code}`);
    expect(waiting.status).toBe('waiting');
    expect(waiting.labels[0]).toBe(`Eve${tag}: Claude Opus 5.5`);
    const db = await call('/api/bouts', { token: b.token, body: { mode: 'duel', code: code.toLowerCase() } });
    expect(db.bout).toBe(da.bout);
    expect(['your_turn', 'waiting']).toContain(db.status);
    const live = await call(`/api/duels/${code}`);
    expect(live.status).toBe('live');
    const c = await call('/api/register', { body: { name: `Gus${tag}`, agent: 'Bot' } });
    const busy = await call('/api/bouts', { token: c.token, body: { mode: 'challenge', code } });
    expect(busy.error).toBe('code_in_use');
    const sa = { turns: 0, polls: 0 }, sb = { turns: 0, polls: 0 };
    const [ea, eb] = await Promise.all([play(a.token, await call(`/api/bouts/${da.bout}`, { token: a.token }), sa), play(b.token, db, sb)]);
    expect([ea.result.winner, eb.result.winner].sort()).toEqual(['opponent', 'you']);
    // POST /turn waits for the opponent, so agents rarely need a separate polling call
    expect(sa.polls + sb.polls).toBeLessThan((sa.turns + sb.turns) / 4);
    const done = await call(`/api/duels/${code}`);
    expect(done.status).toBe('done');
    expect(done.winner).toBe(ea.result.winner === 'you' ? 0 : 1);
    const list = await call(`/api/bouts?status=recent&limit=50&n=${tag}d`);
    expect(list.bouts.find((x: any) => x.id === da.bout)?.mode).toBe('challenge');
  }, 240_000);

  it('lists agents waiting in the versus queue', async () => {
    const g = await call('/api/register', { body: { name: `Hal${tag}`, agent: 'Waiter' } });
    const q = await call('/api/bouts', { token: g.token, body: { mode: 'versus' } });
    expect(q.status).toBe('matching');
    const open = await call(`/api/bouts?status=open&n=${tag}o`);
    expect(open.bouts.some((x: any) => x.id === q.bout && x.labels[0] === `Hal${tag}: Waiter`)).toBe(true);
    const r = await call(`/api/bouts/${q.bout}/resign`, { token: g.token, body: {} });
    expect(r.status).toBe('void');
  }, 30_000);

  it('verifies human results and rejects forgeries', async () => {
    const h = await call('/api/register', { body: { name: `Human${tag}`, human: true } });
    const { s, bits } = humanMatch(777 + tag.length, 2, 0, 1);
    const claim: HumanClaim = { kind: 'ai', seed: 777 + tag.length, p1: 0, p2: 1, level: 2, inputs: [rleEncode(bits)], frames: s.frame, winner: s.matchWinner, hash: hashMatch(s) };
    const sub = await call('/api/results', { token: h.token, body: claim });
    expect(sub.status).toBe('verifying');
    const forged = await call('/api/results', { token: h.token, body: { ...claim, inputs: [rleEncode(bits.map((b, i) => (i === 900 ? 16 : b)))], winner: 0 } });
    let st: any, fs: any;
    for (let i = 0; i < 60; i++) {
      st = await call(`/api/results/${sub.id}`, { token: h.token });
      fs = await call(`/api/results/${forged.id}`, { token: h.token });
      if (st.status !== 'verifying' && fs.status !== 'verifying') break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(st.status).toBe('verified');
    expect(st.rating.board).toBe('player_ai');
    expect(fs.status).toBe('rejected');
    const r = await replayHash(st.replay);
    expect(r.hash).toBe(hashMatch(s));
  }, 60_000);

  it('player vs player counts once both players agree', async () => {
    const h1 = await call('/api/register', { body: { name: `P1${tag}`, human: true } });
    const h2 = await call('/api/register', { body: { name: `P2${tag}`, human: true } });
    const seed = 4040 + tag.length;
    const s = createMatch({ p1: 2, p2: 0, seed });
    const x = new AIController(0, 2, 1), y = new AIController(1, 2, 2);
    const i0: number[] = [], i1: number[] = [];
    while (s.phase !== PH.MATCH_END) {
      const a = x.read(s), b = y.read(s);
      i0.push(a); i1.push(b);
      step(s, a, b);
    }
    const base = { kind: 'pvp' as const, seed, p1: 2, p2: 0, inputs: [rleEncode(i0), rleEncode(i1)], frames: s.frame, winner: s.matchWinner, hash: hashMatch(s) };
    const a = await call('/api/results', { token: h1.token, body: { ...base, side: 0, opponent: h2.id } });
    expect(a.status).toBe('pending_opponent');
    const b = await call('/api/results', { token: h2.token, body: { ...base, side: 1, opponent: h1.id } });
    expect(b.status).toBe('verifying');
    let st: any;
    for (let i = 0; i < 60; i++) {
      st = await call(`/api/results/${a.id}`, { token: h1.token });
      if (st.status !== 'verifying') break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(st.status).toBe('verified');
    expect(st.rating.board).toBe('player_player');
    const lb = await call('/api/leaderboard?board=player_player&limit=100');
    expect(lb.entries.filter((e: any) => e.id === h1.id || e.id === h2.id).length).toBe(2);
  }, 60_000);

  it('MCP tools work', async () => {
    const rpc = async (method: string, params: unknown, token?: string) => {
      const res = await fetch(API + '/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return res.json() as Promise<any>;
    };
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(init.result.serverInfo.name).toBe('inkfist-arena');
    const tools = await rpc('tools/list', {});
    expect(tools.result.tools.map((t: any) => t.name)).toContain('inkfist_act');
    const reg = await rpc('tools/call', { name: 'inkfist_register', arguments: { name: `Mcp${tag}`, agent: 'MCP Bot' } });
    const token = reg.result.structuredContent.token;
    const st = await rpc('tools/call', { name: 'inkfist_start_bout', arguments: { mode: 'house', level: 'gosu' } }, token);
    expect(st.result.structuredContent.status).toBe('your_turn');
    const act = await rpc('tools/call', { name: 'inkfist_act', arguments: { bout: st.result.structuredContent.bout, action: 'guard' } }, token);
    expect(act.result.isError).toBe(false);
    const bad = await rpc('tools/call', { name: 'inkfist_act', arguments: { bout: st.result.structuredContent.bout, action: 'fly' } }, token);
    expect(bad.result.isError).toBe(true);
    await rpc('tools/call', { name: 'inkfist_resign', arguments: { bout: st.result.structuredContent.bout } }, token);
  }, 60_000);
});
