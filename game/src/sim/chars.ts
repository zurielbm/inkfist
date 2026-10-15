import { CharDef, FPS, MoveDef, U, m, Box, Motion } from './defs';

/** metres/second -> units/frame */
export const v = (mps: number): number => Math.round((mps * U) / FPS);
const B = (x: number, y: number, w: number, h: number): Box => ({ x: m(x), y: m(y), w: m(w), h: m(h) });

type Opt = Partial<MoveDef>;

function mv(
  name: string,
  kind: MoveDef['kind'],
  [startup, active, recovery]: [number, number, number],
  damage: number,
  box: Box,
  o: Opt = {},
): MoveDef {
  const heavyish = kind !== 'strike';
  return {
    name,
    anim: o.anim ?? name,
    kind,
    startup,
    active,
    recovery,
    damage,
    box,
    hitstun: o.hitstun ?? (kind === 'strike' ? 16 : 24),
    blockstun: o.blockstun ?? (kind === 'strike' ? 11 : 16),
    pushX: o.pushX ?? v(1.4),
    blockPush: o.blockPush ?? v(heavyish ? 3.2 : 2.2),
    hitstop: o.hitstop ?? (kind === 'strike' ? 6 : 10),
    sfx: o.sfx ?? (kind === 'strike' ? 'light' : 'heavy'),
    ...o,
  } as MoveDef;
}

const mo = (f: number, vxMps?: number, vy?: number, float?: boolean): Motion => ({
  f,
  vx: vxMps === undefined ? undefined : v(vxMps),
  vy,
  float,
});

function cineHits(from: number, every: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(from + i * every);
  return out;
}

// ------------------------------------------------------------------ Mu-jin
const MUJIN: CharDef = {
  id: 'mujin',
  name: 'Mu-jin',
  nameKo: '무진',
  title: 'The Wild Fist',
  hp: 1500,
  walkF: v(2.0),
  walkB: v(1.6),
  jumpV: 1420,
  jumpX: v(2.6),
  dashSpeed: v(7.2),
  dashFrames: 18,
  airDashSpeed: v(7.5),
  hurtW: m(0.27),
  height: m(1.78),
  weight: 1000,
  moves: {
    s1: mv('s1', 'strike', [5, 3, 10], 40, B(0.62, 1.40, 0.24, 0.16), { hitstun: 15, blockstun: 10, pushX: v(1.2) }),
    s2: mv('s2', 'strike', [6, 3, 12], 48, B(0.64, 1.40, 0.26, 0.17), { hitstun: 17, pushX: v(1.5), hitstop: 7 }),
    s3: mv('s3', 'strike', [8, 4, 16], 64, B(0.60, 1.15, 0.30, 0.32), { hitstun: 21, pushX: v(3.4), hitstop: 9, sfx: 'heavy' }),
    s_f: mv('s_f', 'strike', [10, 4, 18], 72, B(0.48, 1.35, 0.28, 0.22), {
      hitstun: 22, pushX: v(4.6), wallBounce: true, hitstop: 10, sfx: 'heavy', motion: [mo(3, 4.2), mo(12, 0)],
    }),
    s_u: mv('s_u', 'strike', [8, 4, 20], 58, B(0.45, 1.55, 0.26, 0.38), {
      hitstun: 42, launch: true, pushY: 1520, pushX: v(0.6), jumpCancel: true, hitstop: 8,
    }),
    s_d: mv('s_d', 'strike', [9, 4, 18], 58, B(0.58, 0.15, 0.40, 0.16), {
      hitstun: 30, knockdown: true, pushY: 520, pushX: v(1.0), hitstop: 8,
    }),
    s_air: mv('s_air', 'strike', [6, 5, 10], 48, B(0.36, 0.78, 0.26, 0.28), { air: true, hitstun: 17, pushY: 650, pushX: v(1.2) }),
    h: mv('h', 'heavy', [14, 5, 20], 108, B(0.72, 1.32, 0.36, 0.26), { hitstun: 26, pushX: v(5.2), wallBounce: true, hitstop: 11 }),
    h_f: mv('h_f', 'heavy', [16, 6, 18], 98, B(0.42, 1.38, 0.26, 0.32), {
      launch: true, pushY: 1150, hitstun: 40, hitstop: 10, motion: [mo(6, 5.0, 900), mo(22, 1.0)],
    }),
    h_d: mv('h_d', 'heavy', [13, 4, 22], 88, B(0.72, 0.40, 0.34, 0.20), { knockdown: true, pushY: 720, pushX: v(2.0), hitstun: 30 }),
    h_air: mv('h_air', 'heavy', [10, 6, 14], 88, B(0.72, 0.78, 0.34, 0.24), { air: true, pushX: v(4.6), pushY: 400, wallBounce: true, hitstun: 24 }),
    h_air_d: mv('h_air_d', 'heavy', [10, 40, 16], 90, B(0.45, 0.05, 0.30, 0.32), {
      air: true, landCancel: true, groundBounce: true, pushY: -600, hitstun: 34, fx: 'crater', motion: [mo(8, 4.6, -1700)],
    }),
    focus_release: mv('focus_release', 'focus', [6, 5, 24], 150, B(0.82, 1.30, 0.32, 0.26), {
      unblockable: true, pushX: v(7.4), wallBounce: true, hitstun: 30, hitstop: 16, sfx: 'focus', fx: 'impact', motion: [mo(0, 5.0), mo(8, 0)],
    }),
    art_n: mv('art_n', 'art', [14, 6, 24], 120, B(0.98, 1.25, 0.58, 0.42), {
      qiCost: 100, pushX: v(7.6), wallBounce: true, hitstun: 30, hitstop: 14, fx: 'speedlines',
    }),
    art_f: mv('art_f', 'art', [24, 4, 16], 110, B(0.48, 1.35, 0.30, 0.24), {
      qiCost: 100, invul: [4, 20], passThrough: [6, 20], pushX: v(4.2), wallBounce: true, hitstun: 26, hitstop: 12,
      motion: [mo(6, 9.5), mo(20, 0)],
    }),
    art_d: mv('art_d', 'art', [4, 10, 30], 118, B(0.40, 1.65, 0.30, 0.55), {
      qiCost: 100, invul: [1, 9], launch: true, pushY: 1750, pushX: v(1.0), hitstun: 52, hitstop: 10, fx: 'speedlines',
      motion: [mo(4, 1.4, 1650)],
    }),
    secret: mv('secret', 'secret', [10, 6, 40], 0, B(0.58, 1.20, 0.38, 0.55), {
      qiCost: 300, invul: [1, 10], sfx: 'secret', hitstop: 4, motion: [mo(0, 10.0), mo(16, 0)],
      cine: { length: 144, hitFrames: cineHits(14, 5, 16), finishFrame: 110, finishDamage: 170 },
    }),
  },
};
// per-flurry damage for secret arts lives in damage of cine hits
const CINE_HIT_DAMAGE: Record<string, number> = { mujin: 12, seolhwa: 11, hyeongong: 0 };

// ------------------------------------------------------------------ Seol-hwa
const SEOLHWA: CharDef = {
  id: 'seolhwa',
  name: 'Seol-hwa',
  nameKo: '설화',
  title: 'The Crimson Sleeve',
  hp: 1420,
  walkF: v(2.1),
  walkB: v(1.8),
  jumpV: 1500,
  jumpX: v(2.9),
  dashSpeed: v(8.0),
  dashFrames: 18,
  airDashSpeed: v(8.5),
  hurtW: m(0.25),
  height: m(1.68),
  weight: 1080,
  moves: {
    s1: mv('s1', 'strike', [7, 3, 12], 38, B(1.05, 1.35, 0.42, 0.16), { hitstun: 15, pushX: v(1.2) }),
    s2: mv('s2', 'strike', [8, 3, 14], 44, B(1.00, 1.25, 0.46, 0.26), { hitstun: 17, pushX: v(1.8), hitstop: 7 }),
    s3: mv('s3', 'strike', [10, 4, 18], 60, B(0.72, 1.42, 0.36, 0.30), { hitstun: 21, pushX: v(3.0), hitstop: 9, sfx: 'heavy' }),
    s_f: mv('s_f', 'strike', [12, 4, 20], 68, B(1.30, 1.25, 0.46, 0.18), {
      hitstun: 22, pushX: v(4.2), wallBounce: true, hitstop: 10, motion: [mo(4, 2.6), mo(12, 0)],
    }),
    s_u: mv('s_u', 'strike', [9, 4, 22], 54, B(0.80, 1.70, 0.46, 0.46), {
      hitstun: 42, launch: true, pushY: 1520, pushX: v(0.5), jumpCancel: true, hitstop: 8,
    }),
    s_d: mv('s_d', 'strike', [10, 4, 20], 54, B(1.10, 0.20, 0.52, 0.18), { hitstun: 30, knockdown: true, pushY: 520, pushX: v(1.0) }),
    s_air: mv('s_air', 'strike', [7, 5, 12], 44, B(0.86, 0.62, 0.42, 0.36), { air: true, hitstun: 17, pushY: 650, pushX: v(1.2) }),
    h: mv('h', 'heavy', [15, 5, 22], 98, B(0.76, 1.45, 0.36, 0.26), { hitstun: 26, pushX: v(5.0), wallBounce: true, hitstop: 11 }),
    h_f: mv('h_f', 'heavy', [14, 6, 20], 88, B(0.72, 1.00, 0.34, 0.26), {
      pushX: v(4.2), hitstun: 26, motion: [mo(4, 6.2, 650), mo(20, 1.0)],
    }),
    h_d: mv('h_d', 'heavy', [13, 5, 22], 84, B(0.82, 0.20, 0.46, 0.18), { knockdown: true, pushY: 820, pushX: v(1.6), hitstun: 30 }),
    h_air: mv('h_air', 'heavy', [10, 8, 14], 44, B(0, 0.95, 0.88, 0.52), {
      air: true, around: true, hits: 2, rehit: 4, pushY: 700, pushX: v(1.6), hitstun: 22,
    }),
    h_air_d: mv('h_air_d', 'heavy', [10, 40, 16], 84, B(0.32, 0.05, 0.32, 0.36), {
      air: true, landCancel: true, groundBounce: true, pushY: -600, hitstun: 34, fx: 'cracks', motion: [mo(8, 2.0, -1750)],
    }),
    focus_release: mv('focus_release', 'focus', [7, 5, 26], 140, B(1.30, 1.30, 0.46, 0.26), {
      unblockable: true, pushX: v(6.8), wallBounce: true, hitstun: 30, hitstop: 16, sfx: 'focus', fx: 'impact',
    }),
    art_n: mv('art_n', 'art', [13, 1, 26], 88, B(0, 0, 0, 0), {
      qiCost: 100, hitstun: 24, pushX: v(3.0), hitstop: 10,
      projectile: { speed: 1300, life: 46, box: B(0, 0, 0.38, 0.20), ox: m(0.8), oy: m(1.30), visual: 'silk' },
    }),
    art_f: mv('art_f', 'art', [12, 8, 20], 98, B(0.62, 0.90, 0.36, 0.32), {
      qiCost: 100, invul: [2, 9], pushX: v(4.6), wallBounce: true, hitstun: 26, hitstop: 12,
      motion: [mo(2, 7.2, 1000), mo(20, 1.0)],
    }),
    art_d: mv('art_d', 'art', [18, 6, 26], 108, B(0, 0.30, 1.45, 0.36), {
      qiCost: 100, around: true, otg: true, launch: true, pushY: 1450, pushX: v(1.4), hitstun: 46, hitstop: 14, fx: 'crater',
      motion: [mo(4, 0.6, 1050)],
    }),
    secret: mv('secret', 'secret', [10, 8, 40], 0, B(0.72, 1.20, 0.50, 0.60), {
      qiCost: 300, invul: [1, 10], sfx: 'secret', hitstop: 4, motion: [mo(0, 8.5), mo(18, 0)],
      cine: { length: 150, hitFrames: cineHits(16, 6, 16), finishFrame: 120, finishDamage: 160 },
    }),
  },
};

// ------------------------------------------------------------------ Hyeon-gong
const HYEONGONG: CharDef = {
  id: 'hyeongong',
  name: 'Hyeon-gong',
  nameKo: '현공',
  title: 'The Iron Monk',
  hp: 1720,
  walkF: v(1.4),
  walkB: v(1.2),
  jumpV: 1300,
  jumpX: v(2.1),
  dashSpeed: v(5.6),
  dashFrames: 20,
  airDashSpeed: v(6.0),
  hurtW: m(0.33),
  height: m(1.92),
  weight: 760,
  moves: {
    s1: mv('s1', 'strike', [7, 3, 13], 52, B(0.72, 1.45, 0.27, 0.18), { hitstun: 16, pushX: v(1.8), hitstop: 7 }),
    s2: mv('s2', 'strike', [9, 4, 15], 62, B(0.72, 1.40, 0.33, 0.26), { hitstun: 18, pushX: v(2.5), hitstop: 8 }),
    s3: mv('s3', 'strike', [12, 4, 20], 84, B(0.78, 1.30, 0.36, 0.32), { hitstun: 22, pushX: v(6.0), wallBounce: true, hitstop: 11, sfx: 'heavy' }),
    s_f: mv('s_f', 'strike', [14, 6, 20], 88, B(0.56, 1.30, 0.34, 0.36), {
      hitstun: 24, pushX: v(5.0), armor: [4, 18], hitstop: 11, sfx: 'heavy', motion: [mo(4, 5.0), mo(18, 0)],
    }),
    s_u: mv('s_u', 'strike', [11, 4, 24], 74, B(0.56, 1.66, 0.32, 0.42), {
      hitstun: 44, launch: true, pushY: 1500, pushX: v(0.6), jumpCancel: true, hitstop: 9,
    }),
    s_d: mv('s_d', 'strike', [11, 4, 20], 68, B(0.72, 0.40, 0.32, 0.26), { hitstun: 30, knockdown: true, pushY: 620, pushX: v(1.4) }),
    s_air: mv('s_air', 'strike', [8, 6, 12], 64, B(0.36, 0.42, 0.32, 0.42), { air: true, hitstun: 18, pushY: -300, pushX: v(1.0), hitstop: 8 }),
    h: mv('h', 'heavy', [18, 5, 24], 138, B(0.88, 1.40, 0.42, 0.36), {
      armor: [6, 18], hitstun: 28, pushX: v(7.2), wallBounce: true, hitstop: 14, fx: 'speedlines',
    }),
    h_f: mv('h_f', 'heavy', [18, 6, 22], 118, B(0.58, 1.55, 0.32, 0.32), {
      armor: [6, 20], hitstun: 28, pushX: v(5.2), hitstop: 12, motion: [mo(6, 6.0), mo(22, 0)],
    }),
    h_d: mv('h_d', 'heavy', [20, 5, 24], 98, B(0, 0.22, 1.32, 0.26), {
      around: true, otg: true, launch: true, pushY: 1150, pushX: v(1.2), hitstun: 42, hitstop: 13, fx: 'crater',
    }),
    h_air: mv('h_air', 'heavy', [12, 8, 16], 94, B(0.32, 0.72, 0.46, 0.46), { air: true, pushX: v(3.2), pushY: 300, hitstun: 24 }),
    h_air_d: mv('h_air_d', 'heavy', [12, 40, 20], 108, B(0, 0.05, 0.62, 0.42), {
      air: true, landCancel: true, around: true, groundBounce: true, pushY: -700, hitstun: 36, fx: 'crater',
      motion: [mo(10, 0.5, -1900)],
    }),
    focus_release: mv('focus_release', 'focus', [8, 6, 28], 168, B(0.88, 1.30, 0.42, 0.30), {
      unblockable: true, pushX: v(8.0), wallBounce: true, hitstun: 30, hitstop: 18, sfx: 'focus', fx: 'impact',
    }),
    art_n: mv('art_n', 'art', [4, 30, 20], 0, B(0, 0, 0, 0), { qiCost: 100, counter: [4, 34], counterMove: 'counter', hitstop: 0 }),
    counter: mv('counter', 'art', [6, 4, 20], 148, B(0.82, 1.30, 0.46, 0.36), {
      invul: [0, 10], pushX: v(8.0), wallBounce: true, hitstun: 30, hitstop: 16, fx: 'impact',
    }),
    art_f: mv('art_f', 'grab', [14, 4, 30], 0, B(0.66, 1.00, 0.32, 0.62), { qiCost: 100, throwMove: 'throw', hitstop: 6 }),
    throw: mv('throw', 'grab', [6, 0, 54], 178, B(0, 0, 0, 0), { slamFrame: 40, fx: 'crater', hitstop: 14, knockdown: true }),
    art_d: mv('art_d', 'art', [20, 6, 26], 128, B(0, 0.26, 1.62, 0.32), {
      qiCost: 100, around: true, otg: true, launch: true, pushY: 1350, pushX: v(1.4), hitstun: 46, hitstop: 15, fx: 'crater',
    }),
    secret: mv('secret', 'secret', [30, 10, 40], 0, B(2.3, 1.0, 2.1, 1.3), {
      qiCost: 300, invul: [1, 30], sfx: 'secret', hitstop: 4,
      cine: { length: 120, hitFrames: [], finishFrame: 90, finishDamage: 380 },
    }),
  },
};

export const CHARS: CharDef[] = [MUJIN, SEOLHWA, HYEONGONG];
export const CHAR_IDS = CHARS.map((c) => c.id);
export { CINE_HIT_DAMAGE };

/** Stable move index tables (for compact state + staleness arrays). */
export const MOVE_NAMES: string[][] = CHARS.map((c) => Object.keys(c.moves));
export const MAX_MOVES = Math.max(...MOVE_NAMES.map((n) => n.length));

/** neutral strike chain */
export const CHAIN_NEXT: Record<string, string> = { s1: 's2', s2: 's3', s3: 's1' };
