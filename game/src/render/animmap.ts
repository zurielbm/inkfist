import { ST } from '../sim/defs';
import { Fighter, Match, moveOf, charOf } from '../sim/sim';
import { CHARS } from '../sim/chars';

export interface ClipMeta {
  length: number;
  loop: boolean;
  events: Record<string, number>;
}

export interface Pose {
  clip: string;
  /** frame time within the clip (60 fps frames) */
  t: number;
  /** blend-in frames when switching to this clip */
  blend: number;
}

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

export function poseFor(f: Fighter, s: Match, clips: Record<string, ClipMeta>): Pose {
  const len = (n: string) => clips[n]?.length ?? 1;
  const c = charOf(f);
  switch (f.st) {
    case ST.INTRO:
      return { clip: 'intro', t: clamp(f.sf, 0, len('intro')), blend: 0 };
    case ST.WIN:
      return { clip: 'win', t: clamp(f.sf, 0, len('win')), blend: 8 };
    case ST.IDLE:
      return { clip: 'idle', t: (s.frame + f.side * 23) % len('idle'), blend: 6 };
    case ST.WALK_F:
      return { clip: 'walk_f', t: f.sf % len('walk_f'), blend: 5 };
    case ST.WALK_B:
      return { clip: 'walk_b', t: f.sf % len('walk_b'), blend: 5 };
    case ST.JUMPSQUAT:
      return { clip: 'jump', t: 0, blend: 3 };
    case ST.AIR:
      if (f.vy > 0) return { clip: 'jump', t: clamp(f.sf + 3, 0, len('jump')), blend: 4 };
      return { clip: 'fall', t: clamp(Math.floor(-f.vy / 110), 0, len('fall')), blend: 6 };
    case ST.JUMP2:
      return { clip: 'jump2', t: clamp(f.sf, 0, len('jump2')), blend: 2 };
    case ST.LAND:
      if (f.landLag > 0) return { clip: 'land', t: clamp(Math.min(f.sf, 3), 0, len('land')), blend: 2 };
      return { clip: 'land', t: clamp(f.sf, 0, len('land')), blend: 2 };
    case ST.DASH_F:
      return { clip: 'dash_f', t: clamp((f.sf * len('dash_f')) / c.dashFrames, 0, len('dash_f')), blend: 2 };
    case ST.DASH_B:
      return { clip: 'dash_b', t: clamp((f.sf * len('dash_b')) / c.dashFrames, 0, len('dash_b')), blend: 2 };
    case ST.AIRDASH:
      return { clip: 'airdash', t: clamp(f.sf, 0, len('airdash')), blend: 2 };
    case ST.GUARD:
      return { clip: 'guard', t: clamp(f.sf, 0, len('guard')), blend: 2 };
    case ST.GUARD_STUN:
      return { clip: 'guard_hit', t: clamp(f.sf, 0, len('guard_hit')), blend: 1 };
    case ST.DEFLECT:
    case ST.DEFLECT_WHIFF:
      return { clip: 'deflect', t: clamp(f.sf, 0, len('deflect')), blend: 1 };
    case ST.ATTACK: {
      const md = moveOf(f);
      if (!md) return { clip: 'idle', t: 0, blend: 4 };
      const name = md.anim;
      const cm = clips[name];
      if (!cm) return { clip: 'idle', t: 0, blend: 4 };
      if (md.cine || md.slamFrame !== undefined || md.counter) {
        return { clip: name, t: clamp(f.sf, 0, cm.length), blend: 2 };
      }
      const H = cm.events.hit ?? Math.floor(cm.length / 3);
      const L = cm.length;
      const S = Math.max(1, md.startup);
      if (f.sf <= S) return { clip: name, t: (f.sf / S) * H, blend: 2 };
      if (md.landCancel) return { clip: name, t: clamp(H + (f.sf - S), H, L), blend: 2 };
      const rest = Math.max(1, md.active + md.recovery);
      return { clip: name, t: clamp(H + ((f.sf - S) / rest) * (L - H), 0, L), blend: 2 };
    }
    case ST.FOCUS_CHARGE: {
      const L = len('focus_charge');
      const t = f.sf < 10 ? f.sf : 10 + ((f.sf - 10) % Math.max(1, L - 10));
      return { clip: 'focus_charge', t, blend: 3 };
    }
    case ST.HITSTUN: {
      const total = f.sf + f.stun;
      const name = total > 20 ? 'hit_h' : 'hit_s';
      return { clip: name, t: clamp((f.sf / Math.max(1, total)) * len(name), 0, len(name)), blend: 1 };
    }
    case ST.AIR_HIT:
      if (f.vy > 0) return { clip: 'launch', t: clamp(f.sf, 0, len('launch')), blend: 2 };
      return { clip: 'hit_air', t: clamp(f.sf % (len('hit_air') * 2), 0, len('hit_air')), blend: 5 };
    case ST.KNOCKDOWN:
      return { clip: 'knockdown', t: clamp(f.sf, 0, len('knockdown')), blend: 3 };
    case ST.DOWN: {
      const kd = len('knockdown');
      if (f.sf < kd) return { clip: 'knockdown', t: f.sf, blend: 3 };
      return { clip: 'down', t: clamp(f.sf - kd, 0, len('down')), blend: 4 };
    }
    case ST.GETUP:
      return { clip: 'getup', t: clamp(f.sf, 0, len('getup')), blend: 2 };
    case ST.WALL:
      return { clip: 'wall', t: clamp(f.sf, 0, len('wall')), blend: 1 };
    case ST.STAGGER:
      return { clip: 'stagger', t: clamp(f.sf, 0, len('stagger')), blend: 1 };
    case ST.CRUMPLE:
      return { clip: 'crumple', t: clamp(f.sf, 0, len('crumple')), blend: 1 };
    case ST.BURST:
      return { clip: 'burst', t: clamp(f.sf, 0, len('burst')), blend: 1 };
    case ST.THROWN:
      return { clip: 'hit_air', t: 4, blend: 3 };
    case ST.CINE_VICTIM:
      return { clip: 'hit_s', t: 2 + (f.sf % 5), blend: 1 };
    case ST.KO:
      return { clip: 'down', t: 0, blend: 4 };
  }
  return { clip: 'idle', t: 0, blend: 4 };
}

export function charIdOf(f: Fighter): string {
  return CHARS[f.ch].id;
}
