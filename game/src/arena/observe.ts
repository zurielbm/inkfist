// What an agent sees: a compact, plain-language snapshot of the fight from one side's point of view.
import { PH, ROUNDS_TO_WIN, ST, SimEvent, U } from '../sim/defs';
import { Fighter, Match, charOf, moveOf } from '../sim/sim';
import { CHARS, MOVE_NAMES } from '../sim/chars';
import { CHAR_INFO, moveDisplay } from '../ui/names';

const STATE_TEXT: Record<number, string> = {
  [ST.IDLE]: 'idle', [ST.WALK_F]: 'walking_in', [ST.WALK_B]: 'walking_back', [ST.JUMPSQUAT]: 'jumping', [ST.AIR]: 'airborne',
  [ST.JUMP2]: 'airborne', [ST.LAND]: 'landing', [ST.DASH_F]: 'dashing_in', [ST.DASH_B]: 'dashing_back', [ST.AIRDASH]: 'air_dashing',
  [ST.GUARD]: 'guarding', [ST.GUARD_STUN]: 'blocking', [ST.DEFLECT]: 'deflected_a_blow', [ST.DEFLECT_WHIFF]: 'whiffed_deflect_open',
  [ST.ATTACK]: 'attacking', [ST.FOCUS_CHARGE]: 'charging_focus', [ST.HITSTUN]: 'hit_stunned', [ST.AIR_HIT]: 'juggled',
  [ST.KNOCKDOWN]: 'knocked_down', [ST.DOWN]: 'on_the_ground', [ST.GETUP]: 'getting_up', [ST.WALL]: 'wall_splatted',
  [ST.STAGGER]: 'staggered_open', [ST.CRUMPLE]: 'crumpling_open', [ST.BURST]: 'bursting', [ST.THROWN]: 'being_thrown',
  [ST.CINE_VICTIM]: 'caught_in_secret_art', [ST.INTRO]: 'intro', [ST.WIN]: 'victory_pose', [ST.KO]: 'ko',
};

/** Friendly names for the basic moves (arts and secret come from the fighter's own move list). */
const BASIC_MOVES: Record<string, string> = {
  s1: 'jab', s2: 'chain strike 2', s3: 'chain strike 3', s_f: 'stepping strike', s_u: 'launcher', s_d: 'sweep',
  s_air: 'air strike', h: 'heavy', h_f: 'lunging heavy', h_d: 'low heavy', h_air: 'air heavy', h_air_d: 'meteor dive',
  throw: 'throw',
};

export function moveLabel(charId: string, move: string): string {
  const d = moveDisplay(charId, move);
  return d ? d.name : BASIC_MOVES[move] ?? move;
}

export interface FighterView {
  fighter: string;
  name: string;
  hp: number;
  hpMax: number;
  qi: number;
  qiBars: number;
  state: string;
  airborne: boolean;
  /** position in metres; the stage runs from -7 to +7 */
  x: number;
  /** current attack, if any */
  move?: { id: string; name: string; phase: 'startup' | 'active' | 'recovery'; framesLeft: number };
  roundsWon: number;
}

export function fighterView(s: Match, i: number): FighterView {
  const f = s.f[i];
  const c = charOf(f);
  const v: FighterView = {
    fighter: c.id,
    name: c.name,
    hp: Math.max(0, f.hp),
    hpMax: c.hp,
    qi: f.qi,
    qiBars: Math.floor(f.qi / 100),
    state: STATE_TEXT[f.st] ?? 'busy',
    airborne: f.y > 0,
    x: Math.round((f.x / U) * 100) / 100,
    roundsWon: f.rounds,
  };
  const md = f.st === ST.ATTACK ? moveOf(f) : null;
  if (md) {
    const name = MOVE_NAMES[f.ch][f.mv];
    const phase = f.sf < md.startup ? 'startup' : f.sf < md.startup + md.active ? 'active' : 'recovery';
    v.move = { id: name, name: moveLabel(c.id, name), phase, framesLeft: Math.max(0, md.startup + md.active + md.recovery - f.sf) };
  }
  return v;
}

const OPEN = ['staggered_open', 'crumpling_open', 'whiffed_deflect_open'];
const DOWN = ['knocked_down', 'on_the_ground', 'getting_up'];

/**
 * Facts about the situation (not advice): helps agents that only skim.
 * `op` is the opponent as this side perceives them (see BoutCore: slightly delayed).
 */
export function situationTags(s: Match, side: number, op: FighterView = fighterView(s, 1 - side)): string[] {
  const me = s.f[side];
  const tags: string[] = [];
  const d = Math.abs(op.x - me.x / U);
  const reach = (charOf(me).moves.s1.box.x + charOf(me).moves.s1.box.w) / U;
  if (d <= reach + 0.1) tags.push('in_jab_range');
  if (Math.abs(me.x) / U > 6.2) tags.push('you_are_cornered');
  if (Math.abs(op.x) > 6.2) tags.push('opponent_cornered');
  if (op.state === 'charging_focus') tags.push('opponent_charging_focus');
  if (op.move?.phase === 'recovery') tags.push('opponent_recovering');
  if (op.move && op.move.phase !== 'recovery') tags.push('opponent_attacking');
  if (OPEN.includes(op.state)) tags.push('opponent_open');
  if (DOWN.includes(op.state)) tags.push('opponent_down');
  if (op.airborne) tags.push('opponent_airborne');
  if (op.state === 'guarding' || op.state === 'blocking') tags.push('opponent_guarding');
  if (s.proj.some((p) => p.owner !== side)) tags.push('projectile_incoming');
  if (me.qi >= 300) tags.push('secret_art_ready');
  if (s.timer < 600) tags.push('round_clock_low');
  return tags;
}

/** One line of the bout log from `side`'s point of view (null = not worth mentioning). */
export function eventText(e: SimEvent, s: Match, side: number): string | null {
  const who = (i: number) => (i === side ? 'You' : 'Opponent');
  const id = (i: number) => CHARS[s.f[i].ch].id;
  switch (e.t) {
    case 'hit': {
      const mv = moveLabel(id(e.atk), e.move);
      const extra = [e.hits > 1 ? `${e.hits}-hit combo` : '', e.counter ? 'COUNTER' : '', e.stale ? 'stale move, reduced damage' : '']
        .filter(Boolean).join(', ');
      return `${who(e.atk)} hit ${e.atk === side ? 'them' : 'you'} with ${mv}${extra ? ` (${extra})` : ''}`;
    }
    case 'block': return e.def === side ? 'You blocked a hit' : 'Your attack was blocked';
    case 'deflect': return e.def === side ? 'You DEFLECTED their attack: they are open' : 'Your attack was DEFLECTED: you are open';
    case 'crush': return e.def === side ? 'Their Focus CRUSHED your guard' : 'Your Focus CRUSHED their guard';
    case 'art': return `${who(e.who)} used ${moveLabel(id(e.who), e.move)}`;
    case 'burst': return `${who(e.who)} BURST out of a combo`;
    case 'grab': return `${who(e.who)} landed a grab`;
    case 'secret':
      if (e.phase === 'start') return `${who(e.who)} started a Secret Art`;
      if (e.phase === 'connect') return e.who === side ? 'Your Secret Art CONNECTED' : "Opponent's Secret Art CONNECTED";
      return null;
    case 'wall': return `${e.who === side ? 'You were' : 'Opponent was'} slammed into the wall`;
    case 'round': return `Round ${e.n}`;
    case 'fight': return 'FIGHT!';
    case 'ko': return e.loser === side ? 'You were KNOCKED OUT' : `You knocked them OUT${e.perfect ? ' (perfect)' : ''}`;
    case 'timeout': return 'Time up: the fighter with more health wins the round';
    case 'roundWin': return e.winner === side ? 'You won the round' : 'You lost the round';
    case 'match': return e.winner === side ? 'You WON the match' : 'You lost the match';
  }
  return null;
}

export interface Observation {
  round: number;
  roundsToWin: number;
  /** seconds left on the round clock */
  timeLeft: number;
  phase: 'intro' | 'ready' | 'fight' | 'ko' | 'round_end' | 'match_end';
  you: FighterView;
  opponent: FighterView;
  /** gap between the fighters in metres (a jab reaches about 0.75 m) */
  distance: number;
  /** +1 if the opponent is to your right, -1 to your left */
  opponentSide: number;
  tags: string[];
}

const PHASES: Observation['phase'][] = ['intro', 'ready', 'fight', 'ko', 'round_end', 'match_end'];

export function observation(s: Match, side: number, op: FighterView = fighterView(s, 1 - side)): Observation {
  const me = fighterView(s, side);
  return {
    round: s.round,
    roundsToWin: ROUNDS_TO_WIN,
    timeLeft: Math.round((s.timer / 60) * 10) / 10,
    phase: PHASES[s.phase] ?? 'fight',
    you: me,
    opponent: op,
    distance: Math.round(Math.abs(op.x - me.x) * 100) / 100,
    opponentSide: op.x >= me.x ? 1 : -1,
    tags: s.phase === PH.FIGHT ? situationTags(s, side, op) : [],
  };
}

/** Short per-fighter briefing used in the agent manual and bout start. */
export function fighterBrief(charId: string): { id: string; name: string; hp: number; style: string; arts: Record<string, string>; secret: string } {
  const c = CHARS.find((x) => x.id === charId)!;
  const info = CHAR_INFO[charId];
  return {
    id: c.id,
    name: c.name,
    hp: c.hp,
    style: info.desc,
    arts: { art_n: `${info.arts[0].name}: ${info.arts[0].desc}`, art_f: `${info.arts[1].name}: ${info.arts[1].desc}`, art_d: `${info.arts[2].name}: ${info.arts[2].desc}` },
    secret: info.secret.name,
  };
}
