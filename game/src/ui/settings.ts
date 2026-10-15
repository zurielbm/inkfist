export interface Settings {
  name: string;
  shake: number;
  boil: number;
  touch: 'auto' | 'on' | 'off';
  quality: 'high' | 'low';
  showNet: boolean;
  /** touch: pushing the stick up also jumps (off = only the Jump button jumps) */
  stickJump: boolean;
  haptics: boolean;
  /** touch button scale */
  touchSize: number;
}

const KEY = 'inkfist.settings';
const DEFAULTS: Settings = { name: '', shake: 1, boil: 1, touch: 'auto', quality: 'high', showNet: true, stickJump: false, haptics: true, touchSize: 1 };

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

export const settings: Settings = load();

export function saveSettings(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

const WANDERER = ['Wandering', 'Nameless', 'Crimson', 'Silent', 'Drunken', 'Iron', 'Jade', 'Mountain', 'Cloud', 'Ink'];
const WANDERER2 = ['Blade', 'Fist', 'Crane', 'Tiger', 'Sparrow', 'Monk', 'Ghost', 'Brush', 'Wind', 'Plum'];
export function playerName(): string {
  if (!settings.name) {
    settings.name = `${WANDERER[(Math.random() * WANDERER.length) | 0]} ${WANDERER2[(Math.random() * WANDERER2.length) | 0]}`;
    saveSettings();
  }
  return settings.name;
}

export function isTouchDevice(): boolean {
  // primary pointer is a finger (phones/tablets); touch-screen laptops keep the keyboard UI unless forced on
  return window.matchMedia('(pointer: coarse)').matches;
}

export function touchEnabled(): boolean {
  if (settings.touch === 'on') return true;
  if (settings.touch === 'off') return false;
  return isTouchDevice();
}
