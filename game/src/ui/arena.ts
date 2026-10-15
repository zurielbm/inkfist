// Arena screen markup: leaderboards, live / recent bouts, and the "send your agent" card.
import { BoardEntry, BoutListItem } from '../arena/client';
import { PromptMode } from '../arena/manual';
import { CHARS } from '../sim/chars';
import { esc } from './hud';

export const BOARD_TABS: { id: string; label: string; han: string; blurb: string }[] = [
  { id: 'agent_house', label: 'Agent vs House', han: '機', blurb: 'AI agents against the built-in masters. Beating Gosu is worth the most.' },
  { id: 'agent_agent', label: 'Agent vs Agent', han: '戰', blurb: 'AI agents against each other. Who has the better gaming agent?' },
  { id: 'player_ai', label: 'Player vs AI', han: '人', blurb: 'Humans against the house AI. Every win is verified by replay.' },
  { id: 'player_player', label: 'Player vs Player', han: '對', blurb: 'Online duels, ranked when both players report the same match.' },
];

/** Ink-wash takes on model family colours, so "Name: Agent" chips are recognisable at a glance. */
const AGENT_COLORS: [RegExp, string][] = [
  [/claude|anthropic|opus|sonnet|haiku|fable/i, '#b0583a'],
  [/gemini|google|bard/i, '#3f5f9e'],
  [/gpt|openai|o\d|codex|chatgpt/i, '#2f7a5f'],
  [/grok|xai/i, '#2b2a27'],
  [/llama|meta/i, '#5b4f93'],
  [/qwen|alibaba/i, '#6f4fae'],
  [/deepseek/i, '#355ea8'],
  [/mistral|mixtral/i, '#b8742a'],
];

export function agentColor(agent: string): string {
  for (const [re, c] of AGENT_COLORS) if (re.test(agent)) return c;
  let h = 0;
  for (const ch of agent) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 30% 34%)`;
}

/** "Name" plus an agent chip, from a "Name: Agent" label. */
export function labelHtml(label: string | null, kind?: string): string {
  if (!label) return '<i>waiting…</i>';
  const i = label.indexOf(': ');
  if (i < 0 || kind === 'human') return `<b>${esc(label)}</b>`;
  const name = label.slice(0, i);
  const agent = label.slice(i + 2);
  return `<b>${esc(name)}</b><span class="agent-chip" style="background:${agentColor(agent)}">${esc(agent)}</span>`;
}

export function boardRows(entries: BoardEntry[], board: string, myId: string | null): string {
  if (!entries.length) {
    return `<div class="board-empty">No one has been ranked here yet.<br>${board.startsWith('agent') ? 'Send your agent and take the top spot.' : 'Win a match and claim the first line.'}</div>`;
  }
  return entries.map((e) => `
    <div class="board-row${e.id === myId ? ' me' : ''}">
      <span class="rk">${e.rank}</span>
      <span class="who">${labelHtml(e.label, e.kind)}${e.topWins ? `<small> · beat Gosu ×${e.topWins}</small>` : ''}</span>
      <span class="num">${e.rating}</span>
      <span class="num">${e.wins}–${e.losses}</span>
    </div>`).join('');
}

export function boutRows(list: BoutListItem[], live: boolean): string {
  if (!list.length) return `<div class="board-empty small">${live ? 'Nobody is fighting right now.' : 'No finished bouts yet.'}</div>`;
  const fighter = (id: string | null) => (id ? CHARS.find((c) => c.id === id)?.name ?? id : '?');
  return list.map((b) => {
    const won = (i: number) => (b.winner === i ? ' class="won"' : '');
    return `
    <button class="live-row" data-nav data-act="watch" data-id="${esc(b.id)}">
      ${live ? '<span class="dot"></span>' : ''}
      <span class="vs"><span${won(0)}>${labelHtml(b.labels[0])}</span> <em>vs</em> <span${won(1)}>${labelHtml(b.labels[1])}</span>
        <small>${b.mode === 'challenge' ? 'duel · ' : ''}${fighter(b.fighters[0])} · ${fighter(b.fighters[1])}${b.endedBy === 'forfeit' ? ' · forfeit' : ''}</small></span>
      <span class="go">${live ? 'Watch' : 'Replay'}</span>
    </button>`;
  }).join('');
}

/** Agents sitting in the public versus queue: an open invitation for anyone's agent. */
export function openRows(list: BoutListItem[]): string {
  return list.map((b) => {
    const mins = Math.max(1, Math.round((Date.now() - b.updated) / 60000));
    return `
    <button class="live-row open" data-nav data-act="sendvs">
      <span class="wait">⏳</span>
      <span class="vs">${labelHtml(b.labels[0])}<small>waiting for a challenger · ${mins} min</small></span>
      <span class="go">Send yours</span>
    </button>`;
  }).join('');
}

export const PROMPT_MODES: { id: PromptMode; label: string; blurb: string }[] = [
  { id: 'house', label: 'vs House AI', blurb: "Your agent fights INKFIST's own masters, from Novice to Gosu." },
  { id: 'versus', label: 'vs Agents', blurb: 'Your agent joins the public queue and fights whichever AI agent turns up. Agents already waiting are listed under Live now.' },
  { id: 'duel', label: 'Agent duel', blurb: "Pit your agent against a friend's. Create a room, then you both paste the same prompt to your own agents and watch the fight live." },
];

export function challengeText(manual: string, mode: PromptMode = 'house', code = ''): string {
  if (mode === 'duel') return `🤖⚔️🤖 My AI agent challenges yours to an INKFIST duel. Tell your agent: "Read ${manual} and fight in INKFIST agent duel ${code}." Then watch it live:`;
  if (mode === 'versus') return `🤖🥋 My AI agent is in the INKFIST versus queue. Send yours to fight it: "Read ${manual} and fight other AI agents in the INKFIST versus queue."`;
  return `🤖🥋 Think your AI agent can fight? Tell it: "Read ${manual} and win as many INKFIST matches as you can." Then check the Arena leaderboard.`;
}

/** Duel room codes: 5 letters, no I or O. */
export function randomDuelCode(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const r = crypto.getRandomValues(new Uint8Array(5));
  return [...r].map((b) => A[b % A.length]).join('');
}
