// Mobile touch controller: floating joystick (left thumb) + thumb-arc ink buttons (right thumb).
// Writes controller bits into `touchState` (read by TouchInput). Multi-touch, slide-between-buttons, haptics.
import { IN, QI_BAR, QI_MAX } from '../sim/defs';
import { touchState } from '../input/input';
import { settings } from './settings';

interface BtnDef {
  id: string;
  bit: number;
  han: string;
  label: string;
  /** centre offset from the cluster's bottom-right anchor, in units of B (x leftwards, y upwards) */
  dx: number;
  dy: number;
  /** radius in units of B */
  r: number;
  cost?: number;
}

const BTNS: BtnDef[] = [
  { id: 'S', bit: IN.S, han: '擊', label: 'Strike', dx: 1.62, dy: 0.86, r: 0.64 },
  { id: 'H', bit: IN.H, han: '重', label: 'Heavy', dx: 0.62, dy: 1.32, r: 0.52 },
  { id: 'J', bit: IN.UP, han: '躍', label: 'Jump', dx: 0.6, dy: 2.5, r: 0.46 },
  { id: 'G', bit: IN.G, han: '守', label: 'Guard', dx: 2.88, dy: 0.62, r: 0.52 },
  { id: 'D', bit: IN.D, han: '閃', label: 'Dodge', dx: 1.68, dy: 2.12, r: 0.46 },
  { id: 'A', bit: IN.A, han: '氣', label: 'Art', dx: 2.92, dy: 1.86, r: 0.44, cost: QI_BAR },
  { id: 'X', bit: IN.X, han: '秘', label: 'Secret', dx: 1.42, dy: 3.22, r: 0.42, cost: QI_MAX },
];

interface BtnRuntime extends BtnDef {
  el: HTMLElement;
  cx: number;
  cy: number;
  rad: number;
}

let root: HTMLElement;
let btns: BtnRuntime[] = [];
let stickBits = 0;
const fingerBtn = new Map<number, BtnRuntime | null>();
let stickId: number | null = null;
let stickOrigin = { x: 0, y: 0 };
let base: HTMLElement;
let knob: HTMLElement;
let B = 72;
let visible = false;

function capture(el: HTMLElement, id: number): void {
  try {
    el.setPointerCapture(id);
  } catch {
    /* pointer no longer active */
  }
}

function vibrate(ms: number | number[]): void {
  if (!settings.haptics) return;
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* unsupported */
  }
}

function recompute(): void {
  let b = stickBits;
  for (const v of fingerBtn.values()) if (v) b |= v.bit;
  touchState.bits = b;
  for (const btn of btns) btn.el.classList.toggle('on', (b & btn.bit) !== 0 && [...fingerBtn.values()].includes(btn));
}

let probe: HTMLElement | null = null;
/** Safe-area insets (notches, home indicator) measured through a padding probe. */
function insets(): { l: number; r: number; b: number } {
  if (!probe) {
    probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;' +
      'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.appendChild(probe);
  }
  const cs = getComputedStyle(probe);
  return { l: parseFloat(cs.paddingLeft) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0 };
}

export function layoutTouch(): void {
  if (!root) return;
  const w = window.innerWidth, h = window.innerHeight;
  B = Math.max(50, Math.min(96, Math.min(w, h) * 0.21)) * (settings.touchSize || 1);
  const ins = insets();
  const anchorX = w - 14 - ins.r;
  const anchorY = h - 12 - ins.b;
  for (const b of btns) {
    b.cx = anchorX - b.dx * B;
    b.cy = anchorY - b.dy * B;
    b.rad = b.r * B;
    const d = b.rad * 2;
    Object.assign(b.el.style, { width: `${d}px`, height: `${d}px`, left: `${b.cx - b.rad}px`, top: `${b.cy - b.rad}px`, fontSize: `${Math.round(b.rad * 0.62)}px` });
  }
  const sb = B * 1.9;
  Object.assign(base.style, { width: `${sb}px`, height: `${sb}px` });
  const kb = B * 0.78;
  Object.assign(knob.style, { width: `${kb}px`, height: `${kb}px`, marginLeft: `${-kb / 2}px`, marginTop: `${-kb / 2}px` });
  if (stickId === null) restStick();
}

function restStick(): void {
  const ins = insets();
  const sb = B * 1.9;
  stickOrigin = { x: 22 + ins.l + sb / 2, y: window.innerHeight - 16 - ins.b - sb / 2 };
  placeBase();
  knob.style.transform = '';
  base.classList.remove('live');
}

function placeBase(): void {
  const sb = B * 1.9;
  base.style.left = `${stickOrigin.x - sb / 2}px`;
  base.style.top = `${stickOrigin.y - sb / 2}px`;
}

function hitButton(x: number, y: number): BtnRuntime | null {
  let best: BtnRuntime | null = null;
  let bestD = Infinity;
  for (const b of btns) {
    const d = Math.hypot(x - b.cx, y - b.cy);
    if (d < b.rad * 1.22 && d / b.rad < bestD) {
      bestD = d / b.rad;
      best = b;
    }
  }
  return best;
}

function onStick(x: number, y: number): void {
  let dx = x - stickOrigin.x, dy = y - stickOrigin.y;
  const max = B * 0.75;
  const len = Math.hypot(dx, dy);
  if (len > max) {
    // drag the base along so the stick never "runs out"
    const over = len - max;
    stickOrigin.x += (dx / len) * over;
    stickOrigin.y += (dy / len) * over;
    placeBase();
    dx = x - stickOrigin.x;
    dy = y - stickOrigin.y;
  }
  knob.style.transform = `translate(${dx}px, ${dy}px)`;
  const nx = dx / max, ny = dy / max;
  let bits = 0;
  if (nx < -0.34) bits |= IN.LEFT;
  if (nx > 0.34) bits |= IN.RIGHT;
  if (ny < -0.5) bits |= settings.stickJump ? IN.UP : IN.UPMOD;
  if (ny > 0.5) bits |= IN.DOWN;
  if (bits !== stickBits) {
    stickBits = bits;
    recompute();
  }
}

export function buildTouch(onPause: () => void): void {
  root = document.getElementById('touch')!;
  root.innerHTML = `
    <div class="tzone left"></div><div class="tzone right"></div>
    <div class="tstick"><div class="tknob"></div></div>
    <button class="tpause" aria-label="Pause">❚❚</button>
    <button class="tfull" aria-label="Fullscreen">⛶</button>`;
  base = root.querySelector('.tstick') as HTMLElement;
  knob = root.querySelector('.tknob') as HTMLElement;
  btns = BTNS.map((d) => {
    const el = document.createElement('div');
    el.className = `tb tb-${d.id}`;
    el.innerHTML = `<span class="h">${d.han}</span><span class="l">${d.label}</span>`;
    root.appendChild(el);
    return { ...d, el, cx: 0, cy: 0, rad: 0 };
  });
  const left = root.querySelector('.tzone.left') as HTMLElement;
  const right = root.querySelector('.tzone.right') as HTMLElement;

  left.addEventListener('pointerdown', (e) => {
    if (stickId !== null) return;
    e.preventDefault();
    stickId = e.pointerId;
    capture(left, e.pointerId);
    stickOrigin = { x: e.clientX, y: e.clientY };
    placeBase();
    base.classList.add('live');
    onStick(e.clientX, e.clientY);
  });
  left.addEventListener('pointermove', (e) => {
    if (e.pointerId === stickId) onStick(e.clientX, e.clientY);
  });
  const endStick = (e: PointerEvent) => {
    if (e.pointerId !== stickId) return;
    stickId = null;
    stickBits = 0;
    recompute();
    restStick();
  };
  left.addEventListener('pointerup', endStick);
  left.addEventListener('pointercancel', endStick);

  right.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    capture(right, e.pointerId);
    const b = hitButton(e.clientX, e.clientY);
    fingerBtn.set(e.pointerId, b);
    if (b) vibrate(8);
    recompute();
  });
  right.addEventListener('pointermove', (e) => {
    if (!fingerBtn.has(e.pointerId)) return;
    const b = hitButton(e.clientX, e.clientY);
    if (b !== fingerBtn.get(e.pointerId)) {
      fingerBtn.set(e.pointerId, b);
      if (b) vibrate(6);
      recompute();
    }
  });
  const endBtn = (e: PointerEvent) => {
    fingerBtn.delete(e.pointerId);
    recompute();
  };
  right.addEventListener('pointerup', endBtn);
  right.addEventListener('pointercancel', endBtn);

  (root.querySelector('.tpause') as HTMLElement).addEventListener('click', onPause);
  (root.querySelector('.tfull') as HTMLElement).addEventListener('click', () => toggleFullscreen());
  window.addEventListener('resize', layoutTouch);
  window.addEventListener('orientationchange', () => setTimeout(layoutTouch, 200));
  layoutTouch();
}

export function showTouch(on: boolean): void {
  visible = on;
  document.getElementById('touch')!.classList.toggle('hidden', !on);
  document.body.classList.toggle('touch-ui', on);
  if (!on) {
    stickBits = 0;
    stickId = null;
    fingerBtn.clear();
    recompute();
  } else layoutTouch();
}

/** Called each frame with the local fighter's Qi so Art/Secret buttons show availability. */
export function updateTouch(qi: number): void {
  if (!visible) return;
  for (const b of btns) {
    if (!b.cost) continue;
    const ready = qi >= b.cost;
    b.el.classList.toggle('locked', !ready);
    b.el.classList.toggle('ready', ready);
  }
}

export function touchHaptic(kind: 'hit' | 'hurt' | 'ko'): void {
  if (!visible) return;
  vibrate(kind === 'ko' ? [30, 40, 70] : kind === 'hurt' ? 22 : 10);
}

export function isFullscreen(): boolean {
  return !!document.fullscreenElement;
}

export async function enterFullscreen(): Promise<void> {
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  try {
    if (!document.fullscreenElement) {
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
      else el.webkitRequestFullscreen?.();
    }
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    await o?.lock?.('landscape').catch(() => null);
  } catch {
    /* not supported (e.g. iPhone Safari) */
  }
}

export function toggleFullscreen(): void {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => null);
  else enterFullscreen();
}
