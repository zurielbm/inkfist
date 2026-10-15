"""Mu-jin poses & clips. Character space: (side, fwd, up); side>0 = char-left. Camera sees the char's RIGHT side.
Fighting style: hard-style brawler (fists, elbows, knees, whirling kicks)."""
from ..pose import P
from .common import base_clips, clip, nudge, with_body_drop, tuck

# hand shapes per clip (pose keys may still set grip_L / grip_R explicitly)
GRIP_DEFAULT = ('fist', 'fist')
GRIP_CLIPS = {
    'art_n': ('palm', 'palm'), 'focus_charge': ('half', 'fist'), 'intro': ('half', 'half'),
    'hit_s': ('half', 'half'), 'hit_h': ('relaxed', 'relaxed'), 'hit_air': ('relaxed', 'relaxed'),
    'launch': ('relaxed', 'relaxed'), 'knockdown': ('relaxed', 'relaxed'), 'down': ('relaxed', 'relaxed'),
    'getup': ('half', 'half'), 'wall': ('relaxed', 'relaxed'), 'stagger': ('relaxed', 'relaxed'),
    'crumple': ('relaxed', 'relaxed'), 'burst': ('open', 'open'), 'jump2': ('half', 'half'),
}

STANCE = {
    'hips': {'loc': (0.0, -0.02, -0.075), 'rot': (6, 0, -32)},
    'spine': (4, 0, -6),
    'chest': (6, 2, -10),
    'neck': (-4, 0, 18),
    'head': (-6, 0, 22),
    'shoulder_L': (4, 6),
    'shoulder_R': (2, 4),
    'hand_L': {'pos': (0.02, 0.34, 1.36), 'pole': (0.7, -0.2, -1.0)},
    'hand_R': {'pos': (-0.10, 0.16, 1.24), 'pole': (-0.6, -0.4, -1.0)},
    'foot_L': {'pos': (0.07, 0.25, 0.085), 'yaw': 8},
    'foot_R': {'pos': (-0.12, -0.27, 0.085), 'yaw': -38, 'pole': (-0.5, 1.0, 0.0)},
}
S = STANCE


def body(hips_loc=None, hips_rot=None, spine=None, chest=None, neck=None, head=None, base=S, **limbs):
    """Pose override helper (absolute values replace the base's)."""
    kw = {}
    if hips_loc is not None or hips_rot is not None:
        kw['hips'] = {'loc': hips_loc if hips_loc is not None else base['hips']['loc'],
                      'rot': hips_rot if hips_rot is not None else base['hips']['rot']}
    for k, v in (('spine', spine), ('chest', chest), ('neck', neck), ('head', head)):
        if v is not None:
            kw[k] = v
    for k, v in limbs.items():
        kw[k] = v
    return P(base, **kw)


def hL(pos, pole=(0.7, -0.2, -1.0), **kw):
    return dict(pos=pos, pole=pole, **kw)


def hR(pos, pole=(-0.7, -0.2, -1.0), **kw):
    return dict(pos=pos, pole=pole, **kw)


def fL(pos, yaw=8, pole=(0.2, 1.0, 0.0), **kw):
    return dict(pos=pos, yaw=yaw, pole=pole, **kw)


def fR(pos, yaw=-38, pole=(-0.5, 1.0, 0.0), **kw):
    return dict(pos=pos, yaw=yaw, pole=pole, **kw)


# ---------------------------------------------------------------- strikes (J)
JAB_PULL = body(hips_rot=(6, 0, -30), chest=(6, 2, -6), hand_L=hL((0.05, 0.26, 1.34)))
JAB = body(hips_loc=(0, 0.05, -0.085), hips_rot=(8, 0, -40), chest=(6, 0, -18), neck=(-4, 0, 26), head=(-6, 0, 30),
           hand_L=hL((0.03, 0.70, 1.40), pole=(0.9, 0.2, -0.4)), foot_L=fL((0.07, 0.31, 0.085)))
CROSS_PULL = body(hips_rot=(6, 0, -36), chest=(6, 2, -14), hand_R=hR((-0.12, 0.10, 1.28)))
CROSS = body(hips_loc=(0, 0.07, -0.09), hips_rot=(10, 0, 4), spine=(4, 0, 8), chest=(8, -4, 18), neck=(-6, 0, -12),
             head=(-6, 0, -14), hand_R=hR((-0.04, 0.70, 1.40), pole=(-1.0, 0.0, -0.3)),
             hand_L=hL((0.12, 0.10, 1.30)), foot_R=fR((-0.12, -0.23, 0.085), yaw=-10))
HAMMER_UP = body(hips_loc=(0, 0.02, -0.06), hips_rot=(-4, 0, -20), chest=(-10, 6, -10), neck=(0, 0, 10), head=(-4, 0, 14),
                 hand_R=hR((-0.12, 0.02, 1.78), pole=(-1, 0.3, 0.2)), hand_L=hL((0.10, 0.30, 1.30)))
HAMMER = body(hips_loc=(0, 0.10, -0.16), hips_rot=(22, 0, 0), spine=(10, 0, 4), chest=(16, -6, 14), neck=(-14, 0, -8),
              head=(-14, 0, -10), hand_R=hR((-0.04, 0.62, 1.02), pole=(-1, 0.2, 0.3)), hand_L=hL((0.14, 0.05, 1.20)),
              foot_L=fL((0.07, 0.36, 0.085)))
ELBOW_WIND = body(hips_loc=(0, -0.02, -0.12), hips_rot=(8, 0, -45), chest=(10, 0, -20), hand_R=hR((-0.20, -0.05, 1.22)))
ELBOW = body(hips_loc=(0, 0.16, -0.16), hips_rot=(14, 0, 18), spine=(6, 0, 10), chest=(10, -6, 26), neck=(-10, 0, -20),
             head=(-10, 0, -22), hand_R=hR((-0.02, 0.18, 1.44), pole=(-0.4, 1.0, 0.0)),
             hand_L=hL((0.16, 0.16, 1.24)), foot_L=fL((0.07, 0.45, 0.085)), foot_R=fR((-0.12, -0.15, 0.085), yaw=-10))
UPPER_LOW = body(hips_loc=(0, 0.04, -0.22), hips_rot=(18, 0, -20), chest=(14, 0, -10), head=(-14, 0, 16),
                 hand_R=hR((-0.10, 0.25, 0.90), pole=(-1, -0.2, -0.2), dir=(0, 0.3, 1)))
UPPER = body(hips_loc=(0, 0.10, 0.02), hips_rot=(-6, 0, 8), spine=(-6, 0, 6), chest=(-10, -4, 16), neck=(-12, 0, -10),
             head=(-18, 0, -12), hand_R=hR((-0.04, 0.42, 1.80), pole=(-1, -0.4, 0), dir=(0, 0.2, 1)),
             hand_L=hL((0.15, 0.10, 1.25)), foot_R=fR((-0.10, -0.18, 0.12), yaw=-20))
SWEEP_LOW = body(hips_loc=(0, -0.05, -0.42), hips_rot=(28, 0, -40), spine=(10, 0, 0), chest=(14, 0, 0), head=(-30, 0, 30),
                 hand_L=hL((0.28, 0.22, 0.30), pole=(1, 0, 0)), hand_R=hR((-0.22, 0.05, 0.75)),
                 foot_L=fL((0.10, 0.10, 0.085), yaw=30, pole=(0.8, 1, 0)),
                 foot_R=fR((-0.20, -0.45, 0.07), yaw=-60))
SWEEP = body(base=SWEEP_LOW, hips_rot=(30, 0, -10), foot_R=fR((-0.20, 0.70, 0.10), yaw=40, pole=(-1, 0.2, 1), pitch=20),
             hand_R=hR((-0.32, -0.20, 0.55)))
AIR_KNEE_PREP = nudge(tuck(S, 1.0), hips_rot=(-10, 0, 0))
AIR_KNEE = body(base=tuck(S, 1.0), hips_loc=(0, 0.05, 0.05), hips_rot=(-10, 0, -10), chest=(10, 0, 0),
                foot_R=fR((-0.10, 0.25, 0.75), pole=(0, 1, 0.3), pitch=50), foot_L=fL((0.10, -0.15, 0.35)),
                hand_L=hL((0.10, 0.40, 1.40)), hand_R=hR((-0.10, 0.40, 1.38)))

# ---------------------------------------------------------------- heavies (K)
RH_WIND = body(hips_loc=(0, -0.02, -0.06), hips_rot=(0, 0, -50), chest=(4, 4, -20), head=(-6, 0, 40),
               foot_R=fR((-0.14, -0.30, 0.16), yaw=-60), hand_L=hL((0.20, 0.25, 1.30)), hand_R=hR((-0.20, -0.10, 1.20)))
ROUNDHOUSE = body(hips_loc=(0, 0.02, -0.02), hips_rot=(-14, 18, -80), spine=(6, -6, 10), chest=(18, -10, 20),
                  neck=(-10, 0, 30), head=(-12, 0, 30),
                  foot_L=fL((0.0, -0.02, 0.085), yaw=-70, pole=(0.5, 1, 0)),
                  foot_R=fR((-0.06, 0.80, 1.38), yaw=-90, pole=(-0.3, 0.1, 1.0), pitch=40),
                  hand_L=hL((0.30, 0.15, 1.10)), hand_R=hR((-0.35, -0.25, 1.05)))
RH_FOLLOW = body(base=ROUNDHOUSE, hips_rot=(-8, 10, -120),
                 foot_R=fR((0.20, 0.55, 0.95), yaw=-140, pole=(0.3, 0.2, 1.0), pitch=40))
FKNEE_WIND = with_body_drop(body(hips_rot=(10, 0, -20), chest=(14, 0, -6)), -0.10)
FKNEE = body(hips_loc=(0, 0.20, 0.25), hips_rot=(-12, 0, -10), chest=(14, 0, 0), neck=(-10, 0, 10), head=(-14, 0, 10),
             foot_R=fR((-0.10, 0.35, 1.05), pole=(0, 1, 0.5), pitch=55), foot_L=fL((0.10, -0.25, 0.55), pole=(0, 1, 0)),
             hand_L=hL((0.12, 0.45, 1.65), pole=(1, 0, 0)), hand_R=hR((-0.10, 0.50, 1.62), pole=(-1, 0, 0)))
LOWKICK_WIND = body(hips_loc=(0, -0.04, -0.06), hips_rot=(-4, 0, -60), foot_R=fR((-0.12, -0.20, 0.30), yaw=-70),
                    hand_L=hL((0.15, 0.30, 1.30)))
LOWKICK = body(hips_loc=(0, 0.04, -0.06), hips_rot=(-20, 20, -85), chest=(22, -12, 10), neck=(-6, 0, 40), head=(-6, 0, 40),
               foot_R=fR((-0.06, 0.82, 0.40), yaw=-90, pole=(-0.2, 0, 1.0), pitch=10),
               foot_L=fL((0.0, 0.0, 0.085), yaw=-60), hand_L=hL((0.25, 0.25, 1.15)), hand_R=hR((-0.30, -0.20, 1.10)))
AIRSIDE_WIND = body(base=tuck(S, 1.0), hips_rot=(-6, 0, -60), foot_R=fR((-0.10, 0.0, 0.55), yaw=-80))
AIRSIDE = body(base=tuck(S, 1.0), hips_loc=(0, 0.02, 0.05), hips_rot=(-20, 22, -80), chest=(20, -10, 10), head=(-10, 0, 40),
               foot_R=fR((-0.06, 0.80, 0.85), yaw=-90, pole=(-0.2, 0, 1.0), pitch=10),
               foot_L=fL((0.10, -0.10, 0.40), yaw=-60), hand_L=hL((0.25, 0.20, 1.20)), hand_R=hR((-0.25, -0.25, 1.10)))
DIVE_WIND = body(base=tuck(S, 1.3), hips_rot=(-30, 0, -20), chest=(-10, 0, 0))
DIVE = body(base=tuck(S, 1.0), hips_loc=(0, 0.05, 0.25), hips_rot=(25, 0, -30), chest=(10, 0, 0), head=(-20, 0, 20),
            foot_R=fR((-0.06, 0.55, -0.10), yaw=-40, pole=(0, 1, -0.2), pitch=60),
            foot_L=fL((0.10, -0.10, 0.55), pole=(0, 1, 0)),
            hand_L=hL((0.20, -0.05, 1.45), pole=(1, 0, 0)), hand_R=hR((-0.25, -0.20, 1.35), pole=(-1, 0, 0)))

# ---------------------------------------------------------------- focus (charged)
CHARGE = body(hips_loc=(0, -0.10, -0.20), hips_rot=(10, 0, -55), spine=(6, 0, -10), chest=(8, 4, -16), neck=(-4, 0, 34),
              head=(-8, 0, 36), hand_R=hR((-0.22, -0.18, 1.02), pole=(-0.6, -0.8, -0.2)),
              hand_L=hL((0.04, 0.48, 1.22), pole=(0.8, 0, -1), dir=(0, 0.4, 1)),
              foot_L=fL((0.08, 0.30, 0.085)), foot_R=fR((-0.14, -0.40, 0.085)))
FOCUS_HIT = body(hips_loc=(0, 0.22, -0.16), hips_rot=(12, 0, 15), spine=(4, 0, 10), chest=(8, -6, 22), neck=(-8, 0, -16),
                 head=(-10, 0, -18), hand_R=hR((-0.02, 0.86, 1.32), pole=(-1, 0, -0.2)),
                 hand_L=hL((0.18, -0.02, 1.20)), foot_L=fL((0.08, 0.52, 0.085)), foot_R=fR((-0.12, -0.25, 0.085), yaw=-5))

# ---------------------------------------------------------------- qi arts
PALMS_PREP = body(hips_loc=(0, -0.08, -0.16), hips_rot=(6, 0, -20), chest=(-6, 0, -6),
                  hand_L=hL((0.18, 0.02, 1.15), dir=(0, 0.3, 1)), hand_R=hR((-0.18, 0.0, 1.12), dir=(0, 0.3, 1)))
PALMS = body(hips_loc=(0, 0.16, -0.18), hips_rot=(10, 0, -4), spine=(4, 0, 0), chest=(6, 0, 4), neck=(-6, 0, 2), head=(-8, 0, 4),
             hand_L=hL((0.08, 0.72, 1.32), pole=(1, 0, -0.5), dir=(0, 0.2, 1)),
             hand_R=hR((-0.08, 0.72, 1.18), pole=(-1, 0, -0.5), dir=(0, 0.2, -1)),
             foot_L=fL((0.08, 0.48, 0.085)), foot_R=fR((-0.12, -0.32, 0.085)))
STEP_CROUCH = with_body_drop(body(hips_rot=(24, 0, -10), chest=(14, 0, 0), head=(-20, 0, 10)), -0.18)
STEP_BLUR = body(hips_loc=(0, 0.20, -0.25), hips_rot=(40, 0, 0), chest=(16, 0, 0), head=(-36, 0, 0),
                 foot_L=fL((0.08, 0.45, 0.10)), foot_R=fR((-0.10, -0.55, 0.25)),
                 hand_L=hL((0.20, -0.30, 0.95), pole=(1, 0, 0)), hand_R=hR((-0.20, -0.40, 0.95), pole=(-1, 0, 0)))
STEP_ELBOW = body(base=ELBOW, hips_loc=(0, 0.20, -0.14))
DRAGON_LOW = with_body_drop(body(hips_rot=(20, 0, -40), chest=(10, 0, -10),
                                 hand_R=hR((-0.22, -0.05, 0.95), dir=(0, 0.2, 1))), -0.20)
DRAGON = body(hips_loc=(0, 0.06, 0.18), hips_rot=(-14, 0, 20), spine=(-8, -6, 10), chest=(-12, -8, 20), neck=(-10, 0, -20),
              head=(-20, 0, -20), hand_R=hR((-0.06, 0.18, 2.12), pole=(-1, -0.2, 0), dir=(0, 0, 1)),
              hand_L=hL((0.22, 0.05, 1.20)), foot_R=fR((-0.12, 0.10, 0.45), pole=(0, 1, 0), pitch=40),
              foot_L=fL((0.10, -0.10, 0.22), pitch=50))

# ---------------------------------------------------------------- secret art
RUSH = body(hips_loc=(0, 0.25, -0.20), hips_rot=(30, 0, -10), chest=(10, 0, 0), head=(-26, 0, 10),
            foot_L=fL((0.08, 0.55, 0.085)), foot_R=fR((-0.12, -0.45, 0.12)),
            hand_L=hL((0.10, 0.20, 1.10)), hand_R=hR((-0.20, -0.30, 0.95)))


def flurry_pose(i):
    hy = 1.18 + 0.12 * ((i * 7) % 3)
    hx = 0.05 * ((i * 5) % 3 - 1)
    if i % 2 == 0:
        return body(base=JAB, hips_loc=(0, 0.08, -0.12), hand_L=hL((0.03 + hx, 0.70, hy), pole=(0.9, 0.2, -0.4)))
    return body(base=CROSS, hips_loc=(0, 0.10, -0.12), hand_R=hR((-0.04 + hx, 0.70, hy), pole=(-1.0, 0.0, -0.3)))


FINISH_UP = body(base=HAMMER_UP, hips_loc=(0, 0.0, 0.10), hand_R=hR((-0.10, -0.05, 1.95), pole=(-1, 0.3, 0.2)),
                 hand_L=hL((0.20, 0.25, 1.50), pole=(1, 0, 0)))
FINISH = body(base=HAMMER, hips_loc=(0, 0.20, -0.30), hips_rot=(30, 0, 0), chest=(20, -6, 14),
              hand_R=hR((-0.04, 0.70, 0.55), pole=(-1, 0.2, 0.4)))

# ---------------------------------------------------------------- intro / win
UPRIGHT = {
    'hips': {'loc': (0, 0, 0), 'rot': (0, 0, -10)}, 'spine': (0, 0, 0), 'chest': (-2, 0, 0), 'neck': (0, 0, 6),
    'head': (2, 0, 4), 'shoulder_L': (0, 0), 'shoulder_R': (0, 0),
    'hand_L': hL((0.22, 0.02, 0.86), pole=(0.3, -1, 0)), 'hand_R': hR((-0.22, 0.02, 0.86), pole=(-0.3, -1, 0)),
    'foot_L': fL((0.10, 0.02, 0.085), yaw=6), 'foot_R': fR((-0.10, -0.02, 0.085), yaw=-6),
}
CRACK = body(base=UPRIGHT, hips_rot=(0, 0, -20), chest=(6, 0, -6), head=(14, 0, 10),
             hand_L=hL((0.04, 0.24, 1.22), pole=(1, 0, -1)), hand_R=hR((-0.04, 0.22, 1.20), pole=(-1, 0, -1)))
WIN_A = body(base=UPRIGHT, hips_rot=(0, 0, 25), chest=(-6, 0, 10), neck=(-6, 0, -10), head=(-10, 0, -20),
             hand_R=hR((-0.05, 0.10, 1.62), pole=(-1, 0, 0.5)), hand_L=hL((0.20, 0.0, 0.95), pole=(0.3, -1, 0)))
WIN_B = body(base=WIN_A, head=(-4, 6, -24), hand_R=hR((-0.02, 0.12, 1.66), pole=(-1, 0, 0.5)))
WIN_FINAL = body(base=UPRIGHT, hips_rot=(0, 0, 30), chest=(-4, 0, 20), neck=(-4, 0, -30), head=(-6, 4, -30),
                 hand_R=hR((-0.30, 0.22, 1.10), pole=(-1, 0, -0.5)),
                 hand_L=hL((0.10, -0.15, 1.05), pole=(1, 0.3, -1)),
                 foot_R=fR((-0.16, -0.10, 0.085), yaw=-30))


def clips():
    c = base_clips(S, speeds=(2.0, 1.6), charge_pose=CHARGE)
    I = 'inout'
    c['s1'] = clip([(0, S, 'lin'), (2, JAB_PULL, 'out'), (5, JAB, 'snap'), (8, JAB, 'lin'), (18, S, I)], 18, events={'hit': 5})
    c['s2'] = clip([(0, S, 'lin'), (3, CROSS_PULL, 'out'), (6, CROSS, 'snap'), (9, CROSS, 'lin'), (21, S, I)], 21,
                   events={'hit': 6})
    c['s3'] = clip([(0, S, 'lin'), (5, HAMMER_UP, 'out'), (8, HAMMER, 'snap'), (12, HAMMER, 'lin'), (28, S, I)], 28,
                   events={'hit': 8})
    c['s_f'] = clip([(0, S, 'lin'), (5, ELBOW_WIND, 'out'), (10, ELBOW, 'snap'), (14, ELBOW, 'lin'), (32, S, I)], 32,
                    events={'hit': 10})
    c['s_u'] = clip([(0, S, 'lin'), (5, UPPER_LOW, 'out'), (8, UPPER, 'snap'), (12, UPPER, 'lin'), (32, S, I)], 32,
                    events={'hit': 8})
    c['s_d'] = clip([(0, S, 'lin'), (5, SWEEP_LOW, 'out'), (9, SWEEP, 'snap'), (13, SWEEP, 'lin'), (22, SWEEP_LOW, I),
                     (31, S, I)], 31, events={'hit': 9})
    c['s_air'] = clip([(0, tuck(S), 'lin'), (3, AIR_KNEE_PREP, 'out'), (6, AIR_KNEE, 'snap'), (11, AIR_KNEE, 'lin'),
                       (21, tuck(S), I)], 21, events={'hit': 6})
    c['h'] = clip([(0, S, 'lin'), (8, RH_WIND, 'out'), (14, ROUNDHOUSE, 'snap'), (19, ROUNDHOUSE, 'lin'),
                   (26, RH_FOLLOW, 'out'), (39, S, I)], 39, events={'hit': 14})
    c['h_f'] = clip([(0, S, 'lin'), (8, FKNEE_WIND, 'out'), (16, FKNEE, 'snap'), (22, FKNEE, 'lin'), (40, S, I)], 40,
                    events={'hit': 16})
    c['h_d'] = clip([(0, S, 'lin'), (7, LOWKICK_WIND, 'out'), (13, LOWKICK, 'snap'), (17, LOWKICK, 'lin'), (39, S, I)], 39,
                    events={'hit': 13})
    c['h_air'] = clip([(0, tuck(S), 'lin'), (6, AIRSIDE_WIND, 'out'), (10, AIRSIDE, 'snap'), (16, AIRSIDE, 'lin'),
                       (30, tuck(S), I)], 30, events={'hit': 10})
    c['h_air_d'] = clip([(0, tuck(S), 'lin'), (6, DIVE_WIND, 'out'), (10, DIVE, 'snap'), (20, DIVE, 'lin')], 20,
                        events={'hit': 10})
    c['focus_release'] = clip([(0, CHARGE, 'lin'), (6, FOCUS_HIT, 'snap'), (11, FOCUS_HIT, 'lin'), (35, S, I)], 35,
                              events={'hit': 6})
    c['art_n'] = clip([(0, S, 'lin'), (9, PALMS_PREP, 'out'), (14, PALMS, 'snap'), (20, PALMS, 'lin'), (44, S, I)], 44,
                      events={'hit': 14})
    c['art_f'] = clip([(0, S, 'lin'), (6, STEP_CROUCH, 'out'), (9, STEP_BLUR, 'snap'), (19, STEP_BLUR, 'lin'),
                       (21, ELBOW_WIND, 'snap'), (24, STEP_ELBOW, 'snap'), (28, STEP_ELBOW, 'lin'), (40, S, I)], 40,
                      events={'hit': 24})
    c['art_d'] = clip([(0, S, 'lin'), (2, DRAGON_LOW, 'snap'), (6, DRAGON, 'snap'), (16, DRAGON, 'lin'),
                       (30, nudge(DRAGON, hips_rot=(10, 0, 0)), 'inout'), (44, tuck(S), I)], 44, events={'hit': 4})
    sec = [(0, S, 'lin'), (6, STEP_CROUCH, 'out'), (10, RUSH, 'snap')]
    f = 14
    for i in range(16):
        sec.append((f, flurry_pose(i), 'snap'))
        f += 5
    sec += [(f + 6, FINISH_UP, 'out'), (f + 16, FINISH, 'snap'), (f + 30, FINISH, 'lin'), (f + 50, S, I)]
    c['secret'] = clip(sec, f + 50, events={'hit': 10, 'finish': f + 16})
    c['intro'] = clip([(0, UPRIGHT, 'lin'), (14, CRACK, I), (26, CRACK, 'lin'), (40, S, I)], 40)
    c['win'] = clip([(0, S, 'lin'), (16, WIN_A, I), (30, WIN_B, I), (44, WIN_A, I), (64, WIN_FINAL, I)], 64)
    return c


def preview_poses(which):
    if which in ('big', 'face'):
        return [STANCE]
    if which == 'rest':
        return [None]
    if which == 'poses1':
        return [JAB, CROSS, HAMMER_UP, HAMMER, ELBOW, UPPER, SWEEP_LOW, SWEEP, AIR_KNEE, RH_WIND, ROUNDHOUSE, RH_FOLLOW]
    if which == 'poses2':
        return [FKNEE, LOWKICK, AIRSIDE, DIVE, CHARGE, FOCUS_HIT, PALMS, STEP_BLUR, DRAGON_LOW, DRAGON, FINISH, WIN_FINAL]
    return [None, STANCE, JAB, CROSS, ROUNDHOUSE, SWEEP, FOCUS_HIT, DRAGON]
