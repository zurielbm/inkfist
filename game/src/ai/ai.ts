// AI opponent: observes the match through a reaction-delay buffer and produces controller input bits only.
import { IN, ST, U, m } from '../sim/defs';
import { Fighter, Match, moveOf, charOf } from '../sim/sim';
import { CHARS } from '../sim/chars';

export type Difficulty = 0 | 1 | 2 | 3;
export const DIFFICULTY_NAMES = ['Novice 初', 'Adept 中', 'Master 上', 'Gosu 高手'];

interface Params {
  reaction: number;
  guard: number;
  deflect: number;
  punish: number;
  combo: number;
  aggression: number;
  qi: boolean;
  burst: boolean;
  antiair: number;
  focus: number;
  mistake: number;
}

const PARAMS: Params[] = [
  { reaction: 30, guard: 0.12, deflect: 0.0, punish: 0.12, combo: 2, aggression: 0.32, qi: false, burst: false, antiair: 0.08, focus: 0.04, mistake: 0.35 },
  { reaction: 19, guard: 0.42, deflect: 0.07, punish: 0.4, combo: 3, aggression: 0.48, qi: true, burst: false, antiair: 0.3, focus: 0.12, mistake: 0.18 },
  { reaction: 13, guard: 0.6, deflect: 0.28, punish: 0.7, combo: 5, aggression: 0.58, qi: true, burst: true, antiair: 0.55, focus: 0.22, mistake: 0.08 },
  { reaction: 9, guard: 0.7, deflect: 0.48, punish: 0.9, combo: 8, aggression: 0.66, qi: true, burst: true, antiair: 0.78, focus: 0.3, mistake: 0.02 },
];

export interface Obs {
  st: number;
  sf: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  move: string | null;
  startup: number;
  active: number;
  total: number;
  unblockable: boolean;
  reach: number;
}

export interface Step {
  press: number;
  hold: number;
  frames: number;
  waitContact?: boolean;
  /** abort remaining plan if this step's move didn't connect */
  needHit?: boolean;
}

export const F = 0x10000; // placeholder bit for "forward" resolved at runtime
export const Bk = 0x20000; // "back"

/** A running list of input steps (shared by the house AI and agent pilots). */
export interface PlanState {
  plan: Step[];
  stepI: number;
  stepF: number;
  /** strict mode: the move (and its frame) that was running when the current step began */
  mvAt?: number;
  sfAt?: number;
}

export function observe(o: Fighter): Obs {
  const md = o.st === ST.ATTACK ? moveOf(o) : null;
  return {
    st: o.st, sf: o.sf, x: o.x, y: o.y, vx: o.vx, vy: o.vy, facing: o.facing,
    move: md ? md.name : null,
    startup: md ? md.startup : 0,
    active: md ? md.active : 0,
    total: md ? md.startup + md.active + md.recovery : 0,
    unblockable: !!md?.unblockable,
    reach: md ? (md.around ? md.box.w : md.box.x + md.box.w) : 0,
  };
}

/** Resolve the F / Bk placeholders against the fighter's current facing. */
export function resolveDir(bits: number, me: Fighter): number {
  let b = bits & 0xffff;
  if (bits & F) b |= me.facing > 0 ? IN.RIGHT : IN.LEFT;
  if (bits & Bk) b |= me.facing > 0 ? IN.LEFT : IN.RIGHT;
  return b;
}

/**
 * Emit this frame's input for the current step and advance the plan.
 * `strict` only counts contact made by a move started during this step (the house AI keeps its original, looser timing).
 */
export function runPlan(ps: PlanState, me: Fighter, strict = false): number {
  const st = ps.plan[ps.stepI];
  if (!st) return 0;
  if (ps.stepF === 0 && strict) {
    ps.mvAt = me.st === ST.ATTACK ? me.mv : -1;
    ps.sfAt = me.sf;
  }
  let out = resolveDir(st.hold, me);
  if (ps.stepF === 0) out |= resolveDir(st.press, me);
  ps.stepF++;
  let done = ps.stepF >= st.frames;
  if (st.waitContact && ps.stepF > 2) {
    const fresh = !strict || (me.st === ST.ATTACK && (me.mv !== ps.mvAt || me.sf < (ps.sfAt ?? 0)));
    if (me.contact && fresh) done = true;
    else if (me.st !== ST.ATTACK && ps.stepF > 4) {
      done = true;
      if (st.needHit) ps.stepI = ps.plan.length - 1;
    }
  }
  if (st.needHit && done && me.contact !== 1 && st.waitContact) ps.stepI = ps.plan.length - 1;
  if (done) {
    ps.stepI++;
    ps.stepF = 0;
  }
  return out;
}

/** Map move names to input steps. `rand` only varies the Focus charge time. */
export function routeSteps(names: string[], needHitAfterFirst = true, rand: () => number = () => 0.5): Step[] {
  const steps: Step[] = [];
  for (const n of names) {
    const need = needHitAfterFirst;
    switch (n) {
      case 'JUMP':
        steps.push({ press: 0, hold: IN.UP | F, frames: 3 });
        steps.push({ press: 0, hold: F, frames: 9 });
        break;
      case 'JUMP_B':
        steps.push({ press: 0, hold: IN.UP | Bk, frames: 3 });
        steps.push({ press: 0, hold: Bk, frames: 9 });
        break;
      case 'WAIT':
        steps.push({ press: 0, hold: 0, frames: 6 });
        break;
      case 's1': case 's2': case 's3':
        steps.push({ press: IN.S, hold: 0, frames: 30, waitContact: true, needHit: need });
        break;
      case 's_f': steps.push({ press: IN.S, hold: F, frames: 36, waitContact: true, needHit: need }); break;
      case 's_u': steps.push({ press: IN.S | IN.UP, hold: IN.UP, frames: 36, waitContact: true, needHit: need }); break;
      case 's_d': steps.push({ press: IN.S, hold: IN.DOWN, frames: 36, waitContact: true, needHit: need }); break;
      case 's_air': steps.push({ press: IN.S, hold: 0, frames: 22, waitContact: true, needHit: need }); break;
      case 'h': steps.push({ press: IN.H, hold: 0, frames: 4 }, { press: 0, hold: 0, frames: 40, waitContact: true, needHit: need }); break;
      case 'h_f': steps.push({ press: IN.H, hold: F, frames: 4 }, { press: 0, hold: F, frames: 40, waitContact: true, needHit: need }); break;
      case 'h_d': steps.push({ press: IN.H, hold: IN.DOWN, frames: 4 }, { press: 0, hold: IN.DOWN, frames: 40, waitContact: true, needHit: need }); break;
      case 'h_air': steps.push({ press: IN.H, hold: 0, frames: 30, waitContact: true, needHit: need }); break;
      case 'h_air_d': steps.push({ press: IN.H, hold: IN.DOWN, frames: 40, waitContact: true, needHit: need }); break;
      case 'art_n': steps.push({ press: IN.A, hold: 0, frames: 50, waitContact: true, needHit: need }); break;
      case 'art_f': steps.push({ press: IN.A, hold: F, frames: 50, waitContact: true, needHit: need }); break;
      case 'art_d': steps.push({ press: IN.A, hold: IN.DOWN, frames: 50, waitContact: true, needHit: need }); break;
      case 'secret': steps.push({ press: IN.X, hold: 0, frames: 60, waitContact: true }); break;
      case 'focus': steps.push({ press: IN.H, hold: IN.H, frames: 24 + ((rand() * 26) | 0) }, { press: 0, hold: 0, frames: 30, waitContact: true }); break;
      case 'dash_f': steps.push({ press: IN.D, hold: F, frames: 16 }); break;
      case 'dash_b': steps.push({ press: IN.D, hold: Bk, frames: 18 }); break;
    }
  }
  return steps;
}

/** Serializable controller state (the server persists it between agent turns). */
export interface AISnapshot {
  side: number;
  difficulty: Difficulty;
  rng: number;
  hist: Obs[];
  plan: Step[];
  stepI: number;
  stepF: number;
  oppGuardRate: number;
}

export class AIController implements PlanState {
  p: Params;
  hist: Obs[] = [];
  plan: Step[] = [];
  stepI = 0;
  stepF = 0;
  oppGuardRate = 0;
  /** mulberry32 state: the AI is fully deterministic for a given seed, so the server can replay matches against it */
  rng: number;

  constructor(public side: number, public difficulty: Difficulty, seed = (Math.random() * 0x100000000) >>> 0) {
    this.p = PARAMS[difficulty];
    this.rng = seed | 0;
  }

  rand(): number {
    let t = (this.rng = (this.rng + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  snapshot(): AISnapshot {
    const { side, difficulty, rng, hist, plan, stepI, stepF, oppGuardRate } = this;
    return structuredClone({ side, difficulty, rng, hist, plan, stepI, stepF, oppGuardRate });
  }

  static restore(o: AISnapshot): AIController {
    const ai = new AIController(o.side, o.difficulty, o.rng);
    Object.assign(ai, structuredClone(o));
    return ai;
  }

  read(s: Match): number {
    const me = s.f[this.side];
    const op = s.f[1 - this.side];
    this.hist.push(observe(op));
    if (this.hist.length > 40) this.hist.shift();
    const delay = Math.min(this.hist.length - 1, this.p.reaction);
    const obs = this.hist[this.hist.length - 1 - delay];
    if (op.st === ST.GUARD || op.st === ST.GUARD_STUN) this.oppGuardRate = this.oppGuardRate * 0.995 + 0.005;
    else this.oppGuardRate *= 0.999;

    if (s.phase !== 2) {
      this.plan = [];
      return 0;
    }
    // --- reactive layer (may interrupt plans)
    const reactive = this.react(s, me, op, obs);
    if (reactive) {
      this.plan = reactive;
      this.stepI = 0;
      this.stepF = 0;
    }

    // --- planning layer
    if (this.stepI >= this.plan.length) {
      this.plan = this.decide(s, me, op, obs);
      this.stepI = 0;
      this.stepF = 0;
    }
    if (!this.plan.length) return 0;
    return runPlan(this, me);
  }

  private dist(me: Fighter, o: { x: number }): number {
    return Math.abs(o.x - me.x) / U;
  }

  private react(s: Match, me: Fighter, op: Fighter, obs: Obs): Step[] | null {
    const p = this.p;
    const R = () => this.rand();
    // getting hit
    if (me.st === ST.HITSTUN || me.st === ST.AIR_HIT) {
      if (p.burst && me.qi >= 200 && me.comboHits >= 4 && R() < 0.06) return [{ press: IN.D, hold: 0, frames: 3 }];
      if (me.st === ST.AIR_HIT && me.stun <= 1 && me.y > m(0.5) && R() < 0.3 + p.antiair * 0.5) return [{ press: IN.S, hold: 0, frames: 2 }];
      return this.plan.length && this.plan[0].press === 0 ? null : [{ press: 0, hold: 0, frames: 4 }];
    }
    if (me.st === ST.DOWN) {
      if (me.sf > 14 && R() < 0.05 + p.punish * 0.1) return [{ press: IN.S, hold: 0, frames: 2 }, { press: 0, hold: 0, frames: 6 }];
      return null;
    }
    const actionable = me.st === ST.IDLE || me.st === ST.WALK_F || me.st === ST.WALK_B || me.st === ST.GUARD || me.st === ST.LAND;
    if (!actionable) return null;
    const d = this.dist(me, obs);
    const reach = obs.reach / U + 0.35;
    // incoming attack
    if (obs.st === ST.ATTACK && obs.move && d < reach + Math.abs(obs.vx) / U * 10) {
      const eta = obs.startup - (obs.sf + p.reaction);
      if (obs.sf < obs.startup + obs.active) {
        const r = R();
        if (r < p.deflect && eta <= 5 && eta >= -1) {
          return [{ press: IN.G, hold: IN.G, frames: 14 }];
        }
        if (!obs.unblockable && r < p.deflect + p.guard) {
          return [{ press: 0, hold: IN.G | Bk * 0, frames: Math.max(6, obs.total - obs.sf - p.reaction + 4) }];
        }
        if (obs.unblockable && r < p.guard) {
          return [{ press: IN.D, hold: Bk, frames: 18 }];
        }
      }
    }
    // charging focus: interrupt or back off
    if (obs.st === ST.FOCUS_CHARGE) {
      if (d < 1.2 && R() < 0.3 + p.punish * 0.4) return this.route(['s1'], me);
      if (R() < 0.04) return [{ press: IN.D, hold: Bk, frames: 18 }];
    }
    // punish recovery / stagger
    const vulnerable = obs.st === ST.STAGGER || obs.st === ST.CRUMPLE || obs.st === ST.DEFLECT_WHIFF ||
      (obs.st === ST.ATTACK && obs.sf > obs.startup + obs.active + 2 && obs.total - obs.sf > 8);
    if (vulnerable && d < this.myReach(me) + 0.2 && R() < p.punish * 0.25) return this.comboRoute(s, me, true);
    // anti-air
    if (op.y > m(0.6) && obs.vy < 400 && d < 1.7 && R() < p.antiair * 0.15) {
      if (p.qi && me.qi >= 100 && charOf(me).id === 'mujin' && R() < 0.5) return [{ press: IN.A, hold: IN.DOWN, frames: 40 }];
      return this.route(['s_u'], me);
    }
    // incoming projectile
    for (const pr of s.proj) {
      if (pr.owner === me.side) continue;
      const pd = Math.abs(pr.x - me.x) / U;
      if (pd < 2.4 && Math.sign(me.x - pr.x) === Math.sign(pr.vx) && R() < p.guard * 0.3) {
        return R() < 0.5 ? [{ press: IN.UP, hold: F, frames: 30 }] : [{ press: IN.G, hold: IN.G, frames: 24 }];
      }
    }
    return null;
  }

  private myReach(me: Fighter): number {
    const c = charOf(me);
    return (c.moves.s1.box.x + c.moves.s1.box.w) / U;
  }

  private route(names: string[], me: Fighter, needHitAfterFirst = true): Step[] {
    void me;
    return routeSteps(names, needHitAfterFirst, () => this.rand());
  }

  private comboRoute(s: Match, me: Fighter, punish: boolean): Step[] {
    const id = charOf(me).id;
    const skill = this.p.combo;
    const qiArt = this.p.qi && me.qi >= 100;
    const secret = this.p.qi && me.qi >= 300 && this.rand() < 0.6;
    const routes: Record<string, string[][]> = {
      mujin: [
        ['s1', 's2', 's3', 's_f'],
        ['s1', 's2', 's_u', 'JUMP', 's_air', 'h_air'],
        ['s1', 's_d'],
        ['s1', 's2', 'h', 'art_n'],
        ['s_f', 's_u', 'JUMP', 's_air', 'h_air_d'],
        ['h_f', 'JUMP', 's_air', 'h_air'],
      ],
      seolhwa: [
        ['s1', 's2', 's3', 's_f'],
        ['s1', 's2', 's_u', 'JUMP', 's_air', 'h_air'],
        ['s1', 's_d'],
        ['s_f', 'h', 'art_n'],
        ['s1', 's2', 'h_d'],
      ],
      hyeongong: [
        ['s1', 's2', 's3'],
        ['s1', 's2', 's_u', 'JUMP', 's_air'],
        ['s1', 's_d', 'h_d'],
        ['s1', 'h'],
        ['s_f', 'h', 'art_d'],
      ],
    };
    const list = routes[id] ?? routes.mujin;
    let r = [...list[(this.rand() * list.length) | 0]];
    r = r.slice(0, Math.max(1, skill));
    if (r[r.length - 1] === 'JUMP') r.pop();
    if (secret && skill >= 4) r.push('secret');
    else if (qiArt && skill >= 3 && this.rand() < 0.5) r.push(id === 'hyeongong' ? 'art_d' : 'art_n');
    if (punish && r[0] !== 's1' && this.rand() < 0.5) r.unshift('s1');
    if (this.rand() < this.p.mistake) r = r.slice(0, 1);
    return this.route(r, me);
  }

  private decide(s: Match, me: Fighter, op: Fighter, obs: Obs): Step[] {
    const p = this.p;
    const R = () => this.rand();
    const id = charOf(me).id;
    const d = this.dist(me, op);
    const reach = this.myReach(me);
    const actionable = me.st === ST.IDLE || me.st === ST.WALK_F || me.st === ST.WALK_B || me.st === ST.GUARD || me.st === ST.LAND;
    if (!actionable) return [{ press: 0, hold: 0, frames: 2 }];
    const prefer = id === 'seolhwa' ? 1.2 : id === 'hyeongong' ? 0.75 : 0.65;
    const aggressive = R() < p.aggression;
    const opDown = op.st === ST.DOWN || op.st === ST.GETUP;
    if (opDown) {
      if (p.qi && me.qi >= 100 && d < 1.4 && (id === 'hyeongong' || id === 'seolhwa') && R() < 0.15) return this.route(['art_d'], me, false);
      return [{ press: 0, hold: d > prefer + 0.4 ? F : 0, frames: 10 }];
    }
    // in range: attack
    if (d < reach + 0.15) {
      if (aggressive) {
        if (this.oppGuardRate > 0.25 && R() < p.focus) return this.route(['focus'], me, false);
        if (id === 'hyeongong' && p.qi && me.qi >= 100 && R() < 0.12) return this.route(['art_f'], me, false);
        return this.comboRoute(s, me, false);
      }
      const r = R();
      if (r < 0.35) return [{ press: 0, hold: IN.G, frames: 12 + ((R() * 20) | 0) }];
      if (r < 0.55) return this.route(['dash_b'], me);
      if (r < 0.7) return [{ press: 0, hold: Bk, frames: 10 + ((R() * 14) | 0) }];
      return this.comboRoute(s, me, false);
    }
    // mid range
    if (d < 2.6) {
      const r = R();
      if (id === 'seolhwa' && p.qi && me.qi >= 100 && r < 0.12) return this.route(['art_n'], me, false);
      if (aggressive && r < 0.3) return this.route(['dash_f', 's1', 's2', 's_u'], me);
      if (aggressive && r < 0.42) return this.route(['JUMP', 'h_air'], me, false);
      if (r < 0.55) return this.route([id === 'seolhwa' ? 's_f' : 'h_f'], me, false);
      if (r < 0.7) return [{ press: 0, hold: IN.G, frames: 14 }];
      return [{ press: 0, hold: d > prefer ? F : Bk, frames: 8 + ((R() * 16) | 0) }];
    }
    // far
    const r = R();
    if (id === 'seolhwa' && p.qi && me.qi >= 100 && r < 0.2) return this.route(['art_n'], me, false);
    if (r < 0.25 * (0.5 + p.aggression)) return this.route(['dash_f'], me);
    if (r < 0.32) return this.route(['JUMP'], me);
    return [{ press: 0, hold: F, frames: 10 + ((R() * 25) | 0) }];
  }
}

export function makeAI(side: number, d: Difficulty): AIController {
  return new AIController(side, d);
}

export { CHARS };
