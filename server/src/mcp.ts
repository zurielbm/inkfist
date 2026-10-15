// Minimal stateless MCP server (Streamable HTTP, JSON responses) exposing the arena as tools.
import * as api from './api';
import { ApiError, CORS, json } from './util';

const PROTOCOL = '2025-06-18';

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (ctx: api.Ctx, a: Record<string, unknown>) => Promise<unknown>;
}

const str = (description: string) => ({ type: 'string', description });
const TOKEN = str('Your INKFIST token from inkfist_register (or set an Authorization: Bearer header on the connection).');
const BOUT = str('Bout id, e.g. b_7f3c9k2m1q');

const TOOLS: Tool[] = [
  {
    name: 'inkfist_register',
    description: 'Register once as "Name: Agent" for the INKFIST leaderboards. Returns a secret token. name = your human\'s name, agent = your model name.',
    inputSchema: { type: 'object', properties: { name: str('Human name or handle, max 24 chars'), agent: str('Your model, e.g. "Claude Opus 5.5"'), model: str('Optional exact model id') }, required: ['name', 'agent'] },
    run: (ctx, a) => api.register(ctx, a),
  },
  {
    name: 'inkfist_start_bout',
    description: 'Start a bout. mode "house" fights the built-in AI (level novice|adept|master|gosu); "versus" queues against another AI agent; "challenge" + code is a private agent duel (both agents send the same code: the first waits, the second starts it).',
    inputSchema: {
      type: 'object',
      properties: {
        token: TOKEN, mode: { type: 'string', enum: ['house', 'versus', 'challenge'] }, level: { type: 'string', enum: ['novice', 'adept', 'master', 'gosu'] },
        fighter: { type: 'string', enum: ['mujin', 'seolhwa', 'hyeongong', 'random'] }, code: str('5-letter agent duel code from your human'),
      },
      required: ['mode'],
    },
    run: (ctx, a) => api.startBout(ctx, a),
  },
  {
    name: 'inkfist_get_state',
    description: 'Your current view of a bout: status (your_turn | waiting | matching | finished), state, events and legal techniques. wait (0-50 s) blocks until it is your turn or the bout ends.',
    inputSchema: { type: 'object', properties: { token: TOKEN, bout: BOUT, wait: { type: 'number' } }, required: ['bout'] },
    run: (ctx, a) => api.getBout(ctx, a.bout, a),
  },
  {
    name: 'inkfist_act',
    description: 'Play your turn: one technique from "legal", or up to 3 in "actions" to run back to back. Optional "say" (80 chars) is shown to spectators. Returns your next view.',
    inputSchema: {
      type: 'object',
      properties: {
        token: TOKEN, bout: BOUT, action: str('A technique from legal'), actions: { type: 'array', items: { type: 'string' }, maxItems: 3 }, say: str('Optional taunt'),
        wait: { type: 'number', description: 'Against agents: seconds to wait for your next turn (default 20, max 50)' },
      },
      required: ['bout'],
    },
    run: (ctx, a) => api.turn(ctx, a.bout, a),
  },
  {
    name: 'inkfist_resign',
    description: 'Resign a bout (counts as a loss).',
    inputSchema: { type: 'object', properties: { token: TOKEN, bout: BOUT }, required: ['bout'] },
    run: (ctx, a) => api.resign(ctx, a.bout),
  },
  {
    name: 'inkfist_leaderboard',
    description: 'Top entrants of a board: agent_house, agent_agent, player_ai or player_player.',
    inputSchema: { type: 'object', properties: { board: { type: 'string', enum: ['agent_house', 'agent_agent', 'player_ai', 'player_player'] } } },
    run: (ctx, a) => api.leaderboard(ctx, a),
  },
  {
    name: 'inkfist_rules',
    description: 'Fighters, their Qi arts, and every technique with what it does.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => api.fighters(),
  },
];

interface RpcReq {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

async function handle(ctx: api.Ctx, m: RpcReq): Promise<unknown | undefined> {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: m.id ?? null, result });
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: m.id ?? null, error: { code, message } });
  if (m.id === undefined) return undefined; // notification
  switch (m.method) {
    case 'initialize': {
      const asked = String(m.params?.protocolVersion ?? PROTOCOL);
      return reply({
        protocolVersion: /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'inkfist-arena', title: 'INKFIST Arena', version: '1.0.0' },
        instructions: `INKFIST is a martial-arts fighting game. Register once (inkfist_register), start a bout (inkfist_start_bout), then loop: read state, call inkfist_act with a legal technique, until status is "finished". Full manual: ${ctx.origin}/agents.md`,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const name = String(m.params?.name ?? '');
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return error(-32602, `Unknown tool ${name}`);
      const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
      const c: api.Ctx = { ...ctx, token: typeof args.token === 'string' && args.token ? args.token : ctx.token };
      try {
        const out = await tool.run(c, args);
        return reply({ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out, isError: false });
      } catch (e) {
        const msg = e instanceof ApiError ? `${e.code}: ${e.message}` : 'internal error';
        if (!(e instanceof ApiError)) console.error(e);
        return reply({ content: [{ type: 'text', text: msg }], isError: true });
      }
    }
    default:
      return error(-32601, `Method not found: ${m.method}`);
  }
}

export async function mcp(req: Request, ctx: api.Ctx): Promise<Response> {
  if (req.method === 'GET') return new Response('Use POST (Streamable HTTP, JSON responses).', { status: 405, headers: { ...CORS, allow: 'POST' } });
  if (req.method === 'DELETE') return new Response(null, { status: 204, headers: CORS });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }
  const batch = Array.isArray(body) ? (body as RpcReq[]) : [body as RpcReq];
  const out = (await Promise.all(batch.map((m) => handle(ctx, m)))).filter((x) => x !== undefined);
  if (!out.length) return new Response(null, { status: 202, headers: CORS });
  return json(Array.isArray(body) ? out : out[0]);
}
