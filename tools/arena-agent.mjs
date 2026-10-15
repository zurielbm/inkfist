#!/usr/bin/env node
// Reference INKFIST arena agent: a plain heuristic that plays through the public HTTP API (no dependencies).
// It's a template for building a smarter agent, and handy for testing the server end to end.
//
//   node tools/arena-agent.mjs --api http://127.0.0.1:8787 --name Zuriel --agent "Heuristic v1" --level master
//   node tools/arena-agent.mjs --api ... --mode versus            # queue against another agent
//   node tools/arena-agent.mjs --api ... --mode challenge [--code ABCDE]
//   --bouts 3      play several bouts in a row      --delay 800   pause (ms) between turns, to watch it live
//   --token ik_... reuse an existing registration (otherwise one is created and printed)

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
    return acc;
  }, []),
);
const API = (args.api ?? process.env.ARENA_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, { token, body } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 429 && attempt < 5) {
      await sleep(5000);
      continue;
    }
    if (data.error) throw new Error(`${data.error}: ${data.message}`);
    return data;
  }
}

/** Pick techniques from the state. Every field used here is documented in agents.md. */
function choose(v) {
  const { state, legal, decision, turn } = v;
  const tags = new Set(state.tags);
  const d = state.distance;
  const me = state.you;
  const op = state.opponent;
  if (decision === 'combo') return { action: me.hp < me.hpMax * 0.5 ? 'burst' : 'endure' };
  const can = (a) => legal.includes(a);
  if (can('secret') && d < 1.1 && (tags.has('opponent_open') || tags.has('opponent_recovering'))) return { action: 'secret', say: 'Witness my Secret Art.' };
  if (tags.has('opponent_open') || (tags.has('opponent_recovering') && (op.move?.framesLeft ?? 0) > 12)) {
    if (d < 0.95) return { action: 'launcher_combo', say: 'Punished.' };
    if (d < 2.2) return { action: 'lunge' };
  }
  if (tags.has('opponent_charging_focus')) return { action: d < 1.2 ? 'poke' : 'dash_back' };
  if (tags.has('opponent_attacking') && op.move?.phase === 'startup') return { action: op.move.framesLeft > 18 ? 'deflect' : 'guard' };
  if (tags.has('projectile_incoming')) return { action: 'jump_in' };
  if (tags.has('opponent_down')) return { actions: ['advance', 'guard'] };
  if (d > 3) return { actions: ['dash_in', 'advance'] };
  if (d > 1.1) return { action: turn % 3 === 0 ? 'lunge' : 'advance' };
  if (can('art_n') && me.qi >= 200 && turn % 4 === 0) return { action: 'art_n' };
  if (tags.has('opponent_guarding')) return { action: turn % 2 ? 'focus' : 'sweep' };
  return { action: ['strike_chain', 'guard', 'launcher_combo', 'sweep', 'deflect'][turn % 5] };
}

async function playBout(token) {
  const mode = args.mode ?? 'house';
  let v = await call('/api/bouts', { token, body: { mode, level: args.level ?? 'master', fighter: args.fighter ?? 'random', ...(args.code ? { code: args.code } : {}) } });
  console.log(`bout ${v.bout} (${v.mode}) vs ${v.opponent ?? '…'}${v.code ? ` · challenge code ${v.code}` : ''}\n  watch: ${v.watch}`);
  while (v.status !== 'finished' && v.status !== 'void') {
    if (v.status === 'your_turn') {
      const move = choose(v);
      if (args.delay) await sleep(Number(args.delay));
      v = await call(`/api/bouts/${v.bout}/turn`, { token, body: move });
      if (args.verbose) console.log(`  t${v.turn} ${JSON.stringify(move)} -> ${v.state?.you.hp} vs ${v.state?.opponent.hp} ${v.events?.join(' | ') ?? ''}`);
    } else {
      v = await call(`/api/bouts/${v.bout}?wait=25`, { token });
    }
  }
  if (v.status === 'void') return console.log('  no opponent turned up');
  const r = v.result;
  console.log(`  ${r.winner === 'you' ? 'WON' : 'lost'} (${r.endedBy}) · rating ${r.rating ? `${r.rating.after} (${r.rating.delta >= 0 ? '+' : ''}${r.rating.delta})` : '—'} · replay ${r.watch}`);
}

let token = args.token;
if (!token) {
  const reg = await call('/api/register', { body: { name: args.name ?? 'Reference', agent: args.agent ?? 'Heuristic v1' } });
  token = reg.token;
  console.log(`registered ${reg.label} (${reg.id}); token ${token}`);
}
for (let i = 0; i < Number(args.bouts ?? 1); i++) await playBout(token);
