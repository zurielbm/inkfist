// Spatial keyboard / gamepad navigation for DOM menus. Elements with [data-nav] are focusable targets.
import { MenuKey } from '../input/input';

let active: HTMLElement | null = null;
let backHandler: (() => void) | null = null;
let enabled = true;
/** confirm/back are ignored until this time, so mashing attack keys as a screen opens can't trigger it */
let armedAt = 0;

export function navScope(root: HTMLElement | null, onBack: (() => void) | null = null, guardMs = 300): void {
  active = root;
  backHandler = onBack;
  armedAt = performance.now() + guardMs;
  if (!root) return;
  const first = (root.querySelector('[data-autofocus]') as HTMLElement) || (root.querySelector('[data-nav]') as HTMLElement);
  focusEl(first);
}

export function navEnabled(on: boolean): void {
  enabled = on;
}

function focusEl(el: HTMLElement | null): void {
  if (!el) return;
  active?.querySelectorAll('.focus').forEach((e) => e.classList.remove('focus'));
  el.classList.add('focus');
  el.focus({ preventScroll: false });
  (el as HTMLElement & { scrollIntoViewIfNeeded?: () => void }).scrollIntoViewIfNeeded?.();
}

function current(): HTMLElement | null {
  if (!active) return null;
  const f = document.activeElement as HTMLElement | null;
  if (f && active.contains(f) && f.hasAttribute('data-nav')) return f;
  return active.querySelector('.focus') as HTMLElement | null;
}

function visible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && !el.closest('.hidden');
}

export function navMove(dir: 'up' | 'down' | 'left' | 'right'): void {
  if (!active) return;
  const items = [...active.querySelectorAll('[data-nav]')].filter((e) => visible(e as HTMLElement)) as HTMLElement[];
  if (!items.length) return;
  const cur = current();
  if (!cur) {
    focusEl(items[0]);
    return;
  }
  const r = cur.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const it of items) {
    if (it === cur) continue;
    const q = it.getBoundingClientRect();
    const x = q.left + q.width / 2, y = q.top + q.height / 2;
    const dx = x - cx, dy = y - cy;
    let primary: number, secondary: number;
    if (dir === 'up') { primary = -dy; secondary = Math.abs(dx); }
    else if (dir === 'down') { primary = dy; secondary = Math.abs(dx); }
    else if (dir === 'left') { primary = -dx; secondary = Math.abs(dy); }
    else { primary = dx; secondary = Math.abs(dy); }
    if (primary <= 4) continue;
    const score = primary + secondary * 2.2;
    if (score < bestScore) {
      bestScore = score;
      best = it;
    }
  }
  if (best) focusEl(best);
}

export function navKey(k: MenuKey): void {
  if (!enabled || !active) return;
  if ((k === 'ok' || k === 'back') && performance.now() < armedAt) return;
  if (k === 'ok') {
    const c = current();
    c?.click();
  } else if (k === 'back') {
    backHandler?.();
  } else navMove(k);
}

export function installNavKeys(): void {
  window.addEventListener('keydown', (e) => {
    if (!enabled || !active) return;
    const t = e.target as HTMLElement;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    const map: Record<string, MenuKey> = {
      ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
      Enter: 'ok', Escape: 'back',
    };
    const alt: Record<string, MenuKey> = {
      KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right', KeyJ: 'ok', Space: 'ok', KeyK: 'back', Backspace: 'back',
      KeyZ: 'ok', KeyX: 'back',
    };
    let k = map[e.code];
    if (!k && !typing) k = alt[e.code];
    if (!k) return;
    if (e.repeat && (k === 'ok' || k === 'back')) return;
    if (typing && (k === 'left' || k === 'right')) return;
    e.preventDefault();
    navKey(k);
  });
  window.addEventListener('mousemove', (e) => {
    const t = (e.target as HTMLElement)?.closest?.('[data-nav]') as HTMLElement | null;
    if (t && active?.contains(t) && !t.classList.contains('focus')) focusEl(t);
  });
}
