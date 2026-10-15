"""Generic clip generators built from a character's stance + style params.

Every character must provide the same clip names (the game maps sim states to them):
  idle walk_f walk_b jump fall land jump2 dash_f dash_b airdash
  guard guard_hit deflect hit_s hit_h hit_air launch knockdown down getup wall stagger crumple burst
  focus_charge intro win
  + attacks: s1 s2 s3 s_f s_u s_d s_air h h_f h_d h_air h_air_d focus_release art_n art_f art_d secret
Attack clips carry events: {'hit': first active frame}.
"""
import math

from ..pose import P, _lerp


def add(a, b):
    return tuple(x + y for x, y in zip(a, b))


def scale_pose_offset(base, target, k):
    return _lerp(base, target, k)


def keys_from_fn(fn, length, step=2):
    """Sample a pose function fn(frame)->pose into keys."""
    ks = []
    for f in range(0, length + 1, step):
        ks.append((f, fn(f), 'lin'))
    if ks[-1][0] != length:
        ks.append((length, fn(length), 'lin'))
    return ks


def clip(keys, length=None, loop=False, events=None):
    length = length if length is not None else keys[-1][0]
    return {'keys': keys, 'length': length, 'loop': loop, 'events': events or {}}


# ---------------------------------------------------------------- helpers to nudge poses

def nudge(pose, hips_loc=(0, 0, 0), hips_rot=(0, 0, 0), spine=(0, 0, 0), chest=(0, 0, 0), neck=(0, 0, 0),
          head=(0, 0, 0), hand_L=None, hand_R=None, foot_L=None, foot_R=None, all_hands=(0, 0, 0)):
    """Add offsets to a pose (positions in metres, angles in degrees)."""
    p = P(pose)
    h = dict(p['hips'])
    h['loc'] = add(h.get('loc', (0, 0, 0)), hips_loc)
    h['rot'] = add(h.get('rot', (0, 0, 0)), hips_rot)
    p['hips'] = h
    for k, v in (('spine', spine), ('chest', chest), ('neck', neck), ('head', head)):
        p[k] = add(p.get(k, (0, 0, 0)), v)
    for k, v in (('hand_L', hand_L), ('hand_R', hand_R)):
        d = dict(p[k])
        d['pos'] = add(d['pos'], all_hands)
        if v is not None:
            d['pos'] = add(d['pos'], v)
        p[k] = d
    for k, v in (('foot_L', foot_L), ('foot_R', foot_R)):
        if v is not None:
            d = dict(p[k])
            d['pos'] = add(d['pos'], v)
            p[k] = d
    return p


def with_body_drop(pose, dz):
    """Lower the whole body (hips + hands) keeping feet planted."""
    return nudge(pose, hips_loc=(0, 0, dz), all_hands=(0, 0, dz))


# ---------------------------------------------------------------- locomotion

def idle(S, length=72, breath=0.012, sway=1.5):
    def fn(f):
        ph = 2 * math.pi * f / length
        b = math.sin(ph)
        return nudge(S, hips_loc=(0, 0, -breath * (0.5 + 0.5 * b)), chest=(sway * 0.4 * b, 0, sway * math.sin(ph + 1)),
                     head=(-sway * 0.5 * b, 0, 0), all_hands=(0, 0.004 * b, -breath * (0.5 + 0.5 * b) + 0.006 * b))
    return clip(keys_from_fn(fn, length), length, loop=True)


def walk(S, speed, length, forward=True, lift=0.09, bob=0.02):
    """In-place stance shuffle. speed m/s; planted feet slide back at exactly speed/60 m per frame."""
    v = speed / 60.0 * (1 if forward else -1)
    lead, rear = ('foot_L', 'foot_R')
    # Each foot: planted for 60% of the cycle, swing 40%. Lead swings first (forward walk) or rear first (back walk).
    swing = 0.4
    travel = v * length * (1 - swing)  # distance a planted foot slides back (at exactly the walk speed)
    starts = {lead: 0.0, rear: 0.5} if forward else {rear: 0.0, lead: 0.5}

    def foot_offset(phase):
        # returns (fwd offset, lift) relative to stance position; centred so the mean offset is 0
        A = travel / 2
        if phase < swing:
            t = phase / swing
            e = t * t * (3 - 2 * t)
            return -A + 2 * A * e, lift * math.sin(math.pi * t)
        t = (phase - swing) / (1 - swing)
        return A - 2 * A * t, 0.0

    def fn(f):
        p = P(S)
        for ft, st in starts.items():
            ph = ((f / length) - st) % 1.0
            off, up = foot_offset(ph)
            d = dict(p[ft])
            pos = d['pos']
            d['pos'] = (pos[0], pos[1] + off, pos[2] + up)
            d['pitch'] = -12 * math.sin(math.pi * min(1, ph / swing)) if ph < swing else 0
            p[ft] = d
        ph2 = 2 * math.pi * f / length
        b = -abs(math.sin(ph2)) * bob
        p = nudge(p, hips_loc=(0, 0, b), chest=(2 if forward else -2, 0, 3 * math.sin(ph2)),
                  all_hands=(0, 0, b * 0.8))
        return p
    return clip(keys_from_fn(fn, length), length, loop=True)


# ---------------------------------------------------------------- air

def tuck(S, k=1.0):
    return nudge(S, hips_loc=(0, 0, 0.05 * k), hips_rot=(-6 * k, 0, 8 * k), chest=(8 * k, 0, 0),
                 foot_L=(0.0, 0.08 * k, 0.42 * k), foot_R=(0.0, 0.18 * k, 0.30 * k), all_hands=(0, 0.02, 0.04 * k))


def spin_pose(pose, ang, lift=0.0):
    """Forward somersault by ang degrees about the hips' side axis, raised by lift: hand/foot targets keep their
    unrotated positions plus a 'spin' the solver applies after remapping heights, so the tuck stays rigid on every
    skeleton; poles rotate here."""
    a = math.radians(ang)
    ca, sa = math.cos(a), math.sin(a)
    p = nudge(pose, hips_rot=(ang, 0, 0), hips_loc=(0, 0, lift), all_hands=(0, 0, lift), foot_L=(0, 0, lift),
              foot_R=(0, 0, lift))
    for k in ('hand_L', 'hand_R', 'foot_L', 'foot_R'):
        d = dict(p[k])
        d['spin'] = ang
        po = d.get('pole', (0, -1, -0.6) if k.startswith('hand') else (0, 1, 0))
        d['pole'] = (po[0], po[1] * ca + po[2] * sa, -po[1] * sa + po[2] * ca)
        p[k] = d
    return p


def jump_clips(S):
    crouch = with_body_drop(S, -0.10)
    up = tuck(S, 1.0)
    fall = nudge(S, hips_loc=(0, 0, 0.04), hips_rot=(4, 0, 4), foot_L=(0, 0.06, 0.16), foot_R=(0, 0.02, 0.10),
                 all_hands=(0, 0.02, 0.10))
    land = with_body_drop(S, -0.13)
    out = {
        'jump': clip([(0, crouch, 'lin'), (4, nudge(S, foot_L=(0, 0, 0.05), foot_R=(0, -0.05, 0.12)), 'out'),
                      (14, up, 'out')], 14),
        'fall': clip([(0, up, 'lin'), (16, fall, 'inout')], 16),
        'land': clip([(0, fall, 'lin'), (3, land, 'out'), (10, S, 'inout')], 10),
    }
    # double jump: forward somersault with tuck
    base = tuck(S, 1.2)
    spin = [(f, spin_pose(base, 360 * min(1.0, f / 22) ** 0.8), 'lin') for f in range(0, 25, 2)]
    out['jump2'] = clip(spin, 24)
    return out


def dash_clips(S):
    lean_f = nudge(S, hips_loc=(0, 0.05, -0.10), hips_rot=(14, 0, 0), chest=(10, 0, 0), head=(-14, 0, 0),
                   foot_L=(0, 0.20, 0.0), foot_R=(0, -0.25, 0.10), hand_L=(0.02, 0.0, -0.10), hand_R=(-0.10, -0.25, -0.08))
    lean_b = nudge(S, hips_loc=(0, -0.08, -0.06), hips_rot=(-10, 0, 0), chest=(-6, 0, 0), head=(10, 0, 0),
                   foot_L=(0, -0.10, 0.12), foot_R=(0, -0.20, 0.0), all_hands=(0, -0.05, 0.03))
    air = nudge(S, hips_rot=(30, 0, 0), chest=(12, 0, 0), head=(-30, 0, 0), foot_L=(0, -0.2, 0.35),
                foot_R=(0, -0.35, 0.45), hand_L=(0.05, -0.2, -0.2), hand_R=(-0.05, -0.35, -0.15))
    return {
        'dash_f': clip([(0, S, 'lin'), (3, lean_f, 'out'), (12, lean_f, 'lin'), (18, S, 'inout')], 18),
        'dash_b': clip([(0, S, 'lin'), (3, lean_b, 'out'), (12, lean_b, 'lin'), (18, S, 'inout')], 18),
        'airdash': clip([(0, tuck(S, 0.5), 'lin'), (3, air, 'out'), (14, air, 'lin')], 14),
    }


# ---------------------------------------------------------------- defence & reactions

def guard_pose(S):
    return nudge(P(S, hand_L={'pos': (0.06, 0.24, 1.42), 'pole': (0.8, 0.0, -1.0)},
                   hand_R={'pos': (-0.06, 0.22, 1.32), 'pole': (-0.8, 0.0, -1.0)}),
                 hips_loc=(0, -0.03, -0.03), chest=(8, 0, 6), head=(6, 0, 0))


def defence_clips(S):
    G = guard_pose(S)
    Gh = nudge(G, hips_loc=(0, -0.06, -0.02), chest=(-6, 0, 0), head=(-6, 0, 0), all_hands=(0, -0.05, 0.01))
    deflect_a = P(nudge(S, hips_rot=(0, 0, -14), chest=(4, 0, -20)),
                  hand_L={'pos': (0.20, 0.42, 1.40), 'pole': (1.0, 0.0, -0.5), 'dir': (0.6, 0.6, 0.6)},
                  hand_R={'pos': (-0.08, 0.20, 1.20), 'pole': (-0.8, 0.0, -1.0)})
    deflect_b = P(nudge(S, hips_rot=(0, 0, 12), chest=(2, 0, 18)),
                  hand_L={'pos': (-0.12, 0.40, 1.30), 'pole': (1.0, 0.0, -0.3), 'dir': (-0.6, 0.6, 0.3)},
                  hand_R={'pos': (-0.10, 0.10, 1.18), 'pole': (-0.8, 0.0, -1.0)})
    return {
        'guard': clip([(0, S, 'lin'), (4, G, 'out')], 4),
        'guard_hit': clip([(0, G, 'lin'), (2, Gh, 'snap'), (10, G, 'inout')], 10),
        'deflect': clip([(0, S, 'lin'), (3, deflect_a, 'snap'), (7, deflect_b, 'out'), (16, S, 'inout')], 16,
                        events={'hit': 3}),
    }


def reaction_clips(S):
    hit_s1 = nudge(S, hips_loc=(0, -0.06, -0.02), hips_rot=(-6, 0, 0), chest=(-14, 0, 6), neck=(-10, 0, 0), head=(-16, 0, 10),
                   hand_L=(0.06, -0.10, 0.04), hand_R=(-0.10, -0.14, -0.02))
    hit_h1 = nudge(S, hips_loc=(0, -0.12, -0.05), hips_rot=(-12, 0, 8), chest=(-22, 0, 14), neck=(-12, 0, 0),
                   head=(-22, 6, 14), hand_L=(0.16, -0.24, 0.12), hand_R=(-0.20, -0.30, 0.06),
                   foot_L=(0, -0.05, 0.03))
    air = P(nudge(S, hips_loc=(0, -0.05, 0.05), hips_rot=(-35, 0, 0), chest=(-20, 0, 0), head=(-20, 0, 0)),
            hand_L={'pos': (0.30, -0.30, 1.40), 'pole': (1, 0, 0)}, hand_R={'pos': (-0.30, -0.35, 1.45), 'pole': (-1, 0, 0)},
            foot_L={'pos': (0.08, 0.35, 0.35), 'pole': (0, 1, 1)}, foot_R={'pos': (-0.10, 0.20, 0.20), 'pole': (0, 1, 1)})
    lying = P(S, hips={'loc': (0.0, -0.45, -0.84), 'rot': (-86, 0, 0)}, spine=(0, 0, 0), chest=(4, 0, 0), neck=(10, 0, 0),
              head=(14, 0, 18),
              hand_L={'pos': (0.32, -0.75, 0.08), 'pole': (1, 0, 0.5)}, hand_R={'pos': (-0.32, -0.80, 0.06), 'pole': (-1, 0, 0.5)},
              foot_L={'pos': (0.14, 0.38, 0.08), 'pole': (0, 0, 1), 'pitch': 50},
              foot_R={'pos': (-0.14, 0.30, 0.12), 'pole': (0, 0, 1), 'pitch': 45})
    falling = P(S, hips={'loc': (0.0, -0.30, -0.45), 'rot': (-55, 0, 0)}, chest=(-10, 0, 0), head=(-10, 0, 0),
                hand_L={'pos': (0.35, -0.55, 0.70), 'pole': (1, 0, 0)}, hand_R={'pos': (-0.35, -0.60, 0.65), 'pole': (-1, 0, 0)},
                foot_L={'pos': (0.10, 0.40, 0.25), 'pole': (0, 1, 1)}, foot_R={'pos': (-0.12, 0.25, 0.10), 'pole': (0, 1, 1)})
    knees_up = P(lying, hips={'loc': (0.0, -0.40, -0.80), 'rot': (-100, 0, 0)},
                 foot_L={'pos': (0.12, -0.05, 0.70), 'pole': (0, -1, 1), 'pitch': 0},
                 foot_R={'pos': (-0.12, -0.10, 0.65), 'pole': (0, -1, 1), 'pitch': 0},
                 hand_L={'pos': (0.20, -0.70, 0.15), 'pole': (1, 0, 0.5)}, hand_R={'pos': (-0.20, -0.72, 0.15), 'pole': (-1, 0, 0.5)})
    crouch_up = nudge(with_body_drop(S, -0.30), hips_rot=(20, 0, 0), chest=(10, 0, 0), head=(-20, 0, 0))
    wall = nudge(S, hips_loc=(0, -0.10, 0.05), hips_rot=(-10, 0, 0), chest=(-18, 0, 0), head=(-25, 0, 0),
                 hand_L=(0.25, -0.25, 0.25), hand_R=(-0.25, -0.30, 0.25), foot_L=(0, 0.1, 0.15))
    stag1 = nudge(S, hips_loc=(0, -0.10, 0.0), hips_rot=(-14, 0, -10), chest=(-18, 0, -16), head=(-18, 0, 0),
                  hand_L=(0.30, -0.10, 0.20), hand_R=(-0.30, -0.25, 0.20), foot_L=(0, -0.10, 0.0))
    stag2 = nudge(stag1, hips_loc=(0, -0.02, -0.06), chest=(6, 0, 4), head=(10, 0, 0), all_hands=(0, 0.05, -0.15))
    crumple1 = nudge(S, hips_loc=(0, -0.08, -0.12), hips_rot=(20, 0, 0), chest=(30, 0, 0), head=(20, 0, 0),
                     hand_L=(0.05, -0.15, -0.35), hand_R=(-0.05, -0.20, -0.40))
    crumple2 = nudge(crumple1, hips_loc=(0, 0, -0.20), chest=(10, 0, 0), all_hands=(0, 0, -0.15))
    burst = P(nudge(S, hips_loc=(0, 0, 0.02), chest=(-12, 0, 0), head=(-14, 0, 0)),
              hand_L={'pos': (0.55, 0.05, 1.45), 'pole': (0, 0, -1), 'dir': (1, 0, 0.4)},
              hand_R={'pos': (-0.55, 0.05, 1.45), 'pole': (0, 0, -1), 'dir': (-1, 0, 0.4)},
              foot_L={'pos': (0.20, 0.20, 0.085), 'yaw': 20}, foot_R={'pos': (-0.20, -0.20, 0.085), 'yaw': -30})
    return {
        'hit_s': clip([(0, S, 'lin'), (2, hit_s1, 'snap'), (18, S, 'inout')], 18),
        'hit_h': clip([(0, S, 'lin'), (2, hit_h1, 'snap'), (10, hit_h1, 'lin'), (24, S, 'inout')], 24),
        'hit_air': clip([(0, air, 'lin'), (12, nudge(air, hips_rot=(-15, 0, 0)), 'inout')], 12),
        'launch': clip([(0, hit_h1, 'lin'), (6, air, 'out'), (14, nudge(air, hips_rot=(-40, 0, 0)), 'inout')], 14),
        'knockdown': clip([(0, air, 'lin'), (8, falling, 'in'), (14, lying, 'in'), (17, nudge(lying, hips_loc=(0, 0, 0.04)), 'out'),
                           (22, lying, 'in')], 22),
        'down': clip([(0, lying, 'lin'), (40, nudge(lying, chest=(2, 0, 0)), 'inout')], 40, loop=False),
        'getup': clip([(0, lying, 'lin'), (8, knees_up, 'out'), (14, crouch_up, 'snap'), (24, S, 'inout')], 24),
        'wall': clip([(0, S, 'lin'), (3, wall, 'snap'), (20, wall, 'lin')], 20),
        'stagger': clip([(0, S, 'lin'), (3, stag1, 'snap'), (16, stag2, 'inout'), (30, stag2, 'lin')], 30),
        'crumple': clip([(0, S, 'lin'), (4, crumple1, 'snap'), (20, crumple2, 'inout'), (40, crumple2, 'lin')], 40),
        'burst': clip([(0, crumple1, 'lin'), (4, burst, 'snap'), (20, burst, 'lin')], 20, events={'hit': 4}),
    }


def focus_charge(S, charge_pose):
    def fn(f):
        tremble = 0.006 * math.sin(f * 2.1)
        return nudge(charge_pose, hips_loc=(tremble, 0, tremble * 0.5), all_hands=(tremble, 0, tremble))
    return clip([(0, S, 'lin'), (8, charge_pose, 'out')] + [(f, fn(f), 'lin') for f in range(10, 41, 2)], 40)


def base_clips(S, speeds, charge_pose):
    out = {}
    out['idle'] = idle(S)
    out['walk_f'] = walk(S, speeds[0], 26, forward=True)
    out['walk_b'] = walk(S, speeds[1], 30, forward=False)
    out.update(jump_clips(S))
    out.update(dash_clips(S))
    out.update(defence_clips(S))
    out.update(reaction_clips(S))
    out['focus_charge'] = focus_charge(S, charge_pose)
    return out
