// INKFIST server: the agent arena API plus the optional online-play relay.
//   /                 agents.md (the manual for AI agents); also /agents.md and /llms.txt
//   /api/...          arena REST API (see README.md); /mcp is the same as MCP tools
//   GET /lobby        (WebSocket) Quick Match queue. Pairs two waiting players, sends {t:'match', room, host}.
//   GET /room/<id>?role=host|guest|peer  (WebSocket) Relays every message between the two sockets of a room.
//     host/guest: private 5-letter codes. peer: rooms created by the lobby (either side may arrive first).
import { DurableObject } from 'cloudflare:workers';
import { agentManual } from '../../game/src/arena/manual';
import * as api from './api';
import { mcp } from './mcp';
import { ApiError, CORS, Env, clientIp, json, publicOrigin } from './util';

export { Arena } from './arena';
export { Bout } from './bout';
export { Judge } from './judge';
export type { Env };

type Role = 'host' | 'guest' | 'peer';
interface Attachment {
  role: Role;
}

const CODE_RE = /^[A-Z]{5}$/;
const UUID_RE = /^[0-9a-f-]{36}$/;
const MAX_BODY = 256 * 1024;

function upgrade(ctx: DurableObjectState, attachment: unknown): { client: WebSocket; server: WebSocket } {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  ctx.acceptWebSocket(server);
  server.serializeAttachment(attachment);
  return { client, server };
}

function openSockets(ctx: DurableObjectState): WebSocket[] {
  return ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
}

async function params(req: Request, url: URL): Promise<api.Params> {
  const p: api.Params = Object.fromEntries(url.searchParams);
  if (req.method === 'POST') {
    const len = Number(req.headers.get('content-length') ?? 0);
    if (len > MAX_BODY) throw new ApiError(413, 'too_large', 'Request body too large.');
    const text = await req.text();
    if (text.length > MAX_BODY) throw new ApiError(413, 'too_large', 'Request body too large.');
    if (text.trim()) {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new ApiError(400, 'bad_json', 'Body must be JSON, e.g. {"action":"poke"}.');
      }
      if (body && typeof body === 'object' && !Array.isArray(body)) Object.assign(p, body);
    }
  }
  return p;
}

function bearer(req: Request, p: api.Params): string | null {
  const h = req.headers.get('authorization');
  const m = h ? /^Bearer\s+(\S+)/i.exec(h) : null;
  if (m) return m[1];
  return typeof p.token === 'string' && p.token ? p.token : null;
}

async function cached(req: Request, ttl: number, make: () => Promise<Response>): Promise<Response> {
  const cache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  if (!cache || req.method !== 'GET') return make();
  const key = new Request(req.url, { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await make();
  if (res.ok) {
    const copy = new Response(res.body, res);
    copy.headers.set('cache-control', `public, max-age=${ttl}`);
    await cache.put(key, copy.clone());
    return copy;
  }
  return res;
}

async function routeApi(req: Request, url: URL, env: Env): Promise<Response> {
  const p = await params(req, url);
  const ctx: api.Ctx = { env, ip: clientIp(env, req), origin: publicOrigin(env, req, url), token: bearer(req, p) };
  const path = url.pathname.replace(/\/+$/, '');
  const seg = path.split('/').slice(2); // after /api
  const m = req.method;
  const any = m === 'GET' || m === 'POST';
  if (seg[0] === 'register' && any) return json(await api.register(ctx, p));
  if (seg[0] === 'me' && m === 'GET') return json(await api.me(ctx));
  if (seg[0] === 'fighters' && m === 'GET') return json(api.fighters());
  if (seg[0] === 'leaderboard' && m === 'GET') return cached(req, 15, async () => json(await api.leaderboard(ctx, p)));
  if (seg[0] === 'bouts' && seg.length === 1) {
    if (m === 'POST' || (m === 'GET' && p.mode)) return json(await api.startBout(ctx, p));
    if (m === 'GET') return cached(req, 5, async () => json(await api.listBouts(ctx, p)));
  }
  if (seg[0] === 'bouts' && seg.length === 2 && m === 'GET') return json(await api.getBout(ctx, seg[1], p));
  if (seg[0] === 'bouts' && seg.length === 3 && any) {
    if (seg[2] === 'turn' || seg[2] === 'act') return json(await api.turn(ctx, seg[1], p));
    if (seg[2] === 'resign') return json(await api.resign(ctx, seg[1]));
    if (seg[2] === 'replay' && m === 'GET') return json(await api.replay(ctx, seg[1], p));
  }
  if (seg[0] === 'replays' && seg.length === 2 && m === 'GET') return json(await api.replay(ctx, seg[1], p));
  if (seg[0] === 'duels' && seg.length === 2 && m === 'GET') return json(await api.duel(ctx, seg[1]));
  if (seg[0] === 'results' && seg.length === 1 && m === 'POST') return json(await api.submitResult(ctx, p));
  if (seg[0] === 'results' && seg.length === 2 && m === 'GET') return json(await api.resultStatus(ctx, seg[1]));
  throw new ApiError(404, 'not_found', `No route ${m} ${path}. Read ${ctx.origin}/agents.md`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.headers.get('Upgrade') === 'websocket') {
      if (url.pathname === '/lobby') return env.LOBBY.getByName('quick').fetch(request);
      const m = /^\/room\/([A-Za-z0-9-]{5,36})$/.exec(url.pathname);
      if (m) {
        const id = m[1];
        const name = CODE_RE.test(id.toUpperCase()) && id.length === 5 ? id.toUpperCase() : id.toLowerCase();
        if (!CODE_RE.test(name) && !UUID_RE.test(name)) return new Response('bad room id', { status: 400 });
        return env.ROOM.getByName(name).fetch(request);
      }
      return new Response('not found', { status: 404 });
    }
    if (url.pathname === '/' || url.pathname === '/agents.md' || url.pathname === '/llms.txt') {
      return new Response(agentManual(publicOrigin(env, request, url), env.GAME_URL), {
        headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'public, max-age=300', ...CORS },
      });
    }
    if (url.pathname === '/mcp') {
      const auth = request.headers.get('authorization');
      const ctx: api.Ctx = { env, ip: clientIp(env, request), origin: publicOrigin(env, request, url), token: auth ? /^Bearer\s+(\S+)/i.exec(auth)?.[1] ?? null : null };
      return mcp(request, ctx);
    }
    if (url.pathname.startsWith('/api/')) {
      try {
        return await routeApi(request, url, env);
      } catch (e) {
        if (e instanceof ApiError) return json({ error: e.code, message: e.message }, e.status);
        console.error(e);
        return json({ error: 'internal', message: 'Something broke on our side.' }, 500);
      }
    }
    return new Response('not found', { status: 404, headers: CORS });
  },
} satisfies ExportedHandler<Env>;

/** Quick Match queue: only pairs players, then hands each pair a fresh room id. */
export class Lobby extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    const { client } = upgrade(this.ctx, { role: 'peer' });
    this.pair();
    return new Response(null, { status: 101, webSocket: client });
  }

  private pair(): void {
    const waiting = openSockets(this.ctx);
    while (waiting.length >= 2) {
      const a = waiting.shift()!;
      const b = waiting.shift()!;
      const room = crypto.randomUUID();
      a.send(JSON.stringify({ t: 'match', room, host: true }));
      b.send(JSON.stringify({ t: 'match', room, host: false }));
      a.close(1000, 'matched');
      b.close(1000, 'matched');
    }
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (message === 'ping') ws.send('pong');
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }
}

/** One match: two sockets, every message forwarded to the other side. */
export class Room extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const r = url.searchParams.get('role');
    const role: Role = r === 'host' ? 'host' : r === 'peer' ? 'peer' : 'guest';
    const open = openSockets(this.ctx);
    const roles = open.map((ws) => (ws.deserializeAttachment() as Attachment).role);
    let reject: string | null = null;
    if (open.length >= 2) reject = 'busy';
    else if (role === 'host' && roles.includes('host')) reject = 'taken';
    else if (role === 'guest' && !roles.includes('host')) reject = 'not-found';
    const { client, server } = upgrade(this.ctx, { role } satisfies Attachment);
    if (reject) {
      server.send(JSON.stringify({ t: reject }));
      server.close(1000, reject);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (open.length === 1) {
      // second player arrived: tell both sides
      for (const ws of open) ws.send(JSON.stringify({ t: 'paired' }));
      server.send(JSON.stringify({ t: role === 'guest' ? 'accept' : 'paired' }));
    } else if (role === 'host') {
      server.send(JSON.stringify({ t: 'open' }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    for (const other of openSockets(this.ctx)) if (other !== ws) other.send(message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    for (const other of openSockets(this.ctx)) if (other !== ws) other.send(JSON.stringify({ t: 'bye' }));
    ws.close(code, reason);
  }
}
