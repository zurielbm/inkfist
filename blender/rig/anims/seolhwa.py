"""Seol-hwa poses & clips. Character space: (side, fwd, up); side>0 = char-left. Camera sees the char's RIGHT side.
Fighting style: flowing sleeve-dance (whip-like sleeve lashes, spinning kicks, gliding steps).

Sleeves are spring chains in game; the static key poses keep the forearms mostly near-horizontal so the pouch
(rolled to hang straight down in STANCE, see chars.seolhwa.SLEEVE_ROLL) reads as a hanging sleeve."""
import math

from ..core import C
from ..pose import P, qa, AX, AY, AZ
from ..chars.seolhwa import J
from .common import base_clips, clip, nudge, with_body_drop, tuck, walk

PELVIS_Z = J['hips'][0][2]

FZ = 0.079   # ankle height when the foot is planted

STANCE = {
    'hips': {'loc': (0.0, -0.03, -0.045), 'rot': (2, 0, -28)},
    'spine': (0, 0, -4),
    'chest': (-2, 2, -6),
    'neck': (-2, 0, 14),
    'head': (-4, -3, 18),
    'shoulder_L': (0, 4),
    'shoulder_R': (6, -4),
    'hand_L': {'pos': (0.17, 0.55, 1.29), 'pole': (0.6, 0.0, -1.0), 'dir': (0.0, 0.3, 1.0)},
    'hand_R': {'pos': (-0.46, -0.40, 1.25), 'pole': (-0.3, 0.0, -1.0), 'dir': (-0.5, -0.6, 0.5)},
    'foot_L': {'pos': (0.05, 0.26, 0.11), 'yaw': 4, 'pitch': 28, 'pole': (0.2, 1.0, 0.0)},
    'foot_R': {'pos': (-0.10, -0.20, FZ), 'yaw': -40, 'pole': (-0.5, 1.0, 0.0)},
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


def fL(pos, yaw=4, pole=(0.2, 1.0, 0.0), **kw):
    return dict(pos=pos, yaw=yaw, pole=pole, **kw)


def fR(pos, yaw=-40, pole=(-0.5, 1.0, 0.0), **kw):
    return dict(pos=pos, yaw=yaw, pole=pole, **kw)


def _rot(v, a):
    c, s = math.cos(a), math.sin(a)
    return (v[0] * c + v[1] * s, v[1] * c - v[0] * s, v[2])


def spin(pose, deg):
    """Rotate a whole pose about the vertical axis through the origin (deg>0 turns to char-left).
    Hips twist + hip offset + every hand/foot target, pole and dir rotate together (foot yaw already follows the
    hips twist in the solver), so poses can be authored in the body frame and then spun."""
    a = math.radians(deg)
    p = P(pose)
    h = dict(p['hips'])
    h['loc'] = _rot(h.get('loc', (0, 0, 0)), a)
    r = h.get('rot', (0, 0, 0))
    h['rot'] = (r[0], r[1], r[2] + deg)
    p['hips'] = h
    for k in ('hand_L', 'hand_R', 'foot_L', 'foot_R'):
        d = dict(p[k])
        for kk in ('pos', 'pole', 'dir'):
            if kk in d:
                d[kk] = _rot(d[kk], a)
        p[k] = d
    return p


# ---------------------------------------------------------------- light (J)
# s1: lead-sleeve flick — cock the lead arm, whip it out to full reach
FLICK_PREP = body(hips_loc=(0, -0.04, -0.05), hips_rot=(0, 0, -22), chest=(-4, 2, 0), neck=(-2, 0, 10), head=(-4, 0, 14),
                  hand_L=hL((0.24, 0.26, 1.44), pole=(1.0, -0.2, 0.3), dir=(0, -0.3, 1)),
                  hand_R=hR((-0.42, -0.36, 1.22), pole=(-0.3, 0.0, -1.0)))
FLICK = body(hips_loc=(0, 0.05, -0.06), hips_rot=(4, 0, -42), spine=(2, 0, -6), chest=(4, 0, -14), neck=(-2, 0, 26),
             head=(-4, 0, 28), hand_L=hL((0.10, 0.70, 1.30), pole=(0.8, 0.0, -0.6), dir=(0, 1, -0.3)),
             hand_R=hR((-0.44, -0.48, 1.16), pole=(-0.3, 0.0, -1.0)),
             foot_L=fL((0.05, 0.34, 0.09), pitch=10))
FLICK_FOLLOW = nudge(FLICK, hand_L=(0.0, -0.05, -0.10), chest=(2, 0, 0))

# s2: rear-sleeve horizontal lash — coil, unwind, sweep across
LASH_WIND = body(hips_loc=(0, -0.04, -0.06), hips_rot=(2, 0, -50), spine=(0, 0, -8), chest=(-2, 4, -16), neck=(-2, 0, 30),
                 head=(-4, 0, 36), hand_R=hR((-0.44, -0.42, 1.36), pole=(-0.4, 0.2, -1.0)),
                 hand_L=hL((0.22, 0.42, 1.24), pole=(0.8, 0.0, -0.8)))
LASH = body(hips_loc=(0, 0.06, -0.07), hips_rot=(6, 0, 6), spine=(2, 0, 10), chest=(4, -4, 18), neck=(-2, 0, -12),
            head=(-4, 0, -14), hand_R=hR((0.04, 0.66, 1.34), pole=(-0.3, 0.3, -1.0), dir=(0.6, 0.8, 0)),
            hand_L=hL((0.34, 0.06, 1.18), pole=(1, 0, -0.5)),
            foot_L=fL((0.05, 0.28, FZ), pitch=0), foot_R=fR((-0.10, -0.16, FZ), yaw=-10))
LASH_FOLLOW = body(base=LASH, hips_rot=(4, 0, 18), chest=(4, -4, 28), neck=(-2, 0, -20),
                   hand_R=hR((0.36, 0.40, 1.24), pole=(-0.2, 0.6, -1.0)))

# s3: spinning crescent kick — rear leg sweeps a high arc outside-in while the hips turn
CRES_WIND = body(hips_loc=(0, 0.02, -0.07), hips_rot=(4, 0, -55), chest=(0, 0, -10), neck=(-2, 0, 30), head=(-4, 0, 34),
                 hand_L=hL((0.36, 0.36, 1.36), pole=(1, 0, 0)), hand_R=hR((-0.44, -0.18, 1.40), pole=(-1, 0, 0)),
                 foot_L=fL((0.05, 0.22, FZ), pitch=0, yaw=-10),
                 foot_R=fR((-0.24, -0.20, 0.32), yaw=-60, pole=(-0.6, 1.0, 0.0)))
CRES = body(hips_loc=(0, 0.02, -0.02), hips_rot=(-16, -10, -16), spine=(-4, 0, 0), chest=(-4, 4, 0), neck=(4, 0, 8),
            head=(4, 0, 10), foot_R=fR((-0.30, 0.46, 1.36), yaw=-90, pole=(-1.0, 0.0, 0.3), pitch=10),
            foot_L=fL((0.05, 0.10, FZ), yaw=-20, pitch=0), hand_L=hL((0.46, 0.22, 1.42), pole=(1, 0, 0)),
            hand_R=hR((-0.48, -0.30, 1.12), pole=(-1, 0, 0)))
CRES_FOLLOW = body(base=CRES, hips_rot=(-12, -6, 18), chest=(-4, 4, 14), neck=(2, 0, -6), head=(2, 0, -8),
                   foot_R=fR((0.16, 0.42, 1.08), yaw=-30, pole=(0.3, 0.2, 1.0), pitch=10))
CRES_DOWN = body(hips_loc=(0, 0.0, -0.08), hips_rot=(4, 0, 0), chest=(0, 2, 0), neck=(-2, 0, 0), head=(-4, 0, 4),
                 foot_R=fR((-0.08, -0.10, 0.20), yaw=-20), foot_L=fL((0.05, 0.12, FZ), pitch=0, yaw=-10),
                 hand_L=hL((0.40, 0.20, 1.25), pole=(1, 0, -0.3)), hand_R=hR((-0.40, -0.25, 1.15)))

# s_f: lunging double-sleeve spear thrust
SPEAR_PREP = body(hips_loc=(0, -0.05, -0.11), hips_rot=(4, 0, -30), chest=(-4, 0, -6), neck=(-2, 0, 16), head=(-4, 0, 18),
                  hand_L=hL((0.18, 0.06, 1.06), pole=(1.0, 0.2, -0.2), dir=(0, 1, 0.2)),
                  hand_R=hR((-0.10, 0.00, 1.02), pole=(-1.0, 0.2, -0.2), dir=(0, 1, 0.2)),
                  foot_L=fL((0.05, 0.26, FZ), pitch=0))
SPEAR = body(hips_loc=(0, 0.22, -0.16), hips_rot=(12, 0, -4), spine=(6, 0, -4), chest=(4, 0, -6), neck=(-8, 0, 6),
             head=(-10, 0, 6), hand_L=hL((0.12, 0.80, 1.24), pole=(1, 0, -0.3), dir=(0, 1, 0)),
             hand_R=hR((-0.06, 0.78, 1.16), pole=(-1, 0, -0.3), dir=(0, 1, 0)),
             foot_L=fL((0.06, 0.62, FZ), pitch=0), foot_R=fR((-0.10, -0.30, FZ), yaw=-30))
SPEAR_HOLD = nudge(SPEAR, hips_loc=(0, 0.02, -0.01), hand_L=(0, 0.02, -0.04), hand_R=(0, 0.02, -0.05))

# s_u: rising overhead sleeve whip (launcher)
RISE_LOW = with_body_drop(body(hips_rot=(14, 0, -34), chest=(10, 0, -8), neck=(-6, 0, 16), head=(-12, 0, 20),
                               hand_R=hR((-0.22, 0.12, 0.84), pole=(-1, 0, 0), dir=(0, 0.6, -1)),
                               hand_L=hL((0.24, 0.30, 1.12), pole=(1, 0, -0.4)),
                               foot_L=fL((0.05, 0.26, FZ), pitch=0)), -0.14)
RISE = body(hips_loc=(0, 0.06, 0.0), hips_rot=(-6, 0, 0), spine=(-6, 0, 4), chest=(-10, -4, 10), neck=(-8, 0, -4),
            head=(-16, 0, -4), hand_R=hR((-0.06, 0.30, 1.76), pole=(-1, 0, 0), dir=(0, 0.6, 1)),
            hand_L=hL((0.32, 0.0, 1.10), pole=(1, 0, 0)),
            foot_R=fR((-0.10, -0.12, 0.13), yaw=-20, pitch=30), foot_L=fL((0.05, 0.24, FZ), pitch=10))
RISE_FOLLOW = body(base=RISE, chest=(-14, -4, 10), hand_R=hR((-0.08, 0.04, 1.78), pole=(-1, 0, 0), dir=(0, -0.3, 1)))

# s_d: low sweeping sleeve along the ground
LOW_PREP = body(hips_loc=(0, -0.06, -0.30), hips_rot=(20, 0, -40), spine=(10, 0, 0), chest=(10, 0, -10), neck=(-8, 0, 20),
                head=(-20, 0, 24), hand_R=hR((-0.42, -0.22, 0.64), pole=(-1, 0, 0)),
                hand_L=hL((0.26, 0.30, 0.98), pole=(1, 0, -0.4)),
                foot_L=fL((0.10, 0.34, FZ), pitch=0, pole=(0.5, 1.0, 0.0)), foot_R=fR((-0.16, -0.36, FZ), yaw=-50))
LOWSWEEP = body(hips_loc=(0, 0.08, -0.34), hips_rot=(28, 0, 0), spine=(10, 0, 8), chest=(14, -6, 16), neck=(-12, 0, -6),
                head=(-24, 0, -6), hand_R=hR((0.0, 0.70, 0.42), pole=(-1, 0.3, 0.5), dir=(0.3, 1, -0.3)),
                hand_L=hL((0.38, 0.0, 0.92), pole=(1, 0, 0)),
                foot_L=fL((0.12, 0.40, FZ), pitch=0, pole=(0.5, 1.0, 0.0)), foot_R=fR((-0.18, -0.38, FZ), yaw=-40))
LOWSWEEP_FOLLOW = body(base=LOWSWEEP, hips_rot=(26, 0, 20), chest=(14, -6, 26),
                       hand_R=hR((0.32, 0.52, 0.40), pole=(-0.5, 0.5, 0.5), dir=(1, 0.5, -0.2)))

# s_air: air sleeve whip down-forward
AIR_PREP = body(base=tuck(S), hips_rot=(-10, 0, -30), chest=(-10, 0, -6), neck=(0, 0, 16), head=(-2, 0, 18),
                hand_R=hR((-0.30, -0.36, 1.70), pole=(-1, 0.2, -0.3)), hand_L=hL((0.26, 0.30, 1.30), pole=(1, 0, -0.5)))
AIR_WHIP = body(base=tuck(S), hips_rot=(14, 0, -10), chest=(14, -4, 8), neck=(-6, 0, 0), head=(-14, 0, 4),
                hand_R=hR((-0.04, 0.54, 1.02), pole=(-1, 0, 0.3), dir=(0, 1, -0.6)),
                hand_L=hL((0.32, -0.06, 1.26), pole=(1, 0, 0)))
AIR_FOLLOW = nudge(AIR_WHIP, hand_R=(0.08, -0.10, -0.10), chest=(4, 0, 6))

# ---------------------------------------------------------------- heavy (K)
# h: spinning high back kick — turn the back, thrust the rear heel at head height, finish the turn
BK_BODY = {   # authored in the body frame, kicking BACKWARD; spun 180 deg it kicks the opponent
    'hips': {'loc': (0.0, 0.04, -0.02), 'rot': (30, 0, 8)}, 'spine': (6, 0, 0), 'chest': (4, 0, 4),
    'neck': (-16, 0, 48), 'head': (-18, 0, 52), 'shoulder_L': (6, 0), 'shoulder_R': (6, 0),
    'hand_L': hL((0.46, 0.18, 1.12), pole=(1, 0, 0)), 'hand_R': hR((-0.40, 0.34, 1.02), pole=(-1, 0, 0)),
    'foot_L': fL((0.06, 0.10, FZ), yaw=10, pitch=0), 'foot_R': fR((-0.06, -0.74, 1.20), yaw=0, pole=(0, 0, 1),
                                                                   pitch=-10),
}
BK_WIND = spin(body(base=BK_BODY, hips_loc=(0, 0.0, -0.08), hips_rot=(8, 0, 10), spine=(2, 0, 0), chest=(2, 0, 6),
                    neck=(-4, 0, 40), head=(-6, 0, 44),
                    foot_R=fR((-0.10, -0.10, 0.34), yaw=0, pole=(-0.2, 1, 0)),
                    hand_L=hL((0.36, 0.24, 1.30), pole=(1, 0, 0)), hand_R=hR((-0.36, 0.24, 1.28), pole=(-1, 0, 0))),
              -110)
BK = spin(BK_BODY, -180)
BK_FOLLOW = spin(body(base=BK_BODY, foot_R=fR((-0.10, -0.66, 1.00), yaw=0, pole=(0, 0, 1), pitch=-10)), -205)
BK_LAND = spin(body(base=S, hips_loc=(0, 0.0, -0.08), hips_rot=(6, 0, -28), chest=(2, 2, -6),
                    foot_R=fR((-0.10, -0.16, 0.12), yaw=-30), hand_L=hL((0.30, 0.40, 1.22), pole=(1, 0, -0.5)),
                    hand_R=hR((-0.42, -0.30, 1.18))), -320)

# h_f: gliding flying kick forward
FK_PREP = with_body_drop(body(hips_rot=(14, 0, -30), chest=(10, 0, -6), neck=(-6, 0, 16), head=(-12, 0, 20),
                              hand_L=hL((0.26, 0.30, 1.06), pole=(1, 0, -0.3)), hand_R=hR((-0.32, -0.22, 1.00)),
                              foot_L=fL((0.05, 0.26, FZ), pitch=0)), -0.16)
FK_RISE = body(hips_loc=(0, 0.16, 0.22), hips_rot=(-4, 0, -40), chest=(4, 0, -8), neck=(-2, 0, 22), head=(-4, 0, 26),
               foot_L=fL((0.06, 0.22, 0.62), pole=(0, 1, 0.3), pitch=30), foot_R=fR((-0.12, -0.12, 0.46), pole=(0, 1, 0)),
               hand_L=hL((0.34, 0.20, 1.56), pole=(1, 0, 0)), hand_R=hR((-0.42, -0.30, 1.46), pole=(-1, 0, 0)))
FK = body(hips_loc=(0, 0.24, 0.30), hips_rot=(-18, 0, -62), spine=(4, 0, 0), chest=(8, 6, 0), neck=(-4, 0, 30),
          head=(-6, 0, 34), foot_L=fL((0.10, 0.92, 0.98), yaw=-10, pole=(0.5, 0.0, 1.0), pitch=-20),
          foot_R=fR((-0.12, 0.02, 0.56), pole=(0, 1, 0), pitch=40),
          hand_L=hL((0.30, 0.40, 1.52), pole=(1, 0, 0)), hand_R=hR((-0.38, -0.26, 1.50), pole=(-1, 0, 0)))
FK_HOLD = nudge(FK, hips_loc=(0, 0.03, -0.05), foot_L=(0, 0.0, -0.05))
FK_LAND = nudge(with_body_drop(S, -0.14), hips_loc=(0, 0.04, 0), hips_rot=(10, 0, 0), chest=(6, 0, 0))

# h_d: crouched spinning heel sweep (authored with the sweeping leg out to the RIGHT side, then spun)
HS_BODY = {
    'hips': {'loc': (0.06, 0.0, -0.50), 'rot': (24, 8, 0)}, 'spine': (10, 0, 0), 'chest': (10, 4, 0),
    'neck': (-14, 0, -30), 'head': (-20, 0, -40), 'shoulder_L': (0, 0), 'shoulder_R': (0, 0),
    'hand_L': hL((0.30, 0.18, 0.13), pole=(1, 0.5, 0.5), dir=(0, 0.2, -1)),
    'hand_R': hR((-0.30, 0.30, 0.55), pole=(-1, 0, 0.3)),
    'foot_L': fL((0.16, 0.12, FZ), yaw=10, pole=(1.0, 1.0, 0.0), pitch=0),
    'foot_R': fR((-0.80, 0.02, 0.09), yaw=-90, pole=(0, 0, 1), pitch=-10),
}
HS_DOWN = spin(body(base=HS_BODY, hips_loc=(0.04, 0.0, -0.40), foot_R=fR((-0.40, 0.0, 0.10), yaw=-90, pole=(0, 0, 1)),
                    hand_L=hL((0.30, 0.18, 0.28), pole=(1, 0.5, 0.5), dir=(0, 0.2, -1))), -80)
HS = spin(HS_BODY, 90)
HS_FOLLOW = spin(HS_BODY, 150)
HS_UP = spin(body(base=HS_BODY, hips_loc=(0.02, 0.0, -0.36), hips_rot=(16, 4, 0),
                  hand_L=hL((0.30, 0.20, 0.34), pole=(1, 0.5, 0.5), dir=(0, 0.2, -1)),
                  foot_R=fR((-0.36, 0.0, 0.10), yaw=-90, pole=(0, 0, 1))), 250)

# h_air: air spinning sleeve tornado (arms spread so both sleeves fan out)
AT_BODY = body(base=tuck(S), hips_rot=(-6, 0, 0), spine=(0, 0, 0), chest=(-4, 0, 0), neck=(-2, 0, 0), head=(-4, 0, 0),
               hand_L=hL((0.60, 0.08, 1.48), pole=(0, 0, -1), dir=(1, 0.2, 0)),
               hand_R=hR((-0.60, 0.08, 1.48), pole=(0, 0, -1), dir=(-1, 0.2, 0)),
               foot_L=fL((0.10, 0.12, 0.48), pole=(0, 1, 0), pitch=30),
               foot_R=fR((-0.10, -0.02, 0.38), yaw=0, pole=(0, 1, 0), pitch=30))

# h_air_d: heel-drop dive
HD_RAISE = body(base=tuck(S), hips_rot=(-26, 0, -20), chest=(-8, 0, 0), neck=(0, 0, 10), head=(-2, 0, 12),
                foot_L=fL((0.10, 0.40, 1.58), pole=(0, 0, 1), pitch=-30),
                hand_L=hL((0.40, 0.10, 1.62), pole=(1, 0, 0)), hand_R=hR((-0.42, -0.10, 1.58), pole=(-1, 0, 0)))
HD = body(base=tuck(S), hips_loc=(0, 0.08, 0.20), hips_rot=(28, 0, -20), chest=(12, 0, 0), neck=(-12, 0, 8),
          head=(-22, 0, 10), foot_L=fL((0.10, 0.50, 0.40), pole=(0, 1, 0.2), pitch=-30),
          foot_R=fR((-0.10, -0.18, 0.62), pole=(0, 1, 0), pitch=40),
          hand_L=hL((0.36, -0.06, 1.50), pole=(1, 0, 0)), hand_R=hR((-0.36, -0.12, 1.46), pole=(-1, 0, 0)))

# ---------------------------------------------------------------- focus (charged)
CHARGE = body(hips_loc=(0, -0.06, -0.16), hips_rot=(8, 0, -40), spine=(4, 0, -8), chest=(2, 2, -14), neck=(-4, 0, 30),
              head=(-8, 0, 32), hand_L=hL((0.30, 0.30, 1.10), pole=(1, -0.3, -0.3), dir=(0.3, 0.5, 1)),
              hand_R=hR((-0.36, -0.30, 1.10), pole=(-1, -0.3, -0.3), dir=(-0.3, -0.5, 1)),
              foot_L=fL((0.06, 0.30, FZ), pitch=0), foot_R=fR((-0.14, -0.32, FZ), yaw=-45))
FOCUS_HIT = body(hips_loc=(0, 0.20, -0.14), hips_rot=(10, 0, -12), spine=(4, 0, 0), chest=(6, 0, 0), neck=(-6, 0, 10),
                 head=(-8, 0, 10), hand_L=hL((0.14, 0.80, 1.34), pole=(1, 0, -0.4), dir=(0, 0.3, 1)),
                 hand_R=hR((-0.04, 0.80, 1.20), pole=(-1, 0, -0.4), dir=(0, 0.3, 1)),
                 foot_L=fL((0.06, 0.52, FZ), pitch=0), foot_R=fR((-0.12, -0.30, FZ), yaw=-30))

# ---------------------------------------------------------------- qi arts
# art_n Silk Lash: big overhead wind-up, the rear sleeve hurled forward
SL_WIND = body(hips_loc=(0, -0.06, -0.06), hips_rot=(-4, 0, -56), spine=(-4, 0, -8), chest=(-8, 4, -14), neck=(0, 0, 36),
               head=(-4, 0, 40), hand_R=hR((-0.28, -0.30, 1.72), pole=(-1, 0.3, 0.3)),
               hand_L=hL((0.26, 0.46, 1.30), pole=(1, 0, -0.5), dir=(0, 0.3, 1)),
               foot_L=fL((0.05, 0.26, FZ), pitch=0), foot_R=fR((-0.12, -0.30, FZ)))
SL = body(hips_loc=(0, 0.14, -0.10), hips_rot=(10, 0, 10), spine=(6, 0, 10), chest=(8, -4, 20), neck=(-6, 0, -14),
          head=(-8, 0, -14), hand_R=hR((-0.02, 0.80, 1.30), pole=(-1, 0, -0.2), dir=(0, 1, -0.1)),
          hand_L=hL((0.38, 0.0, 1.10), pole=(1, 0, 0)),
          foot_L=fL((0.06, 0.44, FZ), pitch=0), foot_R=fR((-0.10, -0.24, FZ), yaw=-10))
SL_HOLD = nudge(SL, hand_R=(0.0, -0.02, -0.08), chest=(2, 0, 0))

# art_f Floating Step: glide up like a crane, snap kick forward, float down
FS_CROUCH = with_body_drop(body(hips_rot=(10, 0, -30), chest=(6, 0, -6), foot_L=fL((0.05, 0.26, FZ), pitch=0),
                                hand_L=hL((0.28, 0.30, 1.10), pole=(1, 0, -0.3)), hand_R=hR((-0.36, -0.26, 1.06))),
                           -0.10)
FS_FLOAT = body(hips_loc=(0, 0.12, 0.20), hips_rot=(-6, 0, -40), chest=(-4, 4, -6), neck=(-2, 0, 24), head=(-4, 0, 26),
                foot_L=fL((0.06, 0.30, 0.56), pole=(0, 1, 0.2), pitch=40), foot_R=fR((-0.10, -0.35, 0.46), pole=(0, 1, 0),
                                                                                 pitch=40),
                hand_L=hL((0.48, 0.10, 1.50), pole=(1, 0, 0)), hand_R=hR((-0.48, -0.22, 1.50), pole=(-1, 0, 0)))
FS_KICK = body(hips_loc=(0, 0.22, 0.24), hips_rot=(-16, 0, -30), spine=(-4, 0, 0), chest=(-2, 0, -4), neck=(0, 0, 20),
               head=(-4, 0, 20), foot_L=fL((0.06, 0.88, 0.86), pole=(0, 0.2, 1), pitch=-10),
               foot_R=fR((-0.10, -0.20, 0.42), pole=(0, 1, 0), pitch=40),
               hand_L=hL((0.42, 0.04, 1.54), pole=(1, 0, 0)), hand_R=hR((-0.44, -0.36, 1.46), pole=(-1, 0, 0)))
FS_HOLD = nudge(FS_KICK, hips_loc=(0, 0.02, -0.03))
FS_LAND = nudge(with_body_drop(S, -0.12), hips_loc=(0, 0.04, 0), chest=(4, 0, 0))

# art_d Earth Bloom: little hop, knee high, sleeves raised — then a crater-making stomp, sleeves flung out
EB_CROUCH = with_body_drop(body(hips_rot=(10, 0, -24), chest=(6, 0, -4), foot_L=fL((0.05, 0.26, FZ), pitch=0),
                                hand_L=hL((0.24, 0.30, 1.06), pole=(1, 0, -0.3)), hand_R=hR((-0.30, -0.10, 1.02))),
                           -0.12)
EB_HOP = body(hips_loc=(0, 0.02, 0.24), hips_rot=(-4, 0, -20), chest=(-6, 0, -4), neck=(-4, 0, 10), head=(-8, 0, 12),
              foot_R=fR((-0.10, 0.12, 0.74), yaw=-20, pole=(0, 1, 0), pitch=10),
              foot_L=fL((0.06, 0.10, 0.32), pole=(0, 1, 0), pitch=30),
              hand_L=hL((0.42, 0.10, 1.76), pole=(1, 0, 0.2)), hand_R=hR((-0.42, -0.04, 1.76), pole=(-1, 0, 0.2)))
EB_STOMP = body(hips_loc=(0, 0.04, -0.20), hips_rot=(8, 0, -20), spine=(6, 0, 0), chest=(4, 0, -4), neck=(-6, 0, 10),
                head=(-10, 0, 12), foot_R=fR((-0.16, 0.12, FZ), yaw=-20, pitch=0), foot_L=fL((0.18, -0.02, FZ), yaw=10,
                                                                                            pitch=0),
                hand_L=hL((0.30, 0.48, 0.98), pole=(1, 0, 0.2), dir=(0.2, 1, -0.5)),
                hand_R=hR((-0.30, -0.40, 1.00), pole=(-1, 0, 0.2), dir=(-0.2, -1, -0.5)))
EB_HOLD = nudge(EB_STOMP, hips_loc=(0, 0, 0.03), all_hands=(0, 0, 0.04))

# ---------------------------------------------------------------- secret: Blood-Plum Storm
SPIN_BODY = {   # narrow pivot stance, both sleeves fanned out — spun repeatedly
    'hips': {'loc': (0.0, 0.0, -0.06), 'rot': (4, 0, 0)}, 'spine': (0, 0, 0), 'chest': (-2, 0, 0),
    'neck': (-2, 0, 0), 'head': (-4, 0, 0), 'shoulder_L': (4, 0), 'shoulder_R': (4, 0),
    'hand_L': hL((0.58, 0.10, 1.36), pole=(0, 0, -1), dir=(1, 0.3, -0.2)),
    'hand_R': hR((-0.58, -0.10, 1.36), pole=(0, 0, -1), dir=(-1, -0.3, -0.2)),
    'foot_L': fL((0.09, 0.03, 0.10), yaw=0, pitch=25), 'foot_R': fR((-0.09, -0.03, FZ), yaw=0, pole=(-0.2, 1, 0)),
}


def storm_pose(i):
    """Barrage variations: alternating high / low sleeve lashes while spinning."""
    hi = 1.54 if i % 2 == 0 else 1.16
    lo = 1.18 if i % 2 == 0 else 1.50
    return body(base=SPIN_BODY, hips_loc=(0.0, 0.0, -0.06 - 0.03 * (i % 2)),
                hand_L=hL((0.58, 0.14, hi), pole=(0, 0, -1), dir=(1, 0.3, 0.3 if i % 2 == 0 else -0.5)),
                hand_R=hR((-0.58, -0.14, lo), pole=(0, 0, -1), dir=(-1, -0.3, -0.5 if i % 2 == 0 else 0.3)))


RUSH = body(hips_loc=(0, 0.20, -0.14), hips_rot=(16, 0, -10), chest=(6, 0, 0), neck=(-8, 0, 10), head=(-16, 0, 10),
            foot_L=fL((0.06, 0.48, FZ), pitch=0), foot_R=fR((-0.12, -0.34, 0.11)),
            hand_L=hL((0.52, 0.30, 1.22), pole=(0, 0, -1), dir=(1, 0.5, 0)),
            hand_R=hR((-0.52, -0.10, 1.22), pole=(0, 0, -1), dir=(-1, -0.3, 0)))
FINISH_UP = body(base=CHARGE, hips_loc=(0, 0.0, -0.22), hips_rot=(10, 0, -20), chest=(8, 0, -6),
                 hand_L=hL((0.10, 0.20, 0.98), pole=(1, 0.3, -0.2), dir=(0.3, 0.5, -1)),
                 hand_R=hR((-0.10, 0.16, 0.96), pole=(-1, 0.3, -0.2), dir=(-0.3, 0.5, -1)))
FINISH = body(hips_loc=(0, 0.06, 0.06), hips_rot=(-8, 0, -14), spine=(-6, 0, 0), chest=(-10, 0, 0), neck=(-10, 0, 8),
              head=(-20, 0, 8), hand_L=hL((0.14, 0.40, 1.80), pole=(1, 0, 0), dir=(0, 0.4, 1)),
              hand_R=hR((-0.14, -0.10, 1.84), pole=(-1, 0, 0), dir=(0, -0.3, 1)),
              foot_L=fL((0.06, 0.22, 0.12), pitch=30), foot_R=fR((-0.10, -0.14, 0.12), yaw=-20, pitch=30))

# ---------------------------------------------------------------- intro / win
UPRIGHT = {
    'hips': {'loc': (0, 0, 0), 'rot': (0, 0, -10)}, 'spine': (0, 0, 0), 'chest': (-2, 0, 0), 'neck': (0, 0, 6),
    'head': (2, 0, 4), 'shoulder_L': (0, 0), 'shoulder_R': (0, 0),
    'hand_L': hL((0.04, 0.30, 1.20), pole=(1, -0.2, -0.6), dir=(-0.3, 0.3, 1)),
    'hand_R': hR((-0.04, 0.28, 1.18), pole=(-1, -0.2, -0.6), dir=(0.3, 0.4, 1)),
    'foot_L': fL((0.07, 0.04, FZ), yaw=6, pitch=0), 'foot_R': fR((-0.07, -0.04, FZ), yaw=-10),
}
SALUTE = body(base=UPRIGHT, chest=(6, 0, 0), neck=(8, 0, 4), head=(10, 0, 4))
INTRO_OPEN = body(base=UPRIGHT, hips_loc=(0, 0.0, 0.0), hips_rot=(-2, 0, -16), chest=(-6, 0, -4), neck=(-4, 0, 10),
                  head=(-8, 0, 12), hand_L=hL((0.48, 0.38, 1.52), pole=(0.3, -0.3, -1.0), dir=(1, 0.5, 0.5)),
                  hand_R=hR((-0.50, -0.28, 1.48), pole=(-0.3, -0.3, -1.0), dir=(-1, -0.5, 0.5)),
                  foot_R=fR((-0.10, -0.14, FZ), yaw=-30))
INTRO_SWEEP = body(base=UPRIGHT, hips_loc=(0, -0.02, -0.04), hips_rot=(4, 0, -36), chest=(2, 2, -10), neck=(-2, 0, 22),
                   head=(-4, 0, 26), hand_R=hR((-0.46, -0.30, 1.20), pole=(-0.3, 0, -1)),
                   hand_L=hL((0.30, 0.46, 1.16), pole=(1, 0, -0.3), dir=(0, 0.6, -0.4)),
                   foot_L=fL((0.05, 0.22, FZ), pitch=10), foot_R=fR((-0.10, -0.20, FZ), yaw=-40))
WIN_BODY = {
    'hips': {'loc': (0, 0, 0), 'rot': (0, 0, 0)}, 'spine': (0, 0, 0), 'chest': (-2, 0, 0), 'neck': (0, 0, 0),
    'head': (-2, 0, 0), 'shoulder_L': (0, 0), 'shoulder_R': (0, 0),
    'hand_L': hL((0.56, 0.10, 1.40), pole=(0, 0, -1), dir=(1, 0.2, 0)),
    'hand_R': hR((-0.56, 0.10, 1.40), pole=(0, 0, -1), dir=(-1, 0.2, 0)),
    'foot_L': fL((0.07, 0.04, 0.10), yaw=0, pitch=25), 'foot_R': fR((-0.07, -0.04, FZ), yaw=0),
}
WIN_SPIN = spin(WIN_BODY, -180)
WIN_FLIP = spin(body(base=WIN_BODY, chest=(-8, 6, 0), neck=(-10, 10, 0), head=(-18, 14, 0),
                     hand_R=hR((-0.22, -0.20, 1.62), pole=(-1, 0.2, -0.2), dir=(0.3, -0.6, 0.6)),
                     hand_L=hL((0.50, 0.20, 1.20), pole=(0.3, 0, -1))), -300)
WIN_FINAL = spin(body(base=UPRIGHT, hips_rot=(0, 0, -30), chest=(-4, 0, 6), neck=(-2, 4, 26), head=(-4, 8, 30),
                      hand_L=hL((0.02, 0.26, 1.42), pole=(1, -0.3, -0.5), dir=(-0.4, 0.2, 1)),
                      hand_R=hR((-0.36, 0.06, 1.02), pole=(-0.5, -0.5, -1.0), dir=(-0.6, 0.2, -1)),
                      foot_L=fL((0.06, 0.08, 0.10), yaw=10, pitch=25), foot_R=fR((-0.08, -0.06, FZ), yaw=-30)), -360)


def somersault(pose, ang, lift=0.0):
    """Forward flip by ang degrees about the hips' side axis. Unlike common.jump_clips' jump2 (which only adds hips
    bend, leaving every hand/foot IK target fixed so the limbs stretch up to ~70 cm), the targets rotate with the body."""
    p = P(pose)
    h = dict(p['hips'])
    loc, rot = h.get('loc', (0, 0, 0)), h.get('rot', (0, 0, 0))
    M = qa(AZ, rot[2]) @ qa(AY, rot[1])
    R = M @ qa(AX, ang) @ M.inverted()
    pivot = C(*loc) + C(0, 0, PELVIS_Z)

    def back(v):
        return (v.x, -v.y, v.z + lift)

    for k in ('hand_L', 'hand_R', 'foot_L', 'foot_R'):
        d = dict(p[k])
        d['pos'] = back(pivot + R @ (C(*d['pos']) - pivot))
        for kk in ('pole', 'dir'):
            if kk in d:
                v = R @ C(*d[kk])
                d[kk] = (v.x, -v.y, v.z)
        p[k] = d
    h['rot'] = (rot[0] + ang, rot[1], rot[2])
    h['loc'] = (loc[0], loc[1], loc[2] + lift)
    p['hips'] = h
    return p


def lift_lying(pose, dz=0.06):
    """common.reaction_clips' lying poses are tuned for Mu-jin's pelvis height (0.99 m); hers is 0.92 m, so her back
    (and the hair behind it) would sink into the floor. Raise keys in proportion to how far the hips are tipped back."""
    k = max(0.0, min(1.0, (-pose['hips'].get('rot', (0, 0, 0))[0] - 30) / 50))
    if k <= 0:
        return pose
    d = dz * k
    return nudge(pose, hips_loc=(0, 0, d), all_hands=(0, 0, d), foot_L=(0, 0, d), foot_R=(0, 0, d))


def clips():
    c = base_clips(S, speeds=(2.1, 1.8), charge_pose=CHARGE)
    # Work-around for common.walk: its planted phase lasts (1 - swing) = 60% of the cycle but covers the whole
    # cycle's travel, so planted feet slide back at speed / 0.6 (visible foot skating). Pre-scaling the speed by
    # 0.6 makes the planted foot slide back at exactly the requested ground speed.
    c['walk_f'] = walk(S, 2.1 * 0.6, 26, forward=True)
    c['walk_b'] = walk(S, 1.8 * 0.6, 30, forward=False)
    flip = []
    for f in range(0, 25, 2):
        ang = 360 * min(1.0, f / 22) ** 0.8
        flip.append((f, somersault(tuck(S, 1.2), ang, lift=0.25 * math.sin(math.radians(ang))), 'lin'))
    c['jump2'] = clip(flip, 24)
    for nm in ('knockdown', 'down', 'getup'):
        c[nm]['keys'] = [(f, lift_lying(p), e) for f, p, e in c[nm]['keys']]
    I = 'inout'
    c['s1'] = clip([(0, S, 'lin'), (3, FLICK_PREP, 'out'), (7, FLICK, 'snap'), (10, FLICK_FOLLOW, 'out'), (22, S, I)], 22,
                   events={'hit': 7})
    c['s2'] = clip([(0, S, 'lin'), (4, LASH_WIND, 'out'), (8, LASH, 'snap'), (12, LASH_FOLLOW, 'out'), (25, S, I)], 25,
                   events={'hit': 8})
    c['s3'] = clip([(0, S, 'lin'), (5, CRES_WIND, 'out'), (10, CRES, 'snap'), (15, CRES_FOLLOW, 'out'),
                    (22, CRES_DOWN, 'inout'), (32, S, I)], 32, events={'hit': 10})
    c['s_f'] = clip([(0, S, 'lin'), (6, SPEAR_PREP, 'out'), (12, SPEAR, 'snap'), (17, SPEAR_HOLD, 'lin'), (36, S, I)], 36,
                    events={'hit': 12})
    c['s_u'] = clip([(0, S, 'lin'), (5, RISE_LOW, 'out'), (9, RISE, 'snap'), (14, RISE_FOLLOW, 'out'), (35, S, I)], 35,
                    events={'hit': 9})
    c['s_d'] = clip([(0, S, 'lin'), (5, LOW_PREP, 'out'), (10, LOWSWEEP, 'snap'), (15, LOWSWEEP_FOLLOW, 'out'),
                     (23, LOW_PREP, I), (34, S, I)], 34, events={'hit': 10})
    c['s_air'] = clip([(0, tuck(S), 'lin'), (3, AIR_PREP, 'out'), (7, AIR_WHIP, 'snap'), (11, AIR_FOLLOW, 'out'),
                       (24, tuck(S), I)], 24, events={'hit': 7})
    c['h'] = clip([(0, S, 'lin'), (8, BK_WIND, 'out'), (15, BK, 'snap'), (21, BK_FOLLOW, 'lin'), (31, BK_LAND, 'inout'),
                   (42, spin(S, -360), I)], 42, events={'hit': 15})
    c['h_f'] = clip([(0, S, 'lin'), (6, FK_PREP, 'out'), (10, FK_RISE, 'out'), (14, FK, 'snap'), (21, FK_HOLD, 'lin'),
                     (30, FK_LAND, 'in'), (40, S, I)], 40, events={'hit': 14})
    c['h_d'] = clip([(0, S, 'lin'), (6, HS_DOWN, 'out'), (13, HS, 'snap'), (18, HS_FOLLOW, 'out'), (28, HS_UP, 'inout'),
                     (40, spin(S, 360), I)], 40, events={'hit': 13})
    c['h_air'] = clip([(0, tuck(S), 'lin'), (4, spin(AT_BODY, -60), 'out'), (10, spin(AT_BODY, 120), 'snap'),
                       (16, spin(AT_BODY, 300), 'lin'), (22, spin(AT_BODY, 450), 'out'), (32, spin(tuck(S), 720), I)], 32,
                      events={'hit': 10})
    c['h_air_d'] = clip([(0, tuck(S), 'lin'), (6, HD_RAISE, 'out'), (10, HD, 'snap'), (20, HD, 'lin')], 20,
                        events={'hit': 10})
    c['focus_release'] = clip([(0, CHARGE, 'lin'), (7, FOCUS_HIT, 'snap'), (13, FOCUS_HIT, 'lin'), (38, S, I)], 38,
                              events={'hit': 7})
    c['art_n'] = clip([(0, S, 'lin'), (9, SL_WIND, 'out'), (13, SL, 'snap'), (19, SL_HOLD, 'lin'), (40, S, I)], 40,
                      events={'hit': 13})
    c['art_f'] = clip([(0, S, 'lin'), (4, FS_CROUCH, 'out'), (8, FS_FLOAT, 'out'), (12, FS_KICK, 'snap'),
                       (20, FS_HOLD, 'lin'), (30, FS_LAND, 'in'), (40, S, I)], 40, events={'hit': 12})
    c['art_d'] = clip([(0, S, 'lin'), (4, EB_CROUCH, 'out'), (11, EB_HOP, 'out'), (18, EB_STOMP, 'snap'),
                       (28, EB_HOLD, 'lin'), (50, S, I)], 50, events={'hit': 18})
    # secret: crouch, spinning rush (hit 10), ~5 whirling turns of sleeve lashes, gather, upward blast (finish 120)
    sec = [(0, S, 'lin'), (6, CHARGE, 'out'), (10, spin(RUSH, 0), 'snap')]
    f, ang = 14, 0
    i = 0
    while f <= 102:
        sec.append((f, spin(storm_pose(i), ang), 'lin'))
        f += 4
        ang += 80
        i += 1
    total = 360 * round(ang / 360)
    sec += [(110, spin(FINISH_UP, total), 'out'), (120, spin(FINISH, total), 'snap'), (134, spin(FINISH, total), 'lin'),
            (150, spin(S, total), I)]
    c['secret'] = clip(sec, 150, events={'hit': 10, 'finish': 120})
    c['intro'] = clip([(0, SALUTE, 'lin'), (8, SALUTE, 'lin'), (18, INTRO_OPEN, I), (28, INTRO_SWEEP, I), (40, S, I)], 40)
    c['win'] = clip([(0, S, 'lin'), (14, WIN_SPIN, I), (28, WIN_FLIP, I), (40, WIN_FLIP, 'lin'), (54, WIN_FINAL, I),
                     (64, WIN_FINAL, 'lin')], 64)
    return c


def preview_poses(which):
    if which == 'rest':
        return [None]
    if which in ('big', 'face'):
        return [STANCE]
    if which == 'poses1':
        return [FLICK_PREP, FLICK, LASH_WIND, LASH, CRES, CRES_FOLLOW, SPEAR, RISE, LOWSWEEP, AIR_PREP, AIR_WHIP,
                CHARGE]
    if which == 'poses2':
        return [BK_WIND, BK, FK_RISE, FK, HS_DOWN, HS, spin(AT_BODY, 120), HD_RAISE, HD, FOCUS_HIT, SL_WIND, SL]
    if which == 'poses3':
        return [FS_FLOAT, FS_KICK, EB_HOP, EB_STOMP, RUSH, spin(storm_pose(0), 80), spin(storm_pose(1), 160),
                FINISH, SALUTE, INTRO_OPEN, INTRO_SWEEP, WIN_FINAL]
    return [None, STANCE, FLICK, LASH, CRES, BK, EB_STOMP, FINISH]
