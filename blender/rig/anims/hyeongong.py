"""Hyeon-gong poses & clips. Character space: (side, fwd, up); side>0 = char-left. Camera sees the char's RIGHT side.
Fighting style: the immovable mountain. Open palms, shoves, grabs, stomps and slams. Every move has a long, readable
wind-up, a 'snap' into the hit, a big follow-through and a heavy 'inout' settle back to the rooted stance.

Hand twist convention (fingers-up palms): hand_L twist +90 / hand_R twist -90 turns the palm to face forward."""
import math
from mathutils import Vector

from ..pose import P
from .common import base_clips, clip, nudge, with_body_drop, tuck, idle, walk, spin_pose

A = 0.092              # ankle height (H * 0.047): planted foot target height
UP = (0.0, 0.15, 1.0)  # fingers-up hand direction

STANCE = {
    'hips': {'loc': (0.0, -0.03, -0.17), 'rot': (4, 0, -24)},
    'spine': (2, 0, -4),
    'chest': (0, 2, -6),
    'neck': (-2, 0, 14),
    'head': (-4, 0, 18),
    'shoulder_L': (2, 6),
    'shoulder_R': (2, 2),
    'hand_L': {'pos': (0.08, 0.60, 1.38), 'pole': (0.8, -0.3, -1.0), 'dir': (0.05, 0.35, 1.0), 'twist': 55},
    'hand_R': {'pos': (-0.03, 0.36, 1.30), 'pole': (-0.5, -0.2, -1.0), 'dir': (0.15, 0.3, 1.0), 'twist': -35},
    'foot_L': {'pos': (0.19, 0.34, A), 'yaw': 14, 'pole': (0.4, 1.0, 0.0), 'pitch': 0},
    'foot_R': {'pos': (-0.25, -0.30, A), 'yaw': -42, 'pole': (-1.0, 0.5, 0.0), 'pitch': 0},
}
# NOTE pose._lerp holds a dict key that exists in only one of two blended poses (no blend toward a default), so every
# pose here carries the full key set: hands always have dir + twist, feet always have pitch.
S = STANCE
# Walk cycles slide each foot +-0.30 m around its stance spot: use a narrower, deeper stance so the legs never overreach.
S_WALK = P(STANCE, hips={'loc': (0.0, -0.01, -0.19), 'rot': (4, 0, -24)},
           foot_L={'pos': (0.17, 0.20, A), 'yaw': 14, 'pole': (0.4, 1.0, 0.0)},
           foot_R={'pos': (-0.23, -0.17, A), 'yaw': -42, 'pole': (-1.0, 0.5, 0.0)})


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


def hL(pos, pole=(0.8, -0.3, -1.0), **kw):
    return dict(pos=pos, pole=pole, **kw)


def hR(pos, pole=(-0.8, -0.3, -1.0), **kw):
    return dict(pos=pos, pole=pole, **kw)


def fL(pos, yaw=14, pole=(0.4, 1.0, 0.0), **kw):
    return dict(pos=pos, yaw=yaw, pole=pole, **kw)


def fR(pos, yaw=-42, pole=(-1.0, 0.5, 0.0), **kw):
    return dict(pos=pos, yaw=yaw, pole=pole, **kw)


def palmL(pos, pole=(0.6, 0.0, -1.0), twist=88, d=UP):
    return hL(pos, pole=pole, dir=d, twist=twist)


def palmR(pos, pole=(-0.6, 0.0, -1.0), twist=-88, d=UP):
    return hR(pos, pole=pole, dir=d, twist=twist)


def tremble(pose, f, amp=0.005):
    t = amp * math.sin(f * 2.3)
    return nudge(pose, hips_loc=(t, 0, t * 0.5), all_hands=(t, 0, t))


# ---------------------------------------------------------------- strikes (J)
S1_PULL = body(hips_loc=(0, -0.05, -0.19), hips_rot=(4, 0, -20), chest=(0, 2, -4),
               hand_L=palmL((0.12, 0.36, 1.34), twist=70))
S1 = body(hips_loc=(0, 0.08, -0.20), hips_rot=(6, 0, -36), spine=(2, 0, -6), chest=(4, 0, -12), neck=(-4, 0, 24),
          head=(-6, 0, 28), hand_L=palmL((0.04, 0.86, 1.40), pole=(0.6, 0.0, -1.0)),
          hand_R=hR((-0.02, 0.28, 1.24), pole=(-0.6, -0.2, -1.0), dir=UP, twist=-40), foot_L=fL((0.19, 0.42, A)))
S1_FOL = body(base=S1, hips_loc=(0, 0.09, -0.21), hand_L=palmL((0.04, 0.88, 1.38), pole=(0.6, 0.0, -1.0)))

S2_WIND = body(hips_loc=(0, -0.04, -0.18), hips_rot=(2, 0, 4), spine=(0, 0, 6), chest=(-2, -4, 14), neck=(-2, 0, -2),
               head=(-4, 0, 0), hand_R=hR((0.14, 0.18, 1.64), pole=(-0.2, 0.8, 0.2), dir=(0.4, 0.3, 0.8)),
               hand_L=hL((0.18, 0.40, 1.30), dir=UP, twist=50))
S2 = body(hips_loc=(0, 0.08, -0.20), hips_rot=(6, 0, -42), spine=(2, 0, -8), chest=(6, -4, -22), neck=(-6, 0, 32),
          head=(-6, 0, 36), hand_R=hR((-0.26, 0.76, 1.44), pole=(-1.0, 0.2, 0.3), dir=(-0.4, 0.8, -0.3)),
          hand_L=hL((0.16, 0.22, 1.26), dir=UP, twist=50), foot_L=fL((0.19, 0.40, A)))
S2_FOL = body(base=S2, hips_rot=(6, 0, -52), chest=(6, -4, -30),
              hand_R=hR((-0.46, 0.50, 1.30), pole=(-1.0, -0.4, 0.3), dir=(-0.8, 0.3, -0.4)))

S3_WIND = body(hips_loc=(0, -0.10, -0.23), hips_rot=(-2, 0, -12), spine=(-2, 0, -2), chest=(-8, 0, -2), neck=(0, 0, 8),
               head=(-2, 0, 10), hand_L=palmL((0.24, 0.14, 1.32), pole=(1.0, -0.4, -0.6), twist=80),
               hand_R=palmR((-0.24, 0.10, 1.28), pole=(-1.0, -0.4, -0.6), twist=-80))
S3 = body(hips_loc=(0, 0.16, -0.22), hips_rot=(12, 0, -4), spine=(4, 0, 0), chest=(8, 0, -2), neck=(-8, 0, 4),
          head=(-10, 0, 4), hand_L=palmL((0.15, 0.88, 1.38)), hand_R=palmR((-0.15, 0.88, 1.28)),
          foot_L=fL((0.19, 0.50, A)), foot_R=fR((-0.25, -0.22, A), yaw=-30))
S3_FOL = body(base=S3, hips_loc=(0, 0.19, -0.25), hips_rot=(14, 0, -4),
              hand_L=palmL((0.15, 0.92, 1.34)), hand_R=palmR((-0.15, 0.92, 1.24)))

SF_WIND = body(hips_loc=(0, -0.10, -0.27), hips_rot=(12, 0, -52), spine=(4, 0, -8), chest=(8, 2, -10), neck=(-4, 0, 34),
               head=(-10, 0, 40), hand_R=hR((-0.12, 0.08, 1.08), pole=(-0.6, -0.6, -0.6)),
               hand_L=hL((0.20, 0.34, 1.26), dir=UP, twist=50))
SF = body(hips_loc=(0, 0.36, -0.22), hips_rot=(18, 0, 22), spine=(6, 0, 6), chest=(10, -6, 8), neck=(-10, 0, -16),
          head=(-14, 0, -20), shoulder_R=(-4, 22), hand_R=hR((0.02, 0.34, 1.16), pole=(-0.6, 1.0, -0.4)),
          hand_L=hL((0.20, 0.40, 1.24), pole=(1.0, 0.2, -0.6)),
          foot_L=fL((0.20, 0.60, A), yaw=10), foot_R=fR((-0.25, -0.12, A), yaw=-10))
SF_FOL = body(base=SF, hips_loc=(0, 0.40, -0.25), hips_rot=(20, 0, 25))

SU_LOW = body(hips_loc=(0, -0.02, -0.32), hips_rot=(16, 0, -30), spine=(6, 0, -4), chest=(12, 0, -6), neck=(-6, 0, 20),
              head=(-16, 0, 24), hand_R=hR((-0.16, 0.22, 0.80), pole=(-1.0, -0.2, -0.2), dir=(0.1, 0.6, 0.6), twist=-60),
              hand_L=hL((0.16, 0.44, 1.30), dir=UP, twist=50))
SU = body(hips_loc=(0, 0.12, -0.10), hips_rot=(-6, 0, 4), spine=(-6, 0, 4), chest=(-10, -4, 8), neck=(-10, 0, -6),
          head=(-16, 0, -8), shoulder_R=(6, 10), hand_R=hR((-0.05, 0.50, 1.92), pole=(-1.0, -0.3, 0.0), dir=(0.0, 0.25, 1.0), twist=-80),
          hand_L=hL((0.18, 0.22, 1.24), dir=UP, twist=50), foot_R=fR((-0.24, -0.22, 0.17), yaw=-25, pitch=22))
SU_FOL = body(base=SU, hips_loc=(0, 0.13, -0.09), hand_R=hR((-0.06, 0.44, 1.98), pole=(-1.0, -0.3, 0.0), dir=(0, 0.1, 1),
                                                           twist=-80))

SD_WIND = body(hips_loc=(0, -0.06, -0.24), hips_rot=(10, 0, -42), chest=(6, 0, -8), head=(-8, 0, 30),
               hand_R=hR((-0.26, -0.10, 1.02), pole=(-0.6, -1.0, -0.2), dir=(0, 0.5, 0.6)),
               hand_L=hL((0.18, 0.46, 1.30), dir=UP, twist=50))
SD = body(hips_loc=(0, 0.14, -0.40), hips_rot=(30, 0, 6), spine=(8, 0, 4), chest=(12, -4, 8), neck=(-12, 0, -2),
          head=(-26, 0, -4), hand_R=hR((-0.06, 0.80, 0.50), pole=(-1.0, 0.0, 0.2), dir=(0.0, 0.5, -1.0), twist=-90),
          hand_L=hL((0.22, 0.42, 1.10), dir=UP, twist=50),
          foot_L=fL((0.21, 0.50, A)), foot_R=fR((-0.26, -0.32, A)))
SD_FOL = body(base=SD, hips_loc=(0, 0.15, -0.42), hand_R=hR((-0.06, 0.82, 0.46), pole=(-1.0, 0.0, 0.2),
                                                            dir=(0.0, 0.5, -1.0), twist=-90))

SAIR_PREP = body(base=tuck(S, 1.0), hips_rot=(-8, 0, -10), chest=(-6, 0, -4), shoulder_R=(12, 0),
                 hand_R=hR((-0.20, 0.02, 1.86), pole=(-0.4, 0.2, 1.0)), hand_L=hL((0.18, 0.30, 1.40), dir=UP, twist=50))
SAIR = body(base=tuck(S, 1.0), hips_loc=(0, 0.06, 0.02), hips_rot=(26, 0, 12), spine=(8, 0, 4), chest=(14, 0, 8),
            neck=(-14, 0, -8), head=(-22, 0, -10), hand_R=hR((0.00, 0.08, 1.28), pole=(-0.2, 1.0, -1.0)),
            hand_L=hL((0.10, 0.12, 1.26), pole=(1.0, 0.0, -0.5)))

# ---------------------------------------------------------------- heavies (K)
H_WIND = body(hips_loc=(0, -0.10, -0.25), hips_rot=(6, 0, -56), spine=(2, 0, -10), chest=(-2, 4, -14), neck=(-2, 0, 36),
              head=(-6, 0, 40), hand_R=hR((-0.28, -0.22, 1.08), pole=(-0.6, -1.0, -0.3), dir=(0.0, 0.6, 0.6), twist=-60),
              hand_L=palmL((0.10, 0.64, 1.42), twist=80), foot_L=fL((0.19, 0.30, A)), foot_R=fR((-0.25, -0.34, A)))
H_HIT = body(hips_loc=(0, 0.25, -0.23), hips_rot=(10, 0, 6), spine=(4, 0, 4), chest=(6, -4, 6), neck=(-6, 0, -8),
             head=(-8, 0, -8), shoulder_R=(0, 18), hand_R=palmR((-0.06, 0.95, 1.40)),
             hand_L=hL((0.18, 0.08, 1.24), pole=(1.0, -0.2, -0.6), dir=UP, twist=40),
             foot_L=fL((0.20, 0.56, A)), foot_R=fR((-0.24, -0.20, A), yaw=-20))
H_FOL = body(base=H_HIT, hips_loc=(0, 0.28, -0.27), hips_rot=(12, 0, 8), hand_R=palmR((-0.06, 0.98, 1.36)))
H_SETTLE = body(base=H_HIT, hips_loc=(0, 0.20, -0.26), hips_rot=(8, 0, -2), chest=(4, -2, 0), shoulder_R=(0, 8),
                hand_R=palmR((-0.04, 0.78, 1.30)))

HF_WIND = body(hips_loc=(0, -0.12, -0.20), hips_rot=(-10, 0, -10), spine=(-6, 0, 0), chest=(-14, 0, 0), neck=(-10, 0, 4),
               head=(-20, 0, 6), hand_L=hL((0.46, 0.26, 1.42), pole=(1.0, -0.5, -0.2), dir=(0.4, 0.6, 0.6)),
               hand_R=hR((-0.46, 0.20, 1.40), pole=(-1.0, -0.5, -0.2), dir=(-0.4, 0.6, 0.6)))
HF_HIT = body(hips_loc=(0, 0.42, -0.20), hips_rot=(24, 0, -8), spine=(10, 0, 0), chest=(16, 0, 0), neck=(14, 0, 0),
              head=(18, 0, 8), hand_L=hL((0.24, 0.78, 1.48), pole=(1.0, 0.0, -0.4), dir=(0, 1, 0)),
              hand_R=hR((-0.24, 0.74, 1.46), pole=(-1.0, 0.0, -0.4), dir=(0, 1, 0)),
              foot_L=fL((0.20, 0.68, A)), foot_R=fR((-0.25, -0.10, A), yaw=-20))
HF_FOL = body(base=HF_HIT, hips_loc=(0, 0.45, -0.24), neck=(18, 0, 0), head=(22, 0, 8))

HD_LIFT = body(hips_loc=(0.04, 0.14, -0.08), hips_rot=(-4, 4, -22), spine=(-2, 0, -4), chest=(-8, 0, -4), neck=(-4, 0, 14),
               head=(-8, 0, 18), shoulder_L=(12, 0), shoulder_R=(12, 0),
               foot_R=fR((-0.24, 0.10, 0.74), yaw=-30, pole=(-0.4, 1.0, 0.4), pitch=-10),
               hand_L=hL((0.58, 0.20, 1.72), pole=(1.0, 0.0, -0.4), dir=(0.6, 0.2, 0.8)),
               hand_R=hR((-0.58, 0.08, 1.70), pole=(-1.0, 0.0, -0.4), dir=(-0.6, 0.2, 0.8)))
HD_DROP = body(base=HD_LIFT, hips_loc=(0.02, 0.10, -0.20), shoulder_L=(6, 0), shoulder_R=(6, 0), foot_R=fR((-0.30, 0.0, 0.32), yaw=-40, pole=(-0.5, 1.0, 0.2)),
               hand_L=hL((0.48, 0.30, 1.40), pole=(1.0, 0.0, -0.4)), hand_R=hR((-0.48, 0.20, 1.38), pole=(-1.0, 0.0, -0.4)))
HD_STOMP = body(hips_loc=(0, 0.06, -0.36), hips_rot=(14, 0, -20), spine=(6, 0, 0), chest=(10, 0, -4), neck=(-6, 0, 14),
                head=(-14, 0, 18), shoulder_L=(-4, 6), shoulder_R=(-4, 6), foot_R=fR((-0.34, -0.06, A), yaw=-50),
                hand_L=hL((0.34, 0.42, 0.96), pole=(1.0, 0.0, 0.2), dir=(0.1, 1.0, -0.2), twist=90),
                hand_R=hR((-0.36, 0.30, 0.92), pole=(-1.0, 0.0, 0.2), dir=(-0.1, 1.0, -0.2), twist=-90))
HD_BOUNCE = nudge(HD_STOMP, hips_loc=(0, 0, 0.03), all_hands=(0, 0, 0.03))

HAIR_PREP = body(base=tuck(S, 1.0), hips_rot=(-14, 0, 0), spine=(-4, 0, 0), chest=(-10, 0, 0), head=(-6, 0, 0),
                 shoulder_L=(14, 0), shoulder_R=(14, 0),
                 hand_L=hL((0.32, -0.06, 1.84), pole=(1.0, 0.0, 0.4), dir=(0.2, -0.2, 1.0)),
                 hand_R=hR((-0.32, -0.08, 1.84), pole=(-1.0, 0.0, 0.4), dir=(-0.2, -0.2, 1.0)))
HAIR = body(base=tuck(S, 1.0), hips_loc=(0, 0.12, 0.02), hips_rot=(48, 0, 0), spine=(6, 0, 0), chest=(8, 0, 0),
            neck=(-20, 0, 0), head=(-24, 0, 0),
            hand_L=hL((0.38, 0.80, 0.98), pole=(1.0, 0.0, 0.3), dir=(0.2, 1.0, -0.6), twist=90),
            hand_R=hR((-0.38, 0.78, 0.96), pole=(-1.0, 0.0, 0.3), dir=(-0.2, 1.0, -0.6), twist=-90),
            foot_L=fL((0.15, -0.30, 0.55), pole=(0.2, 1.0, -0.6)), foot_R=fR((-0.15, -0.40, 0.66), pole=(-0.2, 1.0, -0.6)))

HAD_PREP = body(base=tuck(S, 1.2), hips_loc=(0, 0.0, 0.12), hips_rot=(-6, 0, 0), chest=(-6, 0, 0),
                shoulder_L=(14, 2), shoulder_R=(14, 2),
                hand_L=hL((0.26, 0.04, 2.00), pole=(1.0, 0.0, 0.0), dir=(0, 0, 1)),
                hand_R=hR((-0.26, 0.04, 2.00), pole=(-1.0, 0.0, 0.0), dir=(0, 0, 1)),
                foot_L=fL((0.16, 0.26, 0.58), pole=(0.2, 1.0, 0.6)), foot_R=fR((-0.16, 0.22, 0.56), pole=(-0.2, 1.0, 0.6)))
# butt drop: hips sit at root height so the seat (not the feet) is what touches down on landing
HAD = body(base=S, hips_loc=(0, -0.06, -0.33), hips_rot=(-26, 0, 0), spine=(4, 0, 0), chest=(14, 0, 0), neck=(6, 0, 0),
           head=(10, 0, 0), hand_L=hL((0.48, 0.12, 1.29), pole=(1.0, 0.0, -0.4), dir=(0.6, 0.2, 0.6)),
           hand_R=hR((-0.48, 0.10, 1.29), pole=(-1.0, 0.0, -0.4), dir=(-0.6, 0.2, 0.6)),
           foot_L=fL((0.20, 0.58, 0.17), yaw=10, pole=(0.3, 0.0, 1.0), pitch=-20),
           foot_R=fR((-0.20, 0.54, 0.13), yaw=-10, pole=(-0.3, 0.0, 1.0), pitch=-20))

# ---------------------------------------------------------------- focus (charged)
CHARGE = body(hips_loc=(0, -0.04, -0.31), hips_rot=(6, 0, -28), spine=(0, 0, -2), chest=(-4, 0, -4), neck=(0, 0, 18),
              head=(-4, 0, 22), hand_L=hL((0.12, 0.34, 1.04), pole=(1.0, -0.2, -0.6), dir=(-0.3, 0.4, 0.4), twist=40),
              hand_R=hR((-0.10, 0.32, 1.26), pole=(-1.0, -0.2, -0.4), dir=(0.4, 0.4, -0.3), twist=-150),
              foot_L=fL((0.27, 0.30, A), yaw=22), foot_R=fR((-0.31, -0.30, A), yaw=-52))
FR_HIT = body(hips_loc=(0, 0.22, -0.27), hips_rot=(8, 0, -4), spine=(2, 0, 0), chest=(6, 0, 0), neck=(-6, 0, 4),
              head=(-8, 0, 6), hand_L=palmL((0.10, 0.92, 1.48)), hand_R=palmR((-0.10, 0.92, 1.14)),
              foot_L=fL((0.25, 0.52, A), yaw=16), foot_R=fR((-0.30, -0.22, A), yaw=-40))
FR_FOL = body(base=FR_HIT, hips_loc=(0, 0.25, -0.30), hand_L=palmL((0.10, 0.96, 1.46)), hand_R=palmR((-0.10, 0.96, 1.12)))

# ---------------------------------------------------------------- qi arts
PRAY_HANDS = dict(hand_L=hL((0.026, 0.30, 1.29), pole=(1.0, -0.2, -1.0), dir=(0, 0.12, 1)),
                  hand_R=hR((-0.026, 0.30, 1.29), pole=(-1.0, -0.2, -1.0), dir=(0, 0.12, 1)))
DIAMOND = body(hips_loc=(0, -0.03, -0.21), hips_rot=(2, 0, -14), spine=(-2, 0, -2), chest=(-6, 0, -4), neck=(-2, 0, 8),
               head=(2, 0, 10), foot_L=fL((0.22, 0.28, A), yaw=20), foot_R=fR((-0.27, -0.24, A), yaw=-44),
               **PRAY_HANDS)
DIAMOND_B = nudge(DIAMOND, hips_loc=(0, 0, -0.025), chest=(-3, 0, 0), all_hands=(0, 0, -0.02))
CT_PULL = body(base=DIAMOND, hips_rot=(4, 0, -30), chest=(-4, 0, -10),
               hand_R=hR((-0.16, 0.16, 1.36), pole=(-1.0, -0.3, -0.6), dir=UP, twist=-70))
CT_HIT = body(hips_loc=(0, 0.20, -0.22), hips_rot=(8, 0, 6), spine=(4, 0, 4), chest=(6, -4, 6), neck=(-6, 0, -8),
              head=(-8, 0, -8), shoulder_R=(0, 18), hand_R=palmR((-0.06, 0.94, 1.40)),
              hand_L=hL((0.06, 0.34, 1.30), pole=(1.0, -0.2, -1.0), dir=(0, 0.12, 1)),
              foot_L=fL((0.22, 0.46, A), yaw=16), foot_R=fR((-0.26, -0.18, A), yaw=-24))
CT_FOL = body(base=CT_HIT, hips_loc=(0, 0.23, -0.25), hand_R=palmR((-0.06, 0.97, 1.36)))

AF_WIND = body(hips_loc=(0, -0.10, -0.27), hips_rot=(12, 0, -20), spine=(4, 0, 0), chest=(10, 0, -2), neck=(-6, 0, 10),
               head=(-14, 0, 14), hand_L=hL((0.44, 0.12, 1.12), pole=(1.0, -0.6, 0.0), dir=(0.3, 0.6, 0.2)),
               hand_R=hR((-0.44, 0.06, 1.10), pole=(-1.0, -0.6, 0.0), dir=(-0.3, 0.6, 0.2)))
AF_HIT = body(hips_loc=(0, 0.32, -0.23), hips_rot=(16, 0, -6), spine=(6, 0, 0), chest=(8, 0, 0), neck=(-8, 0, 2),
              head=(-12, 0, 4), hand_L=hL((0.19, 0.88, 1.44), pole=(1.0, 0.0, -0.3), dir=(-0.1, 1.0, 0.1), twist=60),
              hand_R=hR((-0.17, 0.88, 1.38), pole=(-1.0, 0.0, -0.3), dir=(0.1, 1.0, 0.1), twist=-60),
              foot_L=fL((0.20, 0.62, A)), foot_R=fR((-0.25, -0.14, A), yaw=-24))
AF_MISS = body(base=AF_HIT, hips_loc=(0, 0.28, -0.30), hips_rot=(22, 0, -6), chest=(14, 0, 0),
               hand_L=hL((0.16, 0.70, 1.04), pole=(1.0, 0.0, -0.3)), hand_R=hR((-0.16, 0.66, 1.00), pole=(-1.0, 0.0, -0.3)))

TH_GRIP = body(base=AF_HIT, hips_loc=(0, 0.30, -0.26), hand_L=hL((0.13, 0.74, 1.40), pole=(1.0, 0.0, -0.3), dir=(-0.4, 1.0, 0)),
               hand_R=hR((-0.13, 0.74, 1.34), pole=(-1.0, 0.0, -0.3), dir=(0.4, 1.0, 0)))
TH_LIFT = body(hips_loc=(0, 0.12, -0.27), hips_rot=(-4, 0, -8), spine=(-4, 0, 0), chest=(-12, 0, 0), neck=(-6, 0, 6),
               head=(-14, 0, 8), shoulder_L=(8, 8), shoulder_R=(8, 8), hand_L=hL((0.17, 0.46, 1.84), pole=(1.0, 0.2, -0.6), dir=(0, 0.3, 1)),
               hand_R=hR((-0.17, 0.44, 1.80), pole=(-1.0, 0.2, -0.6), dir=(0, 0.3, 1)),
               foot_L=fL((0.21, 0.48, A)), foot_R=fR((-0.26, -0.20, A), yaw=-30))
TH_OVER = body(hips_loc=(0, 0.06, -0.13), hips_rot=(-8, 0, -8), spine=(-4, 0, 0), chest=(-14, 0, 0), neck=(-8, 0, 6),
               head=(-20, 0, 8), shoulder_L=(16, 4), shoulder_R=(16, 4), hand_L=hL((0.17, 0.02, 1.97), pole=(1.0, 0.0, -0.2), dir=(0, 0, 1)),
               hand_R=hR((-0.17, 0.00, 1.95), pole=(-1.0, 0.0, -0.2), dir=(0, 0, 1)),
               foot_L=fL((0.21, 0.36, A)), foot_R=fR((-0.26, -0.22, A), yaw=-30))
TH_SWING = body(base=TH_OVER, hips_loc=(0, 0.16, -0.22), hips_rot=(12, 0, -4), chest=(4, 0, 0), head=(-10, 0, 4),
                hand_L=hL((0.18, 0.62, 1.64), pole=(1.0, 0.0, -0.2), dir=(0, 1, 0.2)),
                hand_R=hR((-0.18, 0.60, 1.62), pole=(-1.0, 0.0, -0.2), dir=(0, 1, 0.2)), foot_L=fL((0.21, 0.50, A)))
TH_SLAM = body(hips_loc=(0, 0.26, -0.37), hips_rot=(36, 0, 0), spine=(10, 0, 0), chest=(16, 0, 0), neck=(-10, 0, 0),
               head=(-28, 0, 0), hand_L=hL((0.18, 0.94, 0.42), pole=(1.0, 0.0, 0.3), dir=(0, 0.6, -1)),
               hand_R=hR((-0.18, 0.94, 0.40), pole=(-1.0, 0.0, 0.3), dir=(0, 0.6, -1)),
               foot_L=fL((0.22, 0.54, A)), foot_R=fR((-0.26, -0.20, A), yaw=-30))

AD_RAISE = body(hips_loc=(0, 0.02, -0.12), hips_rot=(-8, 0, -10), spine=(-6, 0, 0), chest=(-12, 0, 0), neck=(-6, 0, 8),
                head=(-12, 0, 10), shoulder_L=(16, 4), shoulder_R=(16, 4), hand_L=hL((0.03, -0.02, 1.95), pole=(1.0, 0.3, 0.0), dir=(-0.3, 0, 1)),
                hand_R=hR((-0.03, -0.02, 1.95), pole=(-1.0, 0.3, 0.0), dir=(0.3, 0, 1)))
AD_MID = body(hips_loc=(0, 0.10, -0.24), hips_rot=(20, 0, -6), spine=(6, 0, 0), chest=(6, 0, 0), head=(-14, 0, 4),
              hand_L=hL((0.04, 0.62, 1.52), pole=(1.0, 0.0, 0.2), dir=(-0.3, 1, 0)),
              hand_R=hR((-0.04, 0.62, 1.52), pole=(-1.0, 0.0, 0.2), dir=(0.3, 1, 0)))
AD_HIT = body(hips_loc=(0, 0.22, -0.41), hips_rot=(40, 0, 0), spine=(12, 0, 0), chest=(18, 0, 0), neck=(-10, 0, 0),
              head=(-26, 0, 0), hand_L=hL((0.04, 0.80, 0.30), pole=(1.0, 0.0, 0.2), dir=(-0.3, 0.3, -1)),
              hand_R=hR((-0.04, 0.80, 0.30), pole=(-1.0, 0.0, 0.2), dir=(0.3, 0.3, -1)),
              foot_L=fL((0.24, 0.42, A), yaw=18), foot_R=fR((-0.29, -0.26, A), yaw=-48))
AD_FOL = nudge(AD_HIT, hips_loc=(0, 0, -0.03), all_hands=(0, 0, -0.02))

# ---------------------------------------------------------------- secret art: Tathagata Palm
UPRIGHT = {
    'hips': {'loc': (0, 0, -0.02), 'rot': (0, 0, -10)}, 'spine': (0, 0, 0), 'chest': (-2, 0, 0), 'neck': (0, 0, 5),
    'head': (2, 0, 5), 'shoulder_L': (0, 2), 'shoulder_R': (0, 2),
    'hand_L': hL((0.026, 0.30, 1.44), pole=(1.0, -0.2, -1.0), dir=(0, 0.12, 1), twist=0),
    'hand_R': hR((-0.026, 0.30, 1.44), pole=(-1.0, -0.2, -1.0), dir=(0, 0.12, 1), twist=0),
    'foot_L': fL((0.14, 0.05, A), yaw=10, pitch=0), 'foot_R': fR((-0.14, -0.05, A), yaw=-14, pole=(-0.4, 1.0, 0.0),
                                                              pitch=0),
}
BOW = body(base=UPRIGHT, hips_rot=(10, 0, -10), spine=(8, 0, 0), chest=(10, 0, 0), neck=(10, 0, 0), head=(16, 0, 0),
           hand_L=hL((0.026, 0.40, 1.28), pole=(1.0, -0.2, -1.0), dir=(0, 0.5, 1)),
           hand_R=hR((-0.026, 0.40, 1.28), pole=(-1.0, -0.2, -1.0), dir=(0, 0.5, 1)))
PRAY = body(base=DIAMOND, hips_loc=(0, -0.03, -0.16), chest=(-4, 0, -4), neck=(6, 0, 6), head=(12, 0, 8))
PRAY_GATHER = body(base=DIAMOND, hips_loc=(0, -0.05, -0.12), spine=(-4, 0, -2), chest=(-10, 0, -4), neck=(-4, 0, 8),
                   head=(-8, 0, 10), hand_L=hL((0.026, 0.28, 1.38), pole=(1.0, -0.2, -1.0), dir=(0, 0.12, 1)),
                   hand_R=hR((-0.026, 0.28, 1.38), pole=(-1.0, -0.2, -1.0), dir=(0, 0.12, 1)))
SEC_WIND = body(base=PRAY_GATHER, hips_rot=(2, 0, -26), chest=(-10, 0, -10), shoulder_R=(10, 0),
                hand_R=hR((-0.22, 0.06, 1.74), pole=(-1.0, -0.2, 0.0), dir=(0, 0.2, 1), twist=-90))
SEC_HIT = body(hips_loc=(0, 0.18, -0.24), hips_rot=(14, 0, 4), spine=(4, 0, 4), chest=(8, -4, 4), neck=(-4, 0, -6),
               head=(-8, 0, -6), shoulder_R=(0, 16),
               hand_R=hR((-0.06, 0.92, 1.18), pole=(-1.0, 0.0, -0.3), dir=(0, 0.8, 0.6), twist=-90),
               hand_L=hL((0.07, 0.32, 1.30), pole=(1.0, -0.2, -1.0), dir=(0, 0.12, 1)),
               foot_L=fL((0.22, 0.46, A), yaw=16), foot_R=fR((-0.27, -0.22, A), yaw=-30))
SEC_PRESS = body(base=SEC_HIT, hips_loc=(0, 0.19, -0.27), hips_rot=(16, 0, 4),
                 hand_R=hR((-0.06, 0.92, 1.10), pole=(-1.0, 0.0, -0.3), dir=(0, 0.8, 0.5), twist=-90))
SEC_FINISH = body(base=SEC_HIT, hips_loc=(0, 0.24, -0.38), hips_rot=(24, 0, 4), spine=(8, 0, 2), chest=(12, -4, 2),
                  head=(-20, 0, -6), hand_R=hR((-0.06, 0.94, 0.82), pole=(-1.0, 0.0, -0.2), dir=(0, 0.9, 0.3), twist=-90),
                  foot_L=fL((0.24, 0.48, A), yaw=18))

# ---------------------------------------------------------------- intro / win
WIN_A = body(base=UPRIGHT, head=(10, 0, 4), neck=(4, 0, 4))
WIN_B = body(base=BOW, hips_rot=(5, 0, -10), spine=(4, 0, 0), chest=(5, 0, 0), neck=(6, 0, 0), head=(10, 0, 0),
             hand_L=hL((0.026, 0.36, 1.36), pole=(1.0, -0.2, -1.0), dir=(0, 0.3, 1)),
             hand_R=hR((-0.026, 0.36, 1.36), pole=(-1.0, -0.2, -1.0), dir=(0, 0.3, 1)))
WIN_FINAL = body(base=UPRIGHT, chest=(-4, 0, 0), neck=(6, 0, 4), head=(12, 0, 4),
                 hand_L=hL((0.026, 0.32, 1.42), pole=(1.0, -0.2, -1.0), dir=(0, 0.12, 1)),
                 hand_R=hR((-0.026, 0.32, 1.42), pole=(-1.0, -0.2, -1.0), dir=(0, 0.12, 1)))

# ---------------------------------------------------------------- defence (override of the generic guard)
GUARD = body(hips_loc=(0, -0.05, -0.21), hips_rot=(6, 0, -18), chest=(8, 0, -2), neck=(0, 0, 10), head=(4, 0, 12),
             hand_L=palmL((0.10, 0.38, 1.60), pole=(1.0, -0.2, -0.6), twist=80),
             hand_R=palmR((-0.06, 0.32, 1.44), pole=(-1.0, -0.2, -0.6), twist=-80))
GUARD_HIT = nudge(GUARD, hips_loc=(0, -0.05, -0.02), chest=(-5, 0, 0), head=(-5, 0, 0), all_hands=(0, -0.04, 0.0))


# ---------------------------------------------------------------- knockdown family (generic poses re-fit to his bulk)
def _lying_family():
    """common.reaction_clips' knockdown/down/getup, re-fit: his thick torso sank ~3 cm and the generic toes-down
    lying feet sank ~14 cm into the floor."""
    air = P(nudge(S, hips_loc=(0, -0.05, 0.05), hips_rot=(-35, 0, 0), chest=(-20, 0, 0), head=(-20, 0, 0)),
            hand_L={'pos': (0.30, -0.30, 1.40), 'pole': (1, 0, 0)}, hand_R={'pos': (-0.30, -0.35, 1.45), 'pole': (-1, 0, 0)},
            foot_L={'pos': (0.08, 0.35, 0.35), 'pole': (0, 1, 1)}, foot_R={'pos': (-0.10, 0.20, 0.20), 'pole': (0, 1, 1)})
    falling = P(S, hips={'loc': (0.0, -0.32, -0.42), 'rot': (-55, 0, 0)}, chest=(-10, 0, 0), head=(-10, 0, 0),
                hand_L={'pos': (0.40, -0.60, 0.75), 'pole': (1, 0, 0)}, hand_R={'pos': (-0.40, -0.65, 0.70), 'pole': (-1, 0, 0)},
                foot_L={'pos': (0.12, 0.40, 0.28), 'pole': (0, 1, 1), 'pitch': -20},
                foot_R={'pos': (-0.14, 0.25, 0.16), 'pole': (0, 1, 1), 'pitch': -20})
    lying = P(S, hips={'loc': (0.0, -0.52, -0.795), 'rot': (-86, 0, 0)}, spine=(0, 0, 0), chest=(4, 0, 0),
              neck=(10, 0, 0), head=(14, 0, 18),
              hand_L={'pos': (0.42, -0.86, 0.13), 'pole': (1, 0, 0.5), 'dir': (0.2, -0.3, -0.3), 'twist': 0},
              hand_R={'pos': (-0.42, -0.90, 0.13), 'pole': (-1, 0, 0.5), 'dir': (-0.2, -0.3, -0.3), 'twist': 0},
              foot_L={'pos': (0.16, 0.30, 0.13), 'pole': (0.3, 0, 1), 'pitch': -40, 'yaw': 20},
              foot_R={'pos': (-0.17, 0.24, 0.15), 'pole': (-0.3, 0, 1), 'pitch': -35, 'yaw': -20})
    knees_up = P(lying, hips={'loc': (0.0, -0.47, -0.77), 'rot': (-100, 0, 0)},
                 foot_L={'pos': (0.14, -0.06, 0.72), 'pole': (0, -1, 1), 'pitch': 0},
                 foot_R={'pos': (-0.14, -0.11, 0.67), 'pole': (0, -1, 1), 'pitch': 0},
                 hand_L={'pos': (0.24, -0.78, 0.13), 'pole': (1, 0, 0.5)}, hand_R={'pos': (-0.24, -0.80, 0.13), 'pole': (-1, 0, 0.5)})
    crouch_up = nudge(with_body_drop(S, -0.28), hips_rot=(20, 0, 0), chest=(10, 0, 0), head=(-20, 0, 0))
    return {
        'knockdown': clip([(0, air, 'lin'), (8, falling, 'in'), (14, lying, 'in'), (17, nudge(lying, hips_loc=(0, 0, 0.05)), 'out'),
                           (22, lying, 'in')], 22),
        'down': clip([(0, lying, 'lin'), (40, nudge(lying, chest=(2, 0, 0)), 'inout')], 40, loop=False),
        'getup': clip([(0, lying, 'lin'), (8, knees_up, 'out'), (14, crouch_up, 'snap'), (24, S, 'inout')], 24),
    }


def clips():
    c = base_clips(S, speeds=(1.4, 1.2), charge_pose=CHARGE)
    I = 'inout'
    c.update(_lying_family())
    # heavier, higher-arcing somersault (the generic one dips his big frame below the root mid-flip)
    spin = []
    for f in range(0, 25, 2):
        ang = 360 * min(1.0, f / 22) ** 0.8
        lift = 0.12 * math.sin(math.pi * min(1.0, f / 22)) + 0.25 * math.sin(math.radians(ang))
        spin.append((f, spin_pose(tuck(S, 1.2), ang, lift), 'lin'))
    c['jump2'] = clip(spin, 24)
    c['idle'] = idle(S, length=90, breath=0.016, sway=1.2)
    c['walk_f'] = walk(S_WALK, 1.4, 26, forward=True, lift=0.07, bob=0.025)
    c['walk_b'] = walk(S_WALK, 1.2, 30, forward=False, lift=0.07, bob=0.025)
    c['guard'] = clip([(0, S, 'lin'), (5, GUARD, 'out')], 5)
    c['guard_hit'] = clip([(0, GUARD, 'lin'), (2, GUARD_HIT, 'snap'), (12, GUARD, I)], 12)

    c['s1'] = clip([(0, S, 'lin'), (4, S1_PULL, 'out'), (7, S1, 'snap'), (11, S1_FOL, 'lin'), (23, S, I)], 23,
                   events={'hit': 7})
    c['s2'] = clip([(0, S, 'lin'), (5, S2_WIND, 'out'), (9, S2, 'snap'), (14, S2_FOL, 'out'), (28, S, I)], 28,
                   events={'hit': 9})
    c['s3'] = clip([(0, S, 'lin'), (8, S3_WIND, 'out'), (12, S3, 'snap'), (18, S3_FOL, 'out'), (36, S, I)], 36,
                   events={'hit': 12})
    c['s_f'] = clip([(0, S, 'lin'), (9, SF_WIND, 'out'), (14, SF, 'snap'), (21, SF_FOL, 'out'), (40, S, I)], 40,
                    events={'hit': 14})
    c['s_u'] = clip([(0, S, 'lin'), (7, SU_LOW, 'out'), (11, SU, 'snap'), (18, SU_FOL, 'out'), (39, S, I)], 39,
                    events={'hit': 11})
    c['s_d'] = clip([(0, S, 'lin'), (7, SD_WIND, 'out'), (11, SD, 'snap'), (17, SD_FOL, 'out'), (35, S, I)], 35,
                    events={'hit': 11})
    c['s_air'] = clip([(0, tuck(S), 'lin'), (5, SAIR_PREP, 'out'), (8, SAIR, 'snap'), (15, SAIR, 'lin'),
                       (26, tuck(S), I)], 26, events={'hit': 8})

    c['h'] = clip([(0, S, 'lin'), (11, H_WIND, 'out'), (15, H_WIND, 'lin'), (18, H_HIT, 'snap'), (26, H_FOL, 'out'),
                   (34, H_SETTLE, I), (47, S, I)], 47, events={'hit': 18})
    c['h_f'] = clip([(0, S, 'lin'), (11, HF_WIND, 'out'), (14, HF_WIND, 'lin'), (18, HF_HIT, 'snap'), (25, HF_FOL, 'out'),
                     (46, S, I)], 46, events={'hit': 18})
    c['h_d'] = clip([(0, S, 'lin'), (12, HD_LIFT, 'out'), (15, HD_LIFT, 'lin'), (18, HD_DROP, 'in'),
                     (20, HD_STOMP, 'snap'), (24, HD_BOUNCE, 'out'), (30, HD_STOMP, I), (49, S, I)], 49,
                    events={'hit': 20})
    c['h_air'] = clip([(0, tuck(S), 'lin'), (8, HAIR_PREP, 'out'), (12, HAIR, 'snap'), (20, HAIR, 'lin'),
                       (36, tuck(S), I)], 36, events={'hit': 12})
    c['h_air_d'] = clip([(0, tuck(S), 'lin'), (7, HAD_PREP, 'out'), (12, HAD, 'snap'), (22, HAD, 'lin')], 22,
                        events={'hit': 12})

    c['focus_release'] = clip([(0, CHARGE, 'lin'), (5, nudge(CHARGE, hips_loc=(0, -0.03, -0.02)), 'out'),
                               (8, FR_HIT, 'snap'), (16, FR_FOL, 'out'), (24, FR_FOL, 'lin'), (42, S, I)], 42,
                              events={'hit': 8})

    dk = [(0, S, 'lin'), (4, DIAMOND, 'snap'), (9, DIAMOND_B, 'out')]
    for f in range(12, 41, 4):
        dk.append((f, tremble(DIAMOND_B, f, 0.003), 'lin'))
    dk.append((54, S, I))
    c['art_n'] = clip(dk, 54, events={'hit': 4})
    c['counter'] = clip([(0, DIAMOND_B, 'lin'), (3, CT_PULL, 'out'), (6, CT_HIT, 'snap'), (12, CT_FOL, 'out'),
                         (30, S, I)], 30, events={'hit': 6})

    c['art_f'] = clip([(0, S, 'lin'), (9, AF_WIND, 'out'), (14, AF_HIT, 'snap'), (21, AF_HIT, 'lin'), (30, AF_MISS, I),
                       (48, S, I)], 48, events={'hit': 14})
    c['throw'] = clip([(0, AF_HIT, 'lin'), (6, TH_GRIP, 'snap'), (16, TH_LIFT, I), (25, TH_OVER, 'out'),
                       (32, tremble(TH_OVER, 32, 0.008), I), (36, nudge(TH_OVER, hips_loc=(0, -0.02, 0.02),
                                                                        hips_rot=(-4, 0, 0), chest=(-4, 0, 0)), 'out'),
                       (38, TH_SWING, 'in'), (40, TH_SLAM, 'snap'), (46, nudge(TH_SLAM, hips_loc=(0, 0, 0.02)), 'out'),
                       (50, TH_SLAM, I), (60, S, I)], 60, events={'hit': 6, 'slam': 40})

    c['art_d'] = clip([(0, S, 'lin'), (12, AD_RAISE, 'out'), (15, AD_RAISE, 'lin'), (18, AD_MID, 'in'),
                       (20, AD_HIT, 'snap'), (26, AD_FOL, 'out'), (32, AD_HIT, I), (52, S, I)], 52, events={'hit': 20})

    sec = [(0, S, 'lin'), (12, PRAY, I), (20, PRAY_GATHER, I), (26, SEC_WIND, 'out'), (30, SEC_HIT, 'snap'),
           (36, SEC_PRESS, 'out')]
    for f in range(42, 85, 6):
        sec.append((f, tremble(SEC_PRESS, f, 0.004), 'lin'))
    sec += [(87, SEC_PRESS, 'lin'), (90, SEC_FINISH, 'snap'), (104, SEC_FINISH, 'lin'), (120, S, I)]
    c['secret'] = clip(sec, 120, events={'hit': 30, 'finish': 90})

    c['intro'] = clip([(0, UPRIGHT, 'lin'), (10, BOW, I), (18, BOW, 'lin'), (26, UPRIGHT, I), (40, S, I)], 40)
    c['win'] = clip([(0, S, 'lin'), (16, WIN_A, I), (26, WIN_B, I), (36, WIN_A, I), (50, WIN_FINAL, I),
                     (64, WIN_FINAL, 'lin')], 64)
    return c


def _wide_game_view(preview):
    """His reach is much longer than Mu-jin's: pull the contact-sheet game camera back (same angle) for previews."""
    tgt = Vector((0.0, -0.28, 1.0))   # Blender space: -Y = character forward
    preview.VIEWS['game'] = (tgt + Vector((-3.4, -0.95, 0.25)) * 1.32, tgt)


def preview_poses(which):
    if which == 'rest':
        return [None]
    """Contact-sheet pose lists. He is 1.95 m with a long reach, so some views re-aim preview.VIEWS in-process
    (runtime only; preview.py is untouched): face (re-centred on his taller head), crown (ordination dots),
    poses*/wide/big2/big3 (pulled-back game camera), side (ground-level profile). 'wide' / 'side' are meant to be
    combined with --sheet so the clip sheet uses that camera."""
    from .. import preview
    if which.startswith('poses'):
        _wide_game_view(preview)
    if which == 'face':
        preview.VIEWS['face'] = (Vector((-0.40, -1.25, 1.70)), Vector((0, 0, 1.69)))
        return [STANCE]
    if which == 'crown':
        preview.VIEWS['game'] = (Vector((-0.9, -0.9, 2.45)), Vector((0, 0, 1.80)))
        preview.VIEWS['front'] = (Vector((0.0, -1.4, 1.95)), Vector((0, 0, 1.82)))
        return [None]
    if which == 'big':
        return [STANCE]
    if which == 'side':   # exact profile at ground level (ground-contact checks for lying / landing clips)
        preview.VIEWS['game'] = (Vector((-4.8, 0.0, 0.75)), Vector((0, 0.0, 0.72)))
        return [STANCE]
    if which == 'wide':
        _wide_game_view(preview)
        return [STANCE]
    if which == 'big2':
        _wide_game_view(preview)
        return [H_HIT, DIAMOND]
    if which == 'big3':
        _wide_game_view(preview)
        return [TH_OVER, AD_HIT]
    if which == 'poses1':
        return [S1, S2_WIND, S2, S3_WIND, S3, SF_WIND, SF, SU_LOW, SU, SD, SAIR_PREP, SAIR]
    if which == 'poses2':
        return [H_WIND, H_HIT, HF_WIND, HF_HIT, HD_LIFT, HD_STOMP, HAIR_PREP, HAIR, HAD_PREP, HAD, CHARGE, FR_HIT]
    if which == 'poses3':
        return [DIAMOND, CT_HIT, AF_WIND, AF_HIT, TH_LIFT, TH_OVER, TH_SLAM, AD_RAISE, AD_HIT, SEC_WIND, SEC_HIT,
                SEC_FINISH]
    if which == 'poses4':
        return [UPRIGHT, BOW, WIN_FINAL, GUARD, PRAY_GATHER, STANCE]
    return [None, STANCE, S1, S3, H_HIT, AD_HIT, TH_OVER, DIAMOND]
