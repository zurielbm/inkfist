// Agent pilots: an AI agent picks a named technique per turn; the pilot turns it into controller input frame by frame.
// Pilots use the same input routes as the house AI and a fixed reflex delay, so agents win by reading the fight, not by speed.
import { IN, PH, ST, U } from '../sim/defs';
import { Fighter, Match, charOf } from '../sim/sim';
import { Bk, F, Obs, PlanState, Step, observe, routeSteps, runPlan } from '../ai/ai';

/** Frames between something happening and the pilot's reflexes reacting to it (Gosu AI: 9, Master: 13). */
export const PILOT_REACTION = 10;
/** The Focus release flash is easier to read than a normal attack. */
const FOCUS_REACTION = 4;
/** Most actions an agent may queue in one turn. */
export const MAX_QUEUE = 3;

export type TechGroup = 'move' | 'defend' | 'attack' | 'qi';
export interface Technique {
  group: TechGroup;
  desc: string;
  /** Qi spent (100 = one bar) */
  qi?: number;
}

export const TECHNIQUES: Record<string, Technique> = {
  advance: { group: 'move', desc: 'Walk toward the opponent for 0.4 s.' },
  retreat: { group: 'move', desc: 'Walk away for 0.4 s.' },
  dash_in: { group: 'move', desc: 'Fast dash forward (about 1.5 m).' },
  dash_back: { group: 'move', desc: 'Backdash out of range.' },
  jump_in: { group: 'move', desc: 'Jump forward over pokes. You are airborne about 0.6 s.' },
  jump_back: { group: 'move', desc: 'Jump backward to escape pressure.' },
  wait: { group: 'move', desc: 'Stand still and watch for 0.33 s. You are NOT guarding.' },
  guard: { group: 'defend', desc: 'Hold guard for 0.5 s (longer while blocking). Blocks strikes, heavies, arts and projectiles. A released Focus crushes it, grabs ignore it.' },
  deflect: { group: 'defend', desc: 'Stand ready and parry the next blow at the perfect moment. Beats strikes, heavies, arts AND Focus; the attacker is left open. Reflex is about 1/6 s, so fast jabs may land first, and you are not guarding while you wait (up to 0.7 s).' },
  burst: { group: 'defend', qi: 200, desc: 'Only offered while you are being comboed: explode free and become briefly invulnerable. Costs 2 Qi bars.' },
  poke: { group: 'attack', desc: 'Single fast jab (startup 5-7 frames). Safe, short range.' },
  strike_chain: { group: 'attack', desc: 'Jab into a 3-hit strike chain; stops early if the first hit misses or is blocked.' },
  launcher_combo: { group: 'attack', desc: 'Jab, launch them into the air, jump and juggle. Biggest normal combo; stops early if a hit misses.' },
  sweep: { group: 'attack', desc: 'Low sweep that knocks down.' },
  heavy: { group: 'attack', desc: 'Heavy blow (slower, more damage, pushes back).' },
  lunge: { group: 'attack', desc: 'Forward heavy that travels in and covers distance.' },
  focus: { group: 'attack', desc: 'Charge a Focus strike for about 0.6 s, then release: it CRUSHES guard, but strikes interrupt the charge and a deflect beats it.' },
  jump_attack: { group: 'attack', desc: 'Jump forward and swing an air heavy on the way down.' },
  dive: { group: 'attack', desc: 'Jump, then meteor-dive down at them. Leaves a crater; risky if it misses.' },
  art_n: { group: 'qi', qi: 100, desc: 'Neutral Qi art of your fighter (1 bar). See fighters.' },
  art_f: { group: 'qi', qi: 100, desc: 'Forward Qi art of your fighter (1 bar).' },
  art_d: { group: 'qi', qi: 100, desc: 'Down Qi art of your fighter (1 bar).' },
  secret: { group: 'qi', qi: 300, desc: 'Secret Art cinematic: huge damage if it connects. Costs all 3 Qi bars.' },
};
export const TECH_NAMES = Object.keys(TECHNIQUES);

const LAUNCH: Record<string, string[]> = {
  mujin: ['s1', 's2', 's_u', 'JUMP', 's_air', 'h_air'],
  seolhwa: ['s1', 's2', 's_u', 'JUMP', 's_air', 'h_air'],
  hyeongong: ['s1', 's2', 's_u', 'JUMP', 's_air'],
};

/** States from which a fighter can start a new technique. */
export function isFree(f: Fighter): boolean {
  return f.st === ST.IDLE || f.st === ST.WALK_F || f.st === ST.WALK_B || f.st === ST.GUARD || f.st === ST.LAND ||
    (f.st === ST.DEFLECT && f.sf > 3);
}

function isHurt(f: Fighter): boolean {
  return f.st === ST.HITSTUN || f.st === ST.AIR_HIT || f.st === ST.KNOCKDOWN || f.st === ST.DOWN || f.st === ST.GETUP ||
    f.st === ST.WALL || f.st === ST.STAGGER || f.st === ST.CRUMPLE || f.st === ST.THROWN || f.st === ST.CINE_VICTIM;
}

/** Qi a technique needs for this fighter right now (0 if free). */
export function techCost(name: string, f: Fighter): number {
  if (name === 'secret') return 300;
  if (name === 'burst') return 200;
  if (name === 'art_n' || name === 'art_f' || name === 'art_d') return charOf(f).moves[name]?.qiCost ?? 100;
  return 0;
}

function techSteps(name: string, me: Fighter): Step[] {
  switch (name) {
    case 'advance': return [{ press: 0, hold: F, frames: 24 }];
    case 'retreat': return [{ press: 0, hold: Bk, frames: 24 }];
    case 'wait': return [{ press: 0, hold: 0, frames: 20 }];
    case 'dash_in': return routeSteps(['dash_f']);
    case 'dash_back': return routeSteps(['dash_b']);
    case 'jump_in': return [...routeSteps(['JUMP']), { press: 0, hold: F, frames: 24 }];
    case 'jump_back': return [...routeSteps(['JUMP_B']), { press: 0, hold: Bk, frames: 24 }];
    case 'guard': return [{ press: 0, hold: IN.G, frames: 30 }];
    case 'burst': return [{ press: IN.D, hold: 0, frames: 3 }];
    case 'poke': return routeSteps(['s1']);
    case 'strike_chain': return routeSteps(['s1', 's2', 's3']);
    case 'launcher_combo': return routeSteps(LAUNCH[charOf(me).id] ?? LAUNCH.mujin);
    case 'sweep': return routeSteps(['s_d']);
    case 'heavy': return routeSteps(['h']);
    case 'lunge': return routeSteps(['h_f']);
    case 'focus': return routeSteps(['focus'], false, () => 0.4);
    case 'jump_attack': return routeSteps(['JUMP', 'h_air'], false);
    case 'dive': return routeSteps(['JUMP', 'h_air_d'], false);
    case 'art_n': case 'art_f': case 'art_d': case 'secret': return routeSteps([name], false);
  }
  return [];
}

export type DecisionKind = 'free' | 'combo';

export interface PilotSnapshot {
  side: number;
  hist: Obs[];
  plan: Step[];
  stepI: number;
  stepF: number;
  tech: string | null;
  techF: number;
  queue: string[];
  burstAsked: boolean;
  mvAt?: number;
  sfAt?: number;
}

export class Pilot implements PlanState {
  hist: Obs[] = [];
  plan: Step[] = [];
  stepI = 0;
  stepF = 0;
  /** technique being executed, null when idle */
  tech: string | null = null;
  techF = 0;
  queue: string[] = [];
  /** a burst was already offered during the current combo */
  burstAsked = false;
  mvAt = -1;
  sfAt = 0;

  constructor(public side: number) {}

  snapshot(): PilotSnapshot {
    const { side, hist, plan, stepI, stepF, tech, techF, queue, burstAsked, mvAt, sfAt } = this;
    return structuredClone({ side, hist, plan, stepI, stepF, tech, techF, queue, burstAsked, mvAt, sfAt });
  }

  static restore(o: PilotSnapshot): Pilot {
    return Object.assign(new Pilot(o.side), structuredClone(o));
  }

  /**
   * Before each frame: start the next queued technique if possible, then report whether the agent must choose now.
   * 'free' = normal turn; 'combo' = being comboed with 2+ Qi bars (burst or endure).
   */
  decision(s: Match): DecisionKind | null {
    if (s.phase !== PH.FIGHT || s.cine >= 0 || this.tech) return null;
    const me = s.f[this.side];
    if (isFree(me)) {
      while (this.queue.length) {
        const next = this.queue.shift()!;
        if (me.qi >= techCost(next, me)) {
          this.start(next, me);
          return null;
        }
      }
      return 'free';
    }
    if ((me.st === ST.HITSTUN || me.st === ST.AIR_HIT) && me.comboHits >= 2 && me.qi >= 200 && !this.burstAsked) return 'combo';
    return null;
  }

  legal(s: Match, kind: DecisionKind): string[] {
    if (kind === 'combo') return ['burst', 'endure'];
    const me = s.f[this.side];
    return TECH_NAMES.filter((n) => n !== 'burst' && me.qi >= techCost(n, me));
  }

  /** Apply an agent's choice. Validation happens in the bout. */
  assign(actions: string[], s: Match, kind: DecisionKind): void {
    const me = s.f[this.side];
    if (kind === 'combo') {
      this.burstAsked = true;
      if (actions[0] === 'burst') this.start('burst', me);
      return;
    }
    this.queue = actions.slice(1, MAX_QUEUE);
    this.start(actions[0], me);
  }

  private start(name: string, me: Fighter): void {
    this.tech = name;
    this.techF = 0;
    this.plan = name === 'deflect' ? [] : techSteps(name, me);
    this.stepI = 0;
    this.stepF = 0;
  }

  private stop(): void {
    this.tech = null;
    this.plan = [];
    this.stepI = 0;
    this.stepF = 0;
  }

  /** Controller bits for this frame. Call exactly once per simulated frame. */
  read(s: Match): number {
    const me = s.f[this.side];
    this.hist.push(observe(s.f[1 - this.side]));
    if (this.hist.length > PILOT_REACTION + 2) this.hist.shift();
    if (me.comboHits === 0) this.burstAsked = false;
    if (s.phase !== PH.FIGHT) {
      this.stop();
      this.queue = [];
      return 0;
    }
    if (!this.tech) return 0;
    if (isHurt(me) && this.tech !== 'burst') {
      // getting hit cancels the technique and anything queued after it
      this.stop();
      this.queue = [];
      return 0;
    }
    this.techF++;
    if (this.tech === 'guard' && me.st === ST.GUARD_STUN) return IN.G;
    if (this.tech === 'deflect' && !this.plan.length) {
      if (this.incoming(s, me)) {
        this.plan = [{ press: IN.G, hold: IN.G, frames: 16 }];
      } else {
        if (this.techF > 40) this.stop();
        return 0;
      }
    }
    const out = runPlan(this, me, true);
    if (this.stepI >= this.plan.length) this.stop();
    return out;
  }

  /** Deflect reflex: is a blow about to land, as perceived after the reaction delay? */
  private incoming(s: Match, me: Fighter): boolean {
    const n = this.hist.length;
    const late = this.hist[Math.max(0, n - 1 - PILOT_REACTION)];
    const flash = this.hist[Math.max(0, n - 1 - FOCUS_REACTION)];
    const threat = (o: Obs, delay: number): boolean => {
      if (o.st !== ST.ATTACK || !o.move || o.sf >= o.startup + o.active) return false;
      const d = Math.abs(o.x - me.x) / U;
      if (d > o.reach / U + 0.35 + (Math.abs(o.vx) / U) * 10) return false;
      const eta = o.startup - (o.sf + delay);
      return eta <= 5 && eta >= -1;
    };
    if (flash.move === 'focus_release' && threat(flash, FOCUS_REACTION)) return true;
    if (threat(late, PILOT_REACTION)) return true;
    for (const p of s.proj) {
      if (p.owner === me.side) continue;
      const d = Math.abs(p.x - me.x) / U;
      if (d < 1.3 && Math.sign(me.x - p.x) === Math.sign(p.vx)) return true;
    }
    return false;
  }
}
