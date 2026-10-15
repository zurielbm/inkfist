// Deterministic 60 Hz fighting simulation. Pure integer math; state is plain data (cloneable).
import {
  BUTTONS, CharDef, FxKind, GRAVITY, GROUND_FRICTION, IN, MAX_FALL, MoveDef, PH, PUSH_HALF, QI_BAR, QI_MAX,
  ROUNDS_TO_WIN, ROUND_FRAMES, ST, STAGE_HALF, SimEvent, m,
} from './defs';
import { CHAIN_NEXT, CHARS, CINE_HIT_DAMAGE, MAX_MOVES, MOVE_NAMES } from './chars';

export interface Fighter {
  ch: number;
  side: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  hp: number;
  qi: number;
  st: number;
  sf: number;
  mv: number; // move index or -1
  contact: number; // 0 none, 1 hit, 2 block
  hitsThisMove: number;
  lastHitFrame: number;
  stun: number;
  invul: number;
  airJumps: number;
  airDashes: number;
  wallKicks: number;
  charge: number;
  focusLevel: number;
  deflect: number;
  guardFrames: number;
  deflected: number; // a deflect happened during this guard
  hitstop: number;
  prev: number;
  buf: number[]; // per-button buffered press frames: [U, S, H, G, D, A, X]
  // combo (as defender)
  comboHits: number;
  comboScale: number;
  comboUnique: number;
  comboDmg: number;
  used: number[];
  juggle: number;
  kd: number; // knockdown pending
  wb: number; // wall bounce pending
  gb: number; // ground bounce pending
  wallsUsed: number;
  landLag: number;
  throwT: number; // thrown/cine partner timer
  // stats
  stHits: number;
  stMaxCombo: number;
  stMaxFlow: number;
  stDeflects: number;
  stDamage: number;
  stPerfect: number;
  rounds: number;
}

export interface Projectile {
  owner: number;
  x: number;
  y: number;
  vx: number;
  life: number;
  mv: number;
  id: number;
}

export interface Match {
  frame: number;
  rng: number;
  phase: number;
  pf: number; // phase frame
  round: number;
  timer: number;
  f: Fighter[];
  proj: Projectile[];
  projSeq: number;
  events: SimEvent[];
  cine: number; // -1 none, else owner
  cineF: number;
  winner: number; // round/match winner index or -1
  matchWinner: number;
  koSlow: number;
  version: number;
}

export interface MatchConfig {
  p1: number;
  p2: number;
  seed: number;
  skipIntro?: boolean;
}

const BUF = 6;
const B_U = 0, B_S = 1, B_H = 2, B_G = 3, B_D = 4, B_A = 5, B_X = 6;
const BUF_BITS = [IN.UP, IN.S, IN.H, IN.G, IN.D, IN.A, IN.X];
const DEFLECT_WINDOW = 8;
const FOCUS_HOLD = 9;
const FOCUS_MIN = 12;
const FOCUS_MAX = 50;
const START_X = m(1.6);
const INTRO_FRAMES = 150;
const READY_FRAMES = 80;
const KO_FRAMES = 170;
const WALL_X = STAGE_HALF;

export function charOf(f: Fighter): CharDef {
  return CHARS[f.ch];
}

export function moveOf(f: Fighter): MoveDef | null {
  if (f.mv < 0) return null;
  return CHARS[f.ch].moves[MOVE_NAMES[f.ch][f.mv]];
}

export function moveIndex(ch: number, name: string): number {
  return MOVE_NAMES[ch].indexOf(name);
}

function newFighter(ch: number, side: number): Fighter {
  const c = CHARS[ch];
  return {
    ch, side, x: side === 0 ? -START_X : START_X, y: 0, vx: 0, vy: 0, facing: side === 0 ? 1 : -1,
    hp: c.hp, qi: 0, st: ST.INTRO, sf: 0, mv: -1, contact: 0, hitsThisMove: 0, lastHitFrame: 0, stun: 0, invul: 0,
    airJumps: 0, airDashes: 0, wallKicks: 0, charge: 0, focusLevel: 0, deflect: 0, guardFrames: 0, deflected: 0,
    hitstop: 0, prev: 0, buf: [0, 0, 0, 0, 0, 0, 0], comboHits: 0, comboScale: 1000, comboUnique: 0, comboDmg: 0,
    used: new Array(MAX_MOVES).fill(0), juggle: 0, kd: 0, wb: 0, gb: 0, wallsUsed: 0, landLag: 0, throwT: 0,
    stHits: 0, stMaxCombo: 0, stMaxFlow: 0, stDeflects: 0, stDamage: 0, stPerfect: 0, rounds: 0,
  };
}

export function createMatch(cfg: MatchConfig): Match {
  const s: Match = {
    frame: 0, rng: (cfg.seed >>> 0) || 0x9e3779b9, phase: cfg.skipIntro ? PH.READY : PH.INTRO, pf: 0, round: 1,
    timer: ROUND_FRAMES, f: [newFighter(cfg.p1, 0), newFighter(cfg.p2, 1)], proj: [], projSeq: 0, events: [],
    cine: -1, cineF: 0, winner: -1, matchWinner: -1, koSlow: 0, version: 1,
  };
  if (cfg.skipIntro) for (const f of s.f) enter(f, ST.IDLE);
  return s;
}

export function cloneMatch(s: Match): Match {
  return {
    ...s,
    f: s.f.map((f) => ({ ...f, buf: f.buf.slice(), used: f.used.slice() })),
    proj: s.proj.map((p) => ({ ...p })),
    events: s.events.slice(),
  };
}

export function hashMatch(s: Match): number {
  let h = 2166136261 >>> 0;
  const mix = (n: number) => {
    h ^= n & 0xffff;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= (n >>> 16) & 0xffff;
    h = Math.imul(h, 16777619) >>> 0;
  };
  mix(s.frame); mix(s.phase); mix(s.pf); mix(s.timer); mix(s.rng); mix(s.cine); mix(s.cineF);
  for (const f of s.f) {
    mix(f.x); mix(f.y); mix(f.vx); mix(f.vy); mix(f.hp); mix(f.qi); mix(f.st); mix(f.sf); mix(f.mv); mix(f.stun);
    mix(f.facing); mix(f.hitstop); mix(f.comboHits); mix(f.rounds);
  }
  for (const p of s.proj) { mix(p.x); mix(p.y); mix(p.life); }
  return h >>> 0;
}

export function rand(s: Match): number {
  let x = s.rng;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5; x >>>= 0;
  s.rng = x;
  return x;
}

// ------------------------------------------------------------------ helpers

function enter(f: Fighter, st: number): void {
  f.st = st;
  f.sf = 0;
}

function grounded(f: Fighter): boolean {
  return f.y <= 0 && f.vy <= 0;
}

function emit(s: Match, e: SimEvent): void {
  s.events.push(e);
}

function fwdBit(f: Fighter): number {
  return f.facing > 0 ? IN.RIGHT : IN.LEFT;
}

function backBit(f: Fighter): number {
  return f.facing > 0 ? IN.LEFT : IN.RIGHT;
}

function holdFwd(f: Fighter, inp: number): boolean {
  return (inp & fwdBit(f)) !== 0 && (inp & backBit(f)) === 0;
}

function holdBack(f: Fighter, inp: number): boolean {
  return (inp & backBit(f)) !== 0 && (inp & fwdBit(f)) === 0;
}

function faceOpponent(f: Fighter, o: Fighter): void {
  if (o.x > f.x + 50) f.facing = 1;
  else if (o.x < f.x - 50) f.facing = -1;
}

function gainQi(s: Match, f: Fighter, n: number): void {
  const before = Math.floor(f.qi / QI_BAR);
  f.qi = Math.min(QI_MAX, f.qi + n);
  const after = Math.floor(f.qi / QI_BAR);
  if (after > before) emit(s, { t: 'qi', f: s.frame, who: f.side, bars: after });
}

function consume(f: Fighter, b: number): boolean {
  if (f.buf[b] > 0) {
    f.buf[b] = 0;
    return true;
  }
  return false;
}

function startMove(s: Match, f: Fighter, name: string): boolean {
  const c = charOf(f);
  const md = c.moves[name];
  if (!md) return false;
  if (md.qiCost && f.qi < md.qiCost) return false;
  if (md.qiCost) {
    f.qi -= md.qiCost;
    emit(s, { t: 'art', f: s.frame, who: f.side, move: name });
  }
  enter(f, ST.ATTACK);
  f.mv = moveIndex(f.ch, name);
  f.contact = 0;
  f.hitsThisMove = 0;
  f.lastHitFrame = -99;
  if (md.kind === 'secret') emit(s, { t: 'secret', f: s.frame, who: f.side, phase: 'start' });
  if (!md.air && grounded(f)) {
    f.vx = 0;
  }
  return true;
}

/** Choose a move from buffered presses + direction. `cancelFrom` forbids repeating the current move. */
function tryAttack(s: Match, f: Fighter, inp: number, air: boolean, cancelFrom: string | null): boolean {
  const c = charOf(f);
  const up = (inp & (IN.UP | IN.UPMOD)) !== 0;
  const down = (inp & IN.DOWN) !== 0;
  const fwd = holdFwd(f, inp);
  const pick = (name: string): boolean => {
    if (cancelFrom !== null && name === cancelFrom) return false;
    return !!c.moves[name] && startMove(s, f, name);
  };
  if (!air && f.buf[B_X] > 0 && f.qi >= QI_MAX) {
    if (pick('secret')) { f.buf[B_X] = 0; return true; }
  }
  if (!air && f.buf[B_A] > 0) {
    const name = down ? 'art_d' : fwd ? 'art_f' : 'art_n';
    if (f.qi >= (c.moves[name].qiCost ?? 0) && pick(name)) { f.buf[B_A] = 0; return true; }
  }
  if (f.buf[B_H] > 0) {
    let name: string;
    if (air) name = down ? 'h_air_d' : 'h_air';
    else name = down ? 'h_d' : fwd ? 'h_f' : 'h';
    if (pick(name)) { f.buf[B_H] = 0; return true; }
  }
  if (f.buf[B_S] > 0) {
    let name: string;
    if (air) name = 's_air';
    else if (up) name = 's_u';
    else if (down) name = 's_d';
    else if (fwd) name = 's_f';
    else name = cancelFrom && CHAIN_NEXT[cancelFrom] ? CHAIN_NEXT[cancelFrom] : 's1';
    if (pick(name)) { f.buf[B_S] = 0; return true; }
    if (cancelFrom && !air && pick('s1')) { f.buf[B_S] = 0; return true; }
  }
  return false;
}

function startDash(s: Match, f: Fighter, inp: number): void {
  const back = holdBack(f, inp) || !holdFwd(f, inp);
  enter(f, back ? ST.DASH_B : ST.DASH_F);
  f.invul = 0;
  emit(s, { t: 'dash', f: s.frame, who: f.side });
}

function startJump(s: Match, f: Fighter): void {
  enter(f, ST.JUMPSQUAT);
}

function neutralGround(s: Match, f: Fighter, o: Fighter, inp: number, press: number): void {
  faceOpponent(f, o);
  if (f.buf[B_U] > 0 && f.buf[B_S] === 0 && f.buf[B_H] === 0 && f.buf[B_A] === 0) {
    f.buf[B_U] = 0;
    startJump(s, f);
    return;
  }
  if (tryAttack(s, f, inp, false, null)) return;
  if (consume(f, B_D)) {
    startDash(s, f, inp);
    return;
  }
  if (inp & IN.G) {
    enter(f, ST.GUARD);
    f.guardFrames = 0;
    f.deflected = 0;
    if (press & IN.G) f.deflect = DEFLECT_WINDOW;
    f.vx = 0;
    return;
  }
  const c = charOf(f);
  if (holdFwd(f, inp)) {
    if (f.st !== ST.WALK_F) enter(f, ST.WALK_F);
    f.vx = c.walkF * f.facing;
  } else if (holdBack(f, inp)) {
    if (f.st !== ST.WALK_B) enter(f, ST.WALK_B);
    f.vx = -c.walkB * f.facing;
  } else {
    if (f.st !== ST.IDLE) enter(f, ST.IDLE);
    f.vx = 0;
  }
}

function airActions(s: Match, f: Fighter, inp: number, press: number): boolean {
  const c = charOf(f);
  // wall kick (qinggong)
  const nearWall = Math.abs(f.x) >= WALL_X - m(0.35);
  if ((press & IN.UP) && nearWall && f.wallKicks < 2 && f.y > m(0.3)) {
    const away = f.x > 0 ? -1 : 1;
    f.vx = away * Math.floor((c.jumpX * 3) / 2);
    f.vy = Math.floor((c.jumpV * 9) / 10);
    f.facing = away;
    f.wallKicks++;
    f.airJumps = 0;
    enter(f, ST.JUMP2);
    emit(s, { t: 'jump', f: s.frame, who: f.side, double: true });
    return true;
  }
  if ((press & IN.UP) && f.airJumps < 1) {
    f.airJumps++;
    f.vy = Math.floor((c.jumpV * 88) / 100);
    f.vx = holdFwd(f, inp) ? c.jumpX * f.facing : holdBack(f, inp) ? -c.jumpX * f.facing : Math.floor(f.vx / 2);
    enter(f, ST.JUMP2);
    emit(s, { t: 'jump', f: s.frame, who: f.side, double: true });
    return true;
  }
  if (f.buf[B_D] > 0 && f.airDashes < 1) {
    f.buf[B_D] = 0;
    f.airDashes++;
    enter(f, ST.AIRDASH);
    const dir = holdBack(f, inp) ? -1 : 1;
    f.vx = dir * c.airDashSpeed * f.facing;
    f.vy = 0;
    emit(s, { t: 'dash', f: s.frame, who: f.side });
    return true;
  }
  return tryAttack(s, f, inp, true, null);
}

function land(s: Match, f: Fighter, hard: boolean): void {
  f.y = 0;
  f.vy = 0;
  f.airJumps = 0;
  f.airDashes = 0;
  f.wallKicks = 0;
  emit(s, { t: 'land', f: s.frame, who: f.side, hard });
}

// ------------------------------------------------------------------ per-fighter update

function updateFighter(s: Match, i: number, inpRaw: number): void {
  const f = s.f[i];
  const o = s.f[1 - i];
  const c = charOf(f);
  const inp = inpRaw;
  const press = inp & ~f.prev;
  f.prev = inp;
  for (let b = 0; b < 7; b++) {
    if (press & BUF_BITS[b]) f.buf[b] = BUF;
  }
  if (f.hitstop > 0) {
    f.hitstop--;
    return;
  }
  for (let b = 0; b < 7; b++) if (f.buf[b] > 0) f.buf[b]--;
  if (f.invul > 0) f.invul--;
  if (f.deflect > 0) f.deflect--;
  f.sf++;

  switch (f.st) {
    case ST.INTRO:
    case ST.WIN:
      f.vx = 0;
      break;
    case ST.KO:
      break;
    case ST.IDLE:
    case ST.WALK_F:
    case ST.WALK_B:
      neutralGround(s, f, o, inp, press);
      break;
    case ST.LAND:
      if (f.landLag > 0) {
        f.landLag--;
        f.vx = 0;
        break;
      }
      if (f.sf > 6 || (inp & (BUTTONS | IN.LEFT | IN.RIGHT | IN.UP)) || f.buf.some((x) => x > 0)) neutralGround(s, f, o, inp, press);
      break;
    case ST.JUMPSQUAT:
      f.vx = 0;
      if (f.buf[B_S] > 0 || f.buf[B_H] > 0 || f.buf[B_A] > 0 || f.buf[B_X] > 0) {
        if (tryAttack(s, f, inp | IN.UP, false, null)) break;
      }
      if (f.sf >= 4) {
        enter(f, ST.AIR);
        f.vy = c.jumpV;
        f.vx = holdFwd(f, inp) ? c.jumpX * f.facing : holdBack(f, inp) ? -c.jumpX * f.facing : 0;
        emit(s, { t: 'jump', f: s.frame, who: f.side, double: false });
      }
      break;
    case ST.AIR:
      airActions(s, f, inp, press);
      break;
    case ST.JUMP2:
      if (f.sf > 8) airActions(s, f, inp, press);
      if (f.st === ST.JUMP2 && f.sf > 24) enter(f, ST.AIR);
      break;
    case ST.AIRDASH:
      f.vy = 0;
      if (f.sf > 4 && tryAttack(s, f, inp, true, null)) break;
      if (f.sf >= 14) {
        enter(f, ST.AIR);
        f.vx = Math.floor(f.vx / 2);
      }
      break;
    case ST.DASH_F:
    case ST.DASH_B: {
      const dir = f.st === ST.DASH_F ? 1 : -1;
      const n = c.dashFrames;
      if (f.sf >= 2 && f.sf <= 10) f.invul = Math.max(f.invul, 1);
      const decel = f.sf > n - 6 ? Math.max(0, n - f.sf) : 6;
      f.vx = Math.floor((c.dashSpeed * decel) / 6) * dir * f.facing;
      if (f.sf > 12 && tryAttack(s, f, inp, false, null)) break;
      if (f.sf >= n) {
        enter(f, ST.IDLE);
        f.vx = 0;
      }
      break;
    }
    case ST.GUARD:
      faceOpponent(f, o);
      f.vx = 0;
      f.guardFrames++;
      if (tryAttack(s, f, inp, false, null)) break;
      if (consume(f, B_D)) {
        startDash(s, f, inp);
        break;
      }
      if (!(inp & IN.G)) {
        if (f.guardFrames < 10 && !f.deflected) {
          enter(f, ST.DEFLECT_WHIFF);
        } else {
          enter(f, ST.IDLE);
        }
      }
      break;
    case ST.GUARD_STUN:
      if (press & IN.G) f.deflect = DEFLECT_WINDOW;
      f.vx = Math.trunc((f.vx * 85) / 100);
      if (--f.stun <= 0) {
        if (inp & IN.G) {
          enter(f, ST.GUARD);
          f.guardFrames = 20;
        } else enter(f, ST.IDLE);
      }
      break;
    case ST.DEFLECT:
      f.vx = 0;
      if (f.sf > 3 && tryAttack(s, f, inp, false, null)) break;
      if (f.sf >= 16) enter(f, (inp & IN.G) ? ST.GUARD : ST.IDLE);
      break;
    case ST.DEFLECT_WHIFF:
      f.vx = 0;
      if (f.sf >= 13) enter(f, ST.IDLE);
      break;
    case ST.ATTACK:
      updateAttack(s, f, o, inp, press);
      break;
    case ST.FOCUS_CHARGE:
      f.vx = 0;
      f.charge++;
      if (f.sf === 1) emit(s, { t: 'charge', f: s.frame, who: f.side });
      if (consume(f, B_D)) {
        startDash(s, f, inp);
        break;
      }
      if ((!(inp & IN.H) && f.charge >= FOCUS_MIN) || f.charge >= FOCUS_MAX) {
        f.focusLevel = f.charge;
        startMove(s, f, 'focus_release');
      }
      break;
    case ST.HITSTUN:
      f.vx = Math.trunc((f.vx * 88) / 100);
      if (tryBurst(s, f, o)) break;
      if (--f.stun <= 0) {
        enter(f, ST.IDLE);
        f.comboHits = 0;
      }
      break;
    case ST.AIR_HIT:
      if (tryBurst(s, f, o)) break;
      if (f.stun > 0) f.stun--;
      // air recovery
      if (f.stun <= 0 && !f.kd && (press & BUTTONS) && f.y > m(0.4)) {
        enter(f, ST.JUMP2);
        f.vy = 600;
        f.vx = 0;
        f.comboHits = 0;
        f.juggle = 0;
        f.airJumps = 1;
        emit(s, { t: 'jump', f: s.frame, who: f.side, double: true });
      }
      break;
    case ST.KNOCKDOWN:
      break;
    case ST.DOWN:
      f.vx = Math.trunc((f.vx * 80) / 100);
      if (s.phase === PH.FIGHT && (f.sf >= 40 || (f.sf >= 14 && (press & BUTTONS)))) {
        enter(f, ST.GETUP);
        f.invul = 26;
      }
      break;
    case ST.GETUP:
      f.vx = 0;
      if (f.sf >= 24) {
        enter(f, ST.IDLE);
        f.comboHits = 0;
        f.juggle = 0;
        faceOpponent(f, o);
      }
      break;
    case ST.WALL:
      f.vx = 0;
      f.vy = 0;
      if (f.sf >= 18) {
        enter(f, ST.AIR_HIT);
        f.stun = 14;
        f.kd = 1;
        f.vx = f.x > 0 ? -v6() : v6();
      }
      break;
    case ST.STAGGER:
      f.vx = Math.trunc((f.vx * 85) / 100);
      if (f.sf >= 32) enter(f, ST.IDLE);
      break;
    case ST.CRUMPLE:
      f.vx = Math.trunc((f.vx * 85) / 100);
      if (f.sf >= 44) {
        enter(f, ST.IDLE);
        f.comboHits = 0;
      }
      break;
    case ST.BURST:
      f.vx = 0;
      if (f.sf === 4) {
        const dx = o.x - f.x;
        if (Math.abs(dx) < m(1.8) && o.st !== ST.DOWN) {
          o.vx = (dx >= 0 ? 1 : -1) * 900;
          o.vy = 900;
          enter(o, ST.AIR_HIT);
          o.stun = 20;
          o.kd = 1;
          o.mv = -1;
        }
      }
      if (f.sf >= 22) enter(f, grounded(f) ? ST.IDLE : ST.AIR);
      break;
    case ST.THROWN:
    case ST.CINE_VICTIM:
      break;
  }
}

function v6(): number {
  return 300;
}

function tryBurst(s: Match, f: Fighter, o: Fighter): boolean {
  if (f.buf[B_D] > 0 && f.qi >= 2 * QI_BAR && s.phase === PH.FIGHT) {
    f.buf[B_D] = 0;
    f.qi -= 2 * QI_BAR;
    enter(f, ST.BURST);
    f.invul = 24;
    f.vy = f.y > 0 ? 400 : 0;
    f.comboHits = 0;
    f.juggle = 0;
    emit(s, { t: 'burst', f: s.frame, who: f.side });
    return true;
  }
  return false;
}

function updateAttack(s: Match, f: Fighter, o: Fighter, inp: number, press: number): void {
  const md = moveOf(f)!;
  const name = MOVE_NAMES[f.ch][f.mv];
  const total = md.startup + md.active + md.recovery;
  // motion
  if (md.motion) {
    let seg = null;
    for (const mo of md.motion) if (mo.f <= f.sf) seg = mo;
    if (seg) {
      if (seg.vx !== undefined) f.vx = seg.vx * f.facing;
      if (seg.f === f.sf && seg.vy !== undefined) f.vy = seg.vy;
    }
  } else if (grounded(f) && !md.air) {
    f.vx = Math.trunc((f.vx * 80) / 100);
  }
  if (md.invul && f.sf >= md.invul[0] && f.sf <= md.invul[1]) f.invul = Math.max(f.invul, 1);
  if (f.sf === md.startup - 2) emit(s, { t: 'whiff', f: s.frame, who: f.side, kind: md.kind });
  // projectile spawn
  if (md.projectile && f.sf === md.startup) {
    const p = md.projectile;
    s.proj.push({ owner: f.side, x: f.x + p.ox * f.facing, y: f.y + p.oy, vx: p.speed * f.facing, life: p.life, mv: f.mv, id: ++s.projSeq });
    emit(s, { t: 'proj', f: s.frame, who: f.side, visual: p.visual });
  }
  // pass-through: flip facing afterwards if we crossed
  if (md.passThrough && f.sf === md.passThrough[1] + 1) faceOpponent(f, o);
  // secret cinematic owner: hold until cine ends
  if (s.cine === f.side) return;
  // focus conversion: holding heavy
  if (md.kind === 'heavy' && !md.air && grounded(f) && f.sf === FOCUS_HOLD && (inp & IN.H) && f.contact === 0) {
    enter(f, ST.FOCUS_CHARGE);
    f.mv = -1;
    f.charge = 0;
    return;
  }
  // throw sequence
  if (md.slamFrame !== undefined) {
    updateThrow(s, f, o, md);
    if (f.sf >= total) endAttack(f);
    return;
  }
  // landing
  if (md.air && f.y <= 0 && f.vy <= 0 && f.sf > 1) {
    land(s, f, !!md.landCancel);
    if (md.landCancel) {
      if (md.fx && md.fx !== 'none') emit(s, { t: 'ground', f: s.frame, who: f.side, x: f.x, fx: md.fx });
      enter(f, ST.LAND);
      f.landLag = md.recovery;
    } else {
      enter(f, ST.LAND);
      f.landLag = 3;
    }
    f.mv = -1;
    return;
  }
  // cancels (freestyle chains)
  if (f.contact && f.sf >= md.startup && md.kind !== 'secret') {
    if (md.jumpCancel && f.contact === 1 && (inp & IN.UP) && grounded(f)) {
      startJump(s, f);
      return;
    }
    if (tryAttack(s, f, inp, !grounded(f), name)) return;
    if (f.buf[B_D] > 0 && f.qi >= QI_BAR / 2) {
      f.buf[B_D] = 0;
      f.qi -= QI_BAR / 2;
      f.mv = -1;
      if (grounded(f)) startDash(s, f, inp);
      else {
        enter(f, ST.AIRDASH);
        f.vx = (holdBack(f, inp) ? -1 : 1) * charOf(f).airDashSpeed * f.facing;
        f.vy = 0;
        emit(s, { t: 'dash', f: s.frame, who: f.side });
      }
      return;
    }
  }
  const end = md.landCancel ? 999 : total;
  if (f.sf >= end) endAttack(f);
}

function endAttack(f: Fighter): void {
  f.mv = -1;
  enter(f, f.y > 0 ? ST.AIR : ST.IDLE);
}

function updateThrow(s: Match, f: Fighter, o: Fighter, md: MoveDef): void {
  // victim held in front; slam at slamFrame
  if (o.st !== ST.THROWN) return;
  const t = f.sf;
  const lift = t < md.slamFrame! ? Math.min(m(1.4), Math.floor((m(1.4) * t) / 20)) : 0;
  o.x = f.x + f.facing * m(t < md.slamFrame! ? 0.35 : 0.85);
  o.y = lift;
  o.vx = 0;
  o.vy = 0;
  if (t === md.slamFrame) {
    o.y = 0;
    applyDamage(s, f, o, md, md.damage, f.mv, false);
    enter(o, ST.DOWN);
    o.sf = 0;
    f.hitstop = md.hitstop;
    o.hitstop = md.hitstop;
    emit(s, { t: 'ground', f: s.frame, who: f.side, x: o.x, fx: 'crater' });
    emit(s, { t: 'hit', f: s.frame, atk: f.side, def: o.side, x: o.x, y: m(0.3), power: 3, move: 'throw', kind: 'grab', counter: false, flow: o.comboUnique, hits: o.comboHits, fx: 'crater', stale: false });
  }
}

// ------------------------------------------------------------------ physics

function physics(s: Match, f: Fighter): void {
  if (f.hitstop > 0) return;
  if (f.st === ST.THROWN || f.st === ST.CINE_VICTIM || f.st === ST.WALL) return;
  const md = f.st === ST.ATTACK ? moveOf(f) : null;
  let float = f.st === ST.AIRDASH && f.sf < 10;
  if (md && md.motion) {
    for (const mo of md.motion) if (mo.f <= f.sf && mo.float) float = true;
  }
  if (s.cine === f.side) float = true;
  f.x += f.vx;
  if (!float) {
    if (f.y > 0 || f.vy > 0) {
      f.vy -= f.st === ST.AIR_HIT ? GRAVITY - 6 : GRAVITY;
      if (f.vy < -MAX_FALL) f.vy = -MAX_FALL;
    }
  }
  f.y += f.vy;
  // walls
  if (f.x > WALL_X) hitWall(s, f, WALL_X);
  else if (f.x < -WALL_X) hitWall(s, f, -WALL_X);
  // ground
  if (f.y <= 0 && (f.vy < 0 || f.y < 0)) {
    f.y = 0;
    const wasVy = f.vy;
    f.vy = 0;
    onGround(s, f, wasVy);
  }
  if (f.y <= 0 && grounded(f) && (f.st === ST.IDLE || f.st === ST.HITSTUN || f.st === ST.STAGGER || f.st === ST.DOWN)) {
    // friction for ground slide
    if (f.st !== ST.HITSTUN && f.st !== ST.STAGGER && f.st !== ST.DOWN) {
      if (f.vx > 0) f.vx = Math.max(0, f.vx - GROUND_FRICTION);
      else if (f.vx < 0) f.vx = Math.min(0, f.vx + GROUND_FRICTION);
    }
  }
}

function hitWall(s: Match, f: Fighter, x: number): void {
  f.x = x;
  if ((f.st === ST.AIR_HIT || f.st === ST.HITSTUN) && f.wb && f.wallsUsed < 1) {
    f.wb = 0;
    f.wallsUsed++;
    enter(f, ST.WALL);
    f.vx = 0;
    f.vy = 0;
    f.y = Math.max(f.y, m(0.5));
    f.hitstop = 6;
    emit(s, { t: 'wall', f: s.frame, who: f.side, x: f.x, y: f.y + m(1.0) });
    return;
  }
  if ((f.st === ST.HITSTUN || f.st === ST.GUARD_STUN) && f.vx !== 0) {
    const a = s.f[1 - f.side];
    if (a.st === ST.ATTACK && grounded(a) && Math.abs(a.x - f.x) < m(1.6)) a.vx = -Math.trunc((f.vx * 70) / 100);
  }
  if (f.st !== ST.ATTACK) f.vx = 0;
}

function onGround(s: Match, f: Fighter, vy: number): void {
  switch (f.st) {
    case ST.AIR:
    case ST.JUMP2:
    case ST.AIRDASH:
      land(s, f, false);
      enter(f, ST.LAND);
      f.landLag = 0;
      break;
    case ST.AIR_HIT:
      if (f.gb) {
        f.gb = 0;
        f.vy = 1000;
        f.y = 1;
        f.stun = Math.max(f.stun, 26);
        emit(s, { t: 'ground', f: s.frame, who: f.side, x: f.x, fx: 'cracks' });
        break;
      }
      enter(f, ST.DOWN);
      f.kd = 0;
      f.juggle = 0;
      emit(s, { t: 'land', f: s.frame, who: f.side, hard: true });
      break;
    case ST.ATTACK:
      // handled in updateAttack (landing)
      break;
    case ST.BURST:
      break;
    case ST.KO:
      break;
    default:
      break;
  }
  void vy;
}

function pushApart(s: Match): void {
  const [a, b] = s.f;
  const passA = isPassing(a);
  const passB = isPassing(b);
  if (passA || passB) return;
  if (a.st === ST.THROWN || b.st === ST.THROWN || a.st === ST.CINE_VICTIM || b.st === ST.CINE_VICTIM) return;
  if (a.st === ST.DOWN || b.st === ST.DOWN) return;
  const hA = charOf(a).height, hB = charOf(b).height;
  const vertOverlap = a.y < b.y + hB && b.y < a.y + hA;
  if (!vertOverlap) return;
  const dx = b.x - a.x;
  const minD = PUSH_HALF * 2;
  if (Math.abs(dx) >= minD) return;
  const overlap = minD - Math.abs(dx);
  let dir = dx > 0 ? 1 : dx < 0 ? -1 : a.facing;
  // whoever is airborne above the other gets pushed by their side
  let pa = Math.floor(overlap / 2);
  let pb = overlap - pa;
  a.x -= dir * pa;
  b.x += dir * pb;
  // keep within walls
  for (const f of s.f) {
    if (f.x > WALL_X) {
      const d = f.x - WALL_X;
      f.x = WALL_X;
      const other = f === a ? b : a;
      other.x -= d;
    } else if (f.x < -WALL_X) {
      const d = -WALL_X - f.x;
      f.x = -WALL_X;
      const other = f === a ? b : a;
      other.x += d;
    }
  }
  void dir;
}

function isPassing(f: Fighter): boolean {
  if (f.st !== ST.ATTACK) return false;
  const md = moveOf(f)!;
  return !!md.passThrough && f.sf >= md.passThrough[0] && f.sf <= md.passThrough[1];
}

// ------------------------------------------------------------------ hits

interface Rect {
  l: number;
  r: number;
  b: number;
  t: number;
}

function hurtbox(f: Fighter): Rect | null {
  if (f.st === ST.THROWN || f.st === ST.CINE_VICTIM || f.st === ST.GETUP || f.st === ST.INTRO || f.st === ST.KO) return null;
  const c = charOf(f);
  let h = c.height;
  if (f.st === ST.DOWN) {
    return { l: f.x - m(0.7), r: f.x + m(0.7), b: f.y, t: f.y + m(0.3) };
  }
  if (f.st === ST.ATTACK) {
    const md = moveOf(f)!;
    if (md.name === 's_d' || md.name === 'h_d') h = Math.floor((h * 60) / 100);
  }
  if (f.st === ST.AIR_HIT || f.st === ST.KNOCKDOWN) h = Math.floor((h * 75) / 100);
  return { l: f.x - c.hurtW, r: f.x + c.hurtW, b: f.y, t: f.y + h };
}

function hitRect(f: Fighter, md: MoveDef): Rect {
  const cx = md.around ? f.x : f.x + md.box.x * f.facing;
  const cy = f.y + md.box.y;
  return { l: cx - md.box.w, r: cx + md.box.w, b: cy - md.box.h, t: cy + md.box.h };
}

function overlap(a: Rect, b: Rect): boolean {
  return a.l < b.r && b.l < a.r && a.b < b.t && b.b < a.t;
}

function isActive(f: Fighter, md: MoveDef): boolean {
  if (md.box.w === 0) return false;
  const a0 = md.startup;
  const a1 = md.landCancel ? 999 : md.startup + md.active - 1;
  if (f.sf < a0 || f.sf > a1) return false;
  const maxHits = md.hits ?? 1;
  if (f.hitsThisMove >= maxHits) return false;
  if (f.hitsThisMove > 0 && f.sf - f.lastHitFrame < (md.rehit ?? 99)) return false;
  return true;
}

function canBeHit(d: Fighter, md: MoveDef): boolean {
  if (d.invul > 0) return false;
  if (d.st === ST.DOWN && !md.otg) return false;
  if (d.st === ST.GETUP || d.st === ST.THROWN || d.st === ST.CINE_VICTIM) return false;
  return true;
}

interface PendingHit {
  atk: number;
  md: MoveDef;
  mvIdx: number;
  x: number;
  y: number;
  proj: Projectile | null;
}

function detectHits(s: Match): PendingHit[] {
  const out: PendingHit[] = [];
  for (let i = 0; i < 2; i++) {
    const a = s.f[i];
    const d = s.f[1 - i];
    if (a.st !== ST.ATTACK || a.hitstop > 0) continue;
    const md = moveOf(a)!;
    if (!isActive(a, md)) continue;
    if (!canBeHit(d, md)) continue;
    const hb = hurtbox(d);
    if (!hb) continue;
    const hr = hitRect(a, md);
    if (overlap(hr, hb)) {
      out.push({ atk: i, md, mvIdx: a.mv, x: Math.floor((Math.max(hr.l, hb.l) + Math.min(hr.r, hb.r)) / 2), y: Math.floor((Math.max(hr.b, hb.b) + Math.min(hr.t, hb.t)) / 2), proj: null });
    }
  }
  // projectiles
  for (const p of s.proj) {
    if (p.life <= 0) continue;
    const owner = s.f[p.owner];
    const d = s.f[1 - p.owner];
    const md = CHARS[owner.ch].moves[MOVE_NAMES[owner.ch][p.mv]];
    const pd = md.projectile!;
    const pr: Rect = { l: p.x - pd.box.w, r: p.x + pd.box.w, b: p.y - pd.box.h, t: p.y + pd.box.h };
    // projectile clash
    for (const q of s.proj) {
      if (q === p || q.owner === p.owner || q.life <= 0) continue;
      const od = CHARS[s.f[q.owner].ch].moves[MOVE_NAMES[s.f[q.owner].ch][q.mv]].projectile!;
      const qr: Rect = { l: q.x - od.box.w, r: q.x + od.box.w, b: q.y - od.box.h, t: q.y + od.box.h };
      if (overlap(pr, qr)) {
        p.life = 0;
        q.life = 0;
        emit(s, { t: 'block', f: s.frame, def: d.side, x: p.x, y: p.y, power: 2 });
      }
    }
    if (p.life <= 0) continue;
    if (!canBeHit(d, md)) continue;
    const hb = hurtbox(d);
    if (hb && overlap(pr, hb)) {
      out.push({ atk: p.owner, md, mvIdx: p.mv, x: p.x, y: p.y, proj: p });
      p.life = 0;
    }
  }
  return out;
}

function facingTowards(d: Fighter, a: Fighter, x: number): boolean {
  return (x - d.x) * d.facing >= -m(0.1) || (a.x - d.x) * d.facing >= 0;
}

function applyDamage(s: Match, a: Fighter, d: Fighter, md: MoveDef, base: number, mvIdx: number, counter: boolean): number {
  const inCombo = d.comboHits > 0 && isHitState(d.st);
  if (!inCombo) {
    d.comboHits = 0;
    d.comboScale = 1000;
    d.comboUnique = 0;
    d.comboDmg = 0;
    d.juggle = 0;
    d.wallsUsed = 0;
    for (let k = 0; k < d.used.length; k++) d.used[k] = 0;
  }
  const uses = mvIdx >= 0 ? d.used[mvIdx] : 0;
  if (mvIdx >= 0) {
    if (uses === 0) d.comboUnique++;
    d.used[mvIdx]++;
  }
  d.comboHits++;
  const stale = uses === 0 ? 1000 : uses === 1 ? 600 : 360;
  const flow = 1000 + Math.min(300, 25 * Math.max(0, d.comboUnique - 1));
  let dmg = Math.floor((base * d.comboScale) / 1000);
  dmg = Math.floor((dmg * stale) / 1000);
  dmg = Math.floor((dmg * flow) / 1000);
  if (counter) dmg = Math.floor((dmg * 125) / 100);
  dmg = Math.max(1, dmg);
  d.comboScale = Math.max(350, Math.floor((d.comboScale * 915) / 1000));
  d.hp = Math.max(0, d.hp - dmg);
  d.comboDmg += dmg;
  a.stHits++;
  a.stDamage += dmg;
  a.stMaxCombo = Math.max(a.stMaxCombo, d.comboHits);
  a.stMaxFlow = Math.max(a.stMaxFlow, d.comboUnique);
  return uses;
}

function isHitState(st: number): boolean {
  return st === ST.HITSTUN || st === ST.AIR_HIT || st === ST.WALL || st === ST.CRUMPLE || st === ST.STAGGER ||
    st === ST.KNOCKDOWN || st === ST.DOWN || st === ST.CINE_VICTIM || st === ST.THROWN;
}

function resolveHit(s: Match, h: PendingHit): void {
  const a = s.f[h.atk];
  const d = s.f[1 - h.atk];
  const md = h.md;
  if (!h.proj) {
    a.hitsThisMove++;
    a.lastHitFrame = a.sf;
  }
  // counter stance (Diamond Body)
  if (d.st === ST.ATTACK) {
    const dm = moveOf(d)!;
    if (dm.counter && d.sf >= dm.counter[0] && d.sf <= dm.counter[1] && md.kind !== 'grab' && md.kind !== 'secret') {
      a.hitstop = 14;
      d.hitstop = 10;
      emit(s, { t: 'deflect', f: s.frame, def: d.side, x: h.x, y: h.y });
      startMove(s, d, dm.counterMove!);
      d.invul = 12;
      if (!h.proj) a.contact = 2;
      return;
    }
  }
  // grabs
  if (md.kind === 'grab') {
    if (d.y > 0 || d.st === ST.DOWN || isHitState(d.st)) return;
    a.contact = 1;
    enter(d, ST.THROWN);
    d.mv = -1;
    startMove(s, a, md.throwMove!);
    a.contact = 1;
    emit(s, { t: 'grab', f: s.frame, who: a.side });
    return;
  }
  const defending = (d.st === ST.GUARD || d.st === ST.GUARD_STUN || d.st === ST.DEFLECT) && facingTowards(d, a, h.x);
  // deflect
  if (d.deflect > 0 && defending && md.kind !== 'secret') {
    d.deflect = 0;
    d.deflected = 1;
    enter(d, ST.DEFLECT);
    d.vx = 0;
    gainQi(s, d, 40);
    d.stDeflects++;
    a.hitstop = 13;
    d.hitstop = 13;
    if (!h.proj) {
      a.contact = 2;
      enter(a, ST.STAGGER);
      a.mv = -1;
      a.vx = -a.facing * 380;
      a.vy = a.y > 0 ? 300 : 0;
    }
    emit(s, { t: 'deflect', f: s.frame, def: d.side, x: h.x, y: h.y });
    return;
  }
  if (d.st === ST.DEFLECT) {
    // invulnerable flourish
    return;
  }
  if (defending && md.kind !== 'secret') {
    if (md.unblockable) {
      // guard crush
      applyDamage(s, a, d, md, md.damage + focusBonus(a, md), h.mvIdx, false);
      enter(d, ST.CRUMPLE);
      d.mv = -1;
      d.vx = a.facing * 500;
      a.hitstop = md.hitstop;
      d.hitstop = md.hitstop;
      if (!h.proj) a.contact = 1;
      emit(s, { t: 'crush', f: s.frame, def: d.side, x: h.x, y: h.y });
      gainQi(s, a, 20);
      return;
    }
    enter(d, ST.GUARD_STUN);
    d.stun = md.blockstun;
    d.vx = a.facing * (md.blockPush ?? 300) * (h.proj ? 0 : 1) + (h.proj ? h.proj.vx > 0 ? 200 : -200 : 0);
    const hs = Math.max(4, md.hitstop - 3);
    if (!h.proj) {
      a.hitstop = hs;
      a.contact = 2;
    }
    d.hitstop = hs;
    gainQi(s, d, 4);
    gainQi(s, a, 3);
    emit(s, { t: 'block', f: s.frame, def: d.side, x: h.x, y: h.y, power: md.kind === 'strike' ? 1 : 2 });
    return;
  }
  // armour
  if (d.st === ST.ATTACK) {
    const dm = moveOf(d)!;
    if (dm.armor && d.sf >= dm.armor[0] && d.sf <= dm.armor[1] && md.kind !== 'focus' && md.kind !== 'secret') {
      const dmg = Math.floor(md.damage / 2);
      d.hp = Math.max(1, d.hp - dmg);
      a.hitstop = md.hitstop;
      d.hitstop = Math.floor(md.hitstop / 2);
      if (!h.proj) a.contact = 1;
      emit(s, { t: 'block', f: s.frame, def: d.side, x: h.x, y: h.y, power: 3 });
      return;
    }
  }
  // clean hit
  const counter = (d.st === ST.ATTACK && d.sf < (moveOf(d)?.startup ?? 0)) || d.st === ST.FOCUS_CHARGE;
  // secret arts start a cinematic
  if (md.cine) {
    if (!h.proj) a.contact = 1;
    s.cine = a.side;
    s.cineF = 0;
    enter(d, ST.CINE_VICTIM);
    d.mv = -1;
    d.vx = 0;
    d.vy = 0;
    d.y = 0;
    a.vx = 0;
    a.vy = 0;
    a.y = 0;
    applyDamage(s, a, d, md, 10, h.mvIdx, false);
    emit(s, { t: 'secret', f: s.frame, who: a.side, phase: 'connect' });
    return;
  }
  const uses = applyDamage(s, a, d, md, md.damage + focusBonus(a, md), h.mvIdx, counter);
  let stun = md.hitstun;
  if (uses === 1) stun = Math.floor((stun * 75) / 100);
  else if (uses >= 2) stun = Math.floor((stun * 55) / 100);
  if (counter) stun += 6;
  const airborne = d.y > 0 || d.st === ST.AIR_HIT || d.st === ST.WALL;
  if (airborne) {
    d.juggle++;
    stun = Math.max(6, stun - d.juggle * 3);
  }
  const weight = charOf(d).weight;
  d.vx = Math.floor((md.pushX * a.facing * weight) / 1000);
  if (h.proj) d.vx = (h.proj.vx > 0 ? 1 : -1) * md.pushX;
  d.mv = -1;
  if (md.launch || md.knockdown || airborne || (md.pushY ?? 0) > 0) {
    let vy = md.pushY ?? 0;
    if (airborne && vy <= 0 && !md.groundBounce) vy = Math.max(vy, 520 - d.juggle * 40);
    if (airborne && md.groundBounce) vy = md.pushY ?? -600;
    if (md.launch && airborne) vy = Math.floor((vy * 80) / 100);
    d.vy = Math.floor((vy * weight) / 1000);
    if (d.y <= 0 && d.vy > 0) d.y = 1;
    enter(d, ST.AIR_HIT);
    d.stun = stun;
    d.kd = md.knockdown || md.groundBounce || d.juggle > 6 ? 1 : d.kd;
    if (md.groundBounce) d.gb = 1;
  } else {
    enter(d, ST.HITSTUN);
    d.stun = stun;
  }
  if (md.wallBounce) d.wb = 1;
  const hs = md.hitstop + (counter ? 4 : 0);
  if (!h.proj) {
    a.hitstop = hs;
    a.contact = 1;
  }
  d.hitstop = hs;
  gainQi(s, a, md.kind === 'strike' ? 9 : md.kind === 'art' ? 4 : 14);
  gainQi(s, d, 6);
  const power = md.kind === 'focus' ? 4 : md.kind === 'heavy' || md.kind === 'art' ? 3 : md.sfx === 'heavy' ? 2 : 1;
  emit(s, {
    t: 'hit', f: s.frame, atk: a.side, def: d.side, x: h.x, y: h.y, power, move: md.name, kind: md.kind, counter,
    flow: d.comboUnique, hits: d.comboHits, fx: md.fx ?? 'none', stale: uses > 0,
  });
}

function focusBonus(a: Fighter, md: MoveDef): number {
  if (md.kind !== 'focus') return 0;
  const lvl = Math.min(FOCUS_MAX, a.focusLevel);
  return Math.floor(((lvl - FOCUS_MIN) * 70) / (FOCUS_MAX - FOCUS_MIN));
}

function updateCine(s: Match): void {
  if (s.cine < 0) return;
  const a = s.f[s.cine];
  const d = s.f[1 - s.cine];
  const md = moveOf(a);
  if (!md || !md.cine || a.st !== ST.ATTACK) {
    s.cine = -1;
    return;
  }
  const cn = md.cine;
  d.x = a.x + a.facing * m(0.75);
  d.y = 0;
  const clipF = a.sf;
  // hit-stop freezes the attacker's frame counter: only process each cinematic frame once
  if (clipF === s.cineF) return;
  s.cineF = clipF;
  if (cn.hitFrames.includes(clipF)) {
    const per = CINE_HIT_DAMAGE[CHARS[a.ch].id] ?? 10;
    applyDamage(s, a, d, md, per, -1, false);
    if (d.hp <= 0) d.hp = 1;
    emit(s, { t: 'hit', f: s.frame, atk: a.side, def: d.side, x: d.x, y: m(1.3), power: 1, move: 'secret', kind: 'secret', counter: false, flow: d.comboUnique, hits: d.comboHits, fx: 'none', stale: false });
  }
  if (clipF === cn.finishFrame) {
    applyDamage(s, a, d, md, cn.finishDamage, -1, false);
    emit(s, { t: 'secret', f: s.frame, who: a.side, phase: 'finish' });
    emit(s, { t: 'hit', f: s.frame, atk: a.side, def: d.side, x: d.x, y: m(1.0), power: 5, move: 'secret', kind: 'secret', counter: false, flow: d.comboUnique, hits: d.comboHits, fx: 'crater', stale: false });
    emit(s, { t: 'ground', f: s.frame, who: a.side, x: d.x, fx: 'crater' });
    enter(d, ST.AIR_HIT);
    d.vy = 1300;
    d.y = 1;
    d.vx = a.facing * 700;
    d.stun = 40;
    d.kd = 1;
    a.hitstop = 22;
    d.hitstop = 22;
  }
  if (clipF >= cn.length) {
    s.cine = -1;
    endAttack(a);
  }
}

// ------------------------------------------------------------------ main step

export function step(s: Match, in0: number, in1: number): void {
  s.events.length = 0;
  s.frame++;
  s.pf++;
  const live = s.phase === PH.FIGHT && s.cine < 0;
  const inputs = [live ? in0 : 0, live ? in1 : 0];
  if (s.phase === PH.FIGHT && s.cine >= 0) {
    inputs[s.cine] = 0;
  }
  // phase flow
  switch (s.phase) {
    case PH.INTRO:
      if (s.pf === 1) for (const f of s.f) enter(f, ST.INTRO);
      if (s.pf >= INTRO_FRAMES) setPhase(s, PH.READY);
      break;
    case PH.READY:
      if (s.pf === 1) {
        emit(s, { t: 'round', f: s.frame, n: s.round });
        for (const f of s.f) if (f.st === ST.INTRO) enter(f, ST.IDLE);
      }
      if (s.pf >= READY_FRAMES) {
        setPhase(s, PH.FIGHT);
        emit(s, { t: 'fight', f: s.frame });
      }
      break;
    case PH.FIGHT:
      if (s.cine < 0 && s.timer > 0) s.timer--;
      break;
  }

  for (let i = 0; i < 2; i++) updateFighter(s, i, inputs[i]);
  updateCine(s);
  for (const f of s.f) physics(s, f);
  pushApart(s);
  // projectiles move
  for (const p of s.proj) {
    p.x += p.vx;
    p.life--;
    if (Math.abs(p.x) > STAGE_HALF + m(1)) p.life = 0;
  }
  if (s.phase === PH.FIGHT || s.phase === PH.KO) {
    const hits = detectHits(s);
    for (const h of hits) resolveHit(s, h);
  }
  s.proj = s.proj.filter((p) => p.life > 0);

  // round end checks
  if (s.phase === PH.FIGHT) {
    const ko0 = s.f[0].hp <= 0;
    const ko1 = s.f[1].hp <= 0;
    if (ko0 || ko1) {
      const loser = ko0 && ko1 ? (s.f[0].hp <= s.f[1].hp ? 0 : 1) : ko0 ? 0 : 1;
      s.winner = 1 - loser;
      const w = s.f[s.winner];
      emit(s, { t: 'ko', f: s.frame, loser, perfect: w.hp === charOf(w).hp });
      const L = s.f[loser];
      if (L.st !== ST.CINE_VICTIM && L.st !== ST.THROWN && L.st !== ST.DOWN) {
        if (L.st !== ST.AIR_HIT) {
          enter(L, ST.AIR_HIT);
          L.vy = 950;
          L.y = Math.max(L.y, 1);
          L.vx = w.facing * 420;
        }
        L.kd = 1;
        L.stun = 999;
        L.mv = -1;
      }
      if (w.hp === charOf(w).hp) w.stPerfect++;
      s.koSlow = 60;
      setPhase(s, PH.KO);
    } else if (s.timer <= 0) {
      const p0 = Math.floor((s.f[0].hp * 1000) / charOf(s.f[0]).hp);
      const p1 = Math.floor((s.f[1].hp * 1000) / charOf(s.f[1]).hp);
      s.winner = p0 === p1 ? (rand(s) & 1) : p0 > p1 ? 0 : 1;
      emit(s, { t: 'timeout', f: s.frame });
      setPhase(s, PH.KO);
    }
  } else if (s.phase === PH.KO) {
    if (s.koSlow > 0) s.koSlow--;
    const w = s.f[s.winner];
    if (s.pf > 70 && (w.st === ST.IDLE || w.st === ST.WALK_B || w.st === ST.WALK_F || w.st === ST.LAND || w.st === ST.GUARD)) {
      enter(w, ST.WIN);
      w.vx = 0;
    }
    if (s.pf >= KO_FRAMES) {
      w.rounds++;
      emit(s, { t: 'roundWin', f: s.frame, winner: s.winner });
      if (w.rounds >= ROUNDS_TO_WIN) {
        s.matchWinner = s.winner;
        emit(s, { t: 'match', f: s.frame, winner: s.winner });
        setPhase(s, PH.MATCH_END);
        enter(w, ST.WIN);
      } else {
        nextRound(s);
      }
    }
  }
}

function setPhase(s: Match, ph: number): void {
  s.phase = ph;
  s.pf = 0;
}

function nextRound(s: Match): void {
  s.round++;
  s.timer = ROUND_FRAMES;
  s.proj = [];
  s.cine = -1;
  s.winner = -1;
  for (const f of s.f) {
    const c = charOf(f);
    f.x = f.side === 0 ? -START_X : START_X;
    f.y = 0;
    f.vx = 0;
    f.vy = 0;
    f.facing = f.side === 0 ? 1 : -1;
    f.hp = c.hp;
    f.mv = -1;
    f.stun = 0;
    f.hitstop = 0;
    f.invul = 0;
    f.comboHits = 0;
    f.juggle = 0;
    f.kd = f.wb = f.gb = 0;
    enter(f, ST.IDLE);
  }
  setPhase(s, PH.READY);
}
