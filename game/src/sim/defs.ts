// Deterministic simulation definitions. Integer math only (no Math.sin/cos/random in gameplay).

export const FPS = 60;
/** Sim units per metre. */
export const U = 10000;
export const m = (metres: number): number => Math.round(metres * U);

export const STAGE_HALF = m(7);
export const GRAVITY = 72;
export const MAX_FALL = 1900;
export const GROUND_FRICTION = 60;
export const PUSH_HALF = m(0.29);

export const ROUND_FRAMES = 60 * FPS;
export const ROUNDS_TO_WIN = 2;
export const QI_MAX = 300;
export const QI_BAR = 100;

// ---------------------------------------------------------------- input bits
export const IN = {
  UP: 1,
  DOWN: 2,
  LEFT: 4,
  RIGHT: 8,
  S: 16, // strike
  H: 32, // heavy (hold = focus)
  G: 64, // guard (tap on impact = deflect)
  D: 128, // dodge
  A: 256, // qi art
  X: 512, // secret art
  /** 'up' as an attack modifier only (never jumps) — used by the touch stick */
  UPMOD: 1024,
} as const;
export const BUTTONS = IN.S | IN.H | IN.G | IN.D | IN.A | IN.X;

// ---------------------------------------------------------------- fighter states
export const ST = {
  IDLE: 0,
  WALK_F: 1,
  WALK_B: 2,
  JUMPSQUAT: 3,
  AIR: 4,
  LAND: 5,
  DASH_F: 6,
  DASH_B: 7,
  AIRDASH: 8,
  GUARD: 9,
  GUARD_STUN: 10,
  DEFLECT: 11, // successful deflect flourish
  DEFLECT_WHIFF: 12,
  ATTACK: 13,
  FOCUS_CHARGE: 14,
  HITSTUN: 15,
  AIR_HIT: 16,
  KNOCKDOWN: 17,
  DOWN: 18,
  GETUP: 19,
  WALL: 20,
  STAGGER: 21,
  CRUMPLE: 22,
  BURST: 23,
  THROWN: 24,
  CINE_VICTIM: 25,
  INTRO: 26,
  WIN: 27,
  KO: 28,
  JUMP2: 29,
} as const;
export type StateId = (typeof ST)[keyof typeof ST];

export const ST_NAMES: Record<number, string> = Object.fromEntries(Object.entries(ST).map(([k, v]) => [v, k]));

// ---------------------------------------------------------------- moves
export type MoveKind = 'strike' | 'heavy' | 'focus' | 'art' | 'secret' | 'grab';
export type FxKind = 'none' | 'cracks' | 'crater' | 'speedlines' | 'impact';

export interface Box {
  /** centre offset forward (along facing), metres-units */
  x: number;
  /** centre height above feet */
  y: number;
  /** half width */
  w: number;
  /** half height */
  h: number;
}

export interface Motion {
  /** frame (relative to move start) from which this applies */
  f: number;
  /** horizontal velocity (forward positive), units/frame; null = keep */
  vx?: number;
  /** vertical velocity set once at frame f */
  vy?: number;
  /** if true, zero gravity while this segment is active */
  float?: boolean;
}

export interface ProjectileDef {
  speed: number;
  life: number;
  box: Box;
  /** spawn offset from fighter */
  ox: number;
  oy: number;
  visual: string;
}

export interface MoveDef {
  name: string;
  anim: string;
  kind: MoveKind;
  startup: number;
  active: number;
  recovery: number;
  damage: number;
  hitstun: number;
  blockstun: number;
  box: Box;
  /** knockback on hit: forward velocity given to the victim (units/frame) */
  pushX: number;
  /** vertical velocity given to the victim on hit (launch) */
  pushY?: number;
  /** pushback on block */
  blockPush?: number;
  launch?: boolean;
  knockdown?: boolean;
  wallBounce?: boolean;
  groundBounce?: boolean;
  unblockable?: boolean;
  /** hits downed opponents */
  otg?: boolean;
  air?: boolean;
  /** ends when landing (dive kicks); recovery then plays as landing lag */
  landCancel?: boolean;
  hitstop: number;
  qiCost?: number;
  invul?: [number, number];
  armor?: [number, number];
  motion?: Motion[];
  /** number of separate hits allowed in the active window (re-hit every `rehit` frames) */
  hits?: number;
  rehit?: number;
  projectile?: ProjectileDef;
  /** crosses through the opponent (no pushbox) during these frames, flips facing after */
  passThrough?: [number, number];
  /** counter stance: if hit during these frames, trigger `counterMove` */
  counter?: [number, number];
  counterMove?: string;
  /** command grab: on connect play `throwMove` */
  throwMove?: string;
  /** throw data: frame of slam, damage on slam */
  slamFrame?: number;
  sfx: 'light' | 'heavy' | 'focus' | 'secret';
  fx?: FxKind;
  /** jump-cancellable on hit (launchers) */
  jumpCancel?: boolean;
  /** hits all around (stomps), not just forward */
  around?: boolean;
  /** secret art cinematic: total frames after connect; multi-hit damage frames */
  cine?: { length: number; hitFrames: number[]; finishFrame: number; finishDamage: number };
}

export interface CharDef {
  id: string;
  name: string;
  nameKo: string;
  title: string;
  hp: number;
  walkF: number;
  walkB: number;
  jumpV: number;
  jumpX: number;
  dashSpeed: number;
  dashFrames: number;
  airDashSpeed: number;
  /** hurtbox half sizes */
  hurtW: number;
  height: number;
  weight: number; // knockback scale per-mille (heavier = less)
  moves: Record<string, MoveDef>;
}

// ---------------------------------------------------------------- phases
export const PH = {
  INTRO: 0,
  READY: 1,
  FIGHT: 2,
  KO: 3,
  ROUND_END: 4,
  MATCH_END: 5,
} as const;

export type SimEvent =
  | { t: 'hit'; f: number; atk: number; def: number; x: number; y: number; power: number; move: string; kind: MoveKind; counter: boolean; flow: number; hits: number; fx: FxKind; stale: boolean }
  | { t: 'block'; f: number; def: number; x: number; y: number; power: number }
  | { t: 'deflect'; f: number; def: number; x: number; y: number }
  | { t: 'crush'; f: number; def: number; x: number; y: number }
  | { t: 'whiff'; f: number; who: number; kind: MoveKind }
  | { t: 'jump'; f: number; who: number; double: boolean }
  | { t: 'land'; f: number; who: number; hard: boolean }
  | { t: 'dash'; f: number; who: number }
  | { t: 'qi'; f: number; who: number; bars: number }
  | { t: 'art'; f: number; who: number; move: string }
  | { t: 'charge'; f: number; who: number }
  | { t: 'burst'; f: number; who: number }
  | { t: 'wall'; f: number; who: number; x: number; y: number }
  | { t: 'ground'; f: number; who: number; x: number; fx: FxKind }
  | { t: 'proj'; f: number; who: number; visual: string }
  | { t: 'secret'; f: number; who: number; phase: 'start' | 'connect' | 'finish' }
  | { t: 'grab'; f: number; who: number }
  | { t: 'round'; f: number; n: number }
  | { t: 'fight'; f: number }
  | { t: 'ko'; f: number; loser: number; perfect: boolean }
  | { t: 'timeout'; f: number }
  | { t: 'roundWin'; f: number; winner: number }
  | { t: 'match'; f: number; winner: number };
