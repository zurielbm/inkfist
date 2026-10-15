import { IN } from '../sim/defs';

export interface InputSource {
  read(): number;
}

type KeyMap = Record<string, number>;

export const P1_KEYS: KeyMap = {
  KeyW: IN.UP, Space: IN.UP, KeyS: IN.DOWN, KeyA: IN.LEFT, KeyD: IN.RIGHT,
  KeyJ: IN.S, KeyK: IN.H, KeyL: IN.G, KeyU: IN.D, ShiftLeft: IN.D, KeyI: IN.A, KeyO: IN.X,
};

/** Solo play also accepts the "arrows" layout: right hand moves with the arrow keys, left hand fights with Z X C V B N. */
export const P1_SOLO_EXTRA: KeyMap = {
  ArrowUp: IN.UP, ArrowDown: IN.DOWN, ArrowLeft: IN.LEFT, ArrowRight: IN.RIGHT,
  KeyZ: IN.S, KeyX: IN.H, KeyC: IN.G, KeyV: IN.D, KeyB: IN.A, KeyN: IN.X,
};

export const P2_KEYS: KeyMap = {
  ArrowUp: IN.UP, ArrowDown: IN.DOWN, ArrowLeft: IN.LEFT, ArrowRight: IN.RIGHT,
  Numpad1: IN.S, Numpad2: IN.H, Numpad3: IN.G, Numpad4: IN.D, Numpad5: IN.A, Numpad6: IN.X,
  Comma: IN.S, Period: IN.H, Slash: IN.G, ShiftRight: IN.D, Semicolon: IN.A, Quote: IN.X,
};

const held = new Set<string>();
let installed = false;

/** Which keyboard layout the player is using (drives the on-screen key hints). */
export type KeyScheme = 'wasd' | 'arrows';
const ARROW_CODES = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN']);
const WASD_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyJ', 'KeyK', 'KeyL', 'KeyU', 'KeyI', 'KeyO']);
let scheme: KeyScheme = (() => {
  try {
    return localStorage.getItem('inkfist.keys') === 'arrows' ? 'arrows' : 'wasd';
  } catch {
    return 'wasd';
  }
})();
const schemeListeners = new Set<(s: KeyScheme) => void>();
export function keyScheme(): KeyScheme {
  return scheme;
}
export function onKeyScheme(fn: (s: KeyScheme) => void): void {
  schemeListeners.add(fn);
}
function noteScheme(code: string): void {
  const next: KeyScheme | null = ARROW_CODES.has(code) ? 'arrows' : WASD_CODES.has(code) ? 'wasd' : null;
  if (!next || next === scheme) return;
  scheme = next;
  try {
    localStorage.setItem('inkfist.keys', scheme);
  } catch {
    /* ignore */
  }
  for (const fn of schemeListeners) fn(scheme);
}

export function installKeyboard(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    held.add(e.code);
    noteScheme(e.code);
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => held.delete(e.code));
  window.addEventListener('blur', () => held.clear());
}

export class KeyboardInput implements InputSource {
  constructor(private map: KeyMap) {}
  read(): number {
    let b = 0;
    for (const [code, bit] of Object.entries(this.map)) if (held.has(code)) b |= bit;
    return b;
  }
}

/** Standard-mapping gamepad. A jump, X strike, Y heavy, B dodge, RB guard, LB art, RT secret. */
export class GamepadInput implements InputSource {
  constructor(public index: number) {}
  read(): number {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const p = pads[this.index];
    if (!p) return 0;
    const btn = (i: number) => !!p.buttons[i] && (p.buttons[i].pressed || p.buttons[i].value > 0.5);
    let b = 0;
    const ax = p.axes[0] ?? 0;
    const ay = p.axes[1] ?? 0;
    if (ax < -0.4 || btn(14)) b |= IN.LEFT;
    if (ax > 0.4 || btn(15)) b |= IN.RIGHT;
    if (ay < -0.55 || btn(12) || btn(0)) b |= IN.UP;
    if (ay > 0.55 || btn(13)) b |= IN.DOWN;
    if (btn(2)) b |= IN.S;
    if (btn(3)) b |= IN.H;
    if (btn(5) || btn(6)) b |= IN.G;
    if (btn(1)) b |= IN.D;
    if (btn(4)) b |= IN.A;
    if (btn(7)) b |= IN.X;
    return b;
  }
  static connected(index: number): boolean {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    return !!pads[index];
  }
}

export class MergedInput implements InputSource {
  constructor(private sources: InputSource[]) {}
  read(): number {
    let b = 0;
    for (const s of this.sources) b |= s.read();
    return b;
  }
}

/** Shared bits written by the touch overlay. */
export const touchState = { bits: 0 };
export class TouchInput implements InputSource {
  read(): number {
    return touchState.bits;
  }
}

/** Menu navigation helpers (edge-detected, keyboard + gamepad). */
export type MenuKey = 'up' | 'down' | 'left' | 'right' | 'ok' | 'back';
let prevPad = 0;
export function pollMenuPad(): MenuKey[] {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let bits = 0;
  for (const p of pads) {
    if (!p) continue;
    const btn = (i: number) => !!p.buttons[i]?.pressed;
    if ((p.axes[1] ?? 0) < -0.6 || btn(12)) bits |= 1;
    if ((p.axes[1] ?? 0) > 0.6 || btn(13)) bits |= 2;
    if ((p.axes[0] ?? 0) < -0.6 || btn(14)) bits |= 4;
    if ((p.axes[0] ?? 0) > 0.6 || btn(15)) bits |= 8;
    if (btn(0)) bits |= 16;
    if (btn(1)) bits |= 32;
  }
  const press = bits & ~prevPad;
  prevPad = bits;
  const out: MenuKey[] = [];
  if (press & 1) out.push('up');
  if (press & 2) out.push('down');
  if (press & 4) out.push('left');
  if (press & 8) out.push('right');
  if (press & 16) out.push('ok');
  if (press & 32) out.push('back');
  return out;
}
